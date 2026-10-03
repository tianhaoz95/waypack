/**
 * Minimal stateless MCP server over Streamable HTTP (JSON responses).
 * Spec: POST JSON-RPC messages to the endpoint; servers MAY answer with
 * `application/json` instead of an SSE stream, which is all a tools-only
 * server needs. No sessions, so it scales horizontally on Workers.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface ToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef<Ctx> {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult>;
}

interface JsonRpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> }

const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export class ToolError extends Error {}

export async function handleMcpRequest<Ctx>(
  req: Request,
  opts: { name: string; version: string; instructions: string; tools: ToolDef<Ctx>[]; ctx: Ctx },
): Promise<Response> {
  if (req.method === "GET" || req.method === "DELETE") {
    // No server-initiated stream / sessions in this stateless server.
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as JsonRpcRequest[];
  const out: unknown[] = [];
  for (const m of msgs) {
    const r = await dispatch(m, opts);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0], { headers: { "Cache-Control": "no-store" } });
}

async function dispatch<Ctx>(m: JsonRpcRequest, opts: Parameters<typeof handleMcpRequest<Ctx>>[1]) {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(m?.id, -32600, "Invalid Request");
  const isNotification = m.id === undefined;
  if (isNotification) return null; // notifications/initialized, cancelled, etc.
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });

  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: opts.name, title: "Waypack", version: opts.version },
        instructions: opts.instructions,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: opts.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      const tool = opts.tools.find((t) => t.name === name);
      if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${name}`);
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const r = await tool.run(args, opts.ctx);
        return ok({ content: [{ type: "text", text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}), isError: !!r.isError });
      } catch (e) {
        // Tool failures are reported in-band so the agent can read and act on them.
        const msg = e instanceof ToolError ? e.message : `Internal error: ${(e as Error).message}`;
        if (!(e instanceof ToolError)) console.error(`tool ${name} failed`, e);
        return ok({ content: [{ type: "text", text: msg }], isError: true });
      }
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return rpcError(m.id, -32601, `Method not found: ${m.method}`);
  }
}
