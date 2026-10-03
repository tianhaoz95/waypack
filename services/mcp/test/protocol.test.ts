import { describe, expect, it } from "vitest";
import { handleMcpRequest, ToolError, type ToolDef } from "../src/mcp/protocol.js";
import { signPath, verifySignedPath } from "../src/lib/crypto.js";

const tools: ToolDef<{ n: number }>[] = [
  { name: "echo", description: "echo", inputSchema: { type: "object" }, run: async (a, c) => ({ text: `${a.x}:${c.n}`, structured: { x: a.x } }) },
  { name: "fail", description: "fail", inputSchema: { type: "object" }, run: async () => { throw new ToolError("nope — call geocode"); } },
];
const call = (body: unknown, method = "POST") =>
  handleMcpRequest(new Request("http://x/mcp", { method, body: method === "POST" ? JSON.stringify(body) : undefined, headers: { "Content-Type": "application/json" } }), {
    name: "t", version: "1", instructions: "i", tools, ctx: { n: 7 },
  });

describe("MCP protocol", () => {
  it("negotiates protocol version", async () => {
    const r = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
    expect(r.result.protocolVersion).toBe("2025-03-26");
    const r2 = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json();
    expect(r2.result.protocolVersion).toBe("2025-11-25");
  });
  it("accepts notifications with 202", async () => {
    expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });
  it("lists and calls tools", async () => {
    const l = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(l.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "fail"]);
    const c = await (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { x: "hi" } } })).json();
    expect(c.result).toEqual({ content: [{ type: "text", text: "hi:7" }], structuredContent: { x: "hi" }, isError: false });
  });
  it("reports tool errors in-band", async () => {
    const c = await (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fail" } })).json();
    expect(c.result.isError).toBe(true);
    expect(c.result.content[0].text).toMatch(/call geocode/);
  });
  it("handles batches, unknown methods and parse errors", async () => {
    const b = await (await call([{ jsonrpc: "2.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: 6, method: "nope" }])).json();
    expect(b[0].result).toEqual({});
    expect(b[1].error.code).toBe(-32601);
    const bad = await handleMcpRequest(new Request("http://x/mcp", { method: "POST", body: "{" }), { name: "t", version: "1", instructions: "", tools, ctx: { n: 1 } });
    expect(bad.status).toBe(400);
    expect((await call(null, "GET")).status).toBe(405);
  });
});

describe("signed paths", () => {
  it("verifies and expires", async () => {
    const p = await signPath("secret", "/files/a.zip", 60, 1_000_000);
    expect(await verifySignedPath("secret", new URL(`http://x${p}`), 1_000_000)).toBe(true);
    expect(await verifySignedPath("other", new URL(`http://x${p}`), 1_000_000)).toBe(false);
    expect(await verifySignedPath("secret", new URL(`http://x${p.replace("a.zip", "b.zip")}`), 1_000_000)).toBe(false);
    expect(await verifySignedPath("secret", new URL(`http://x${p}`), 1_000_000 + 61_000)).toBe(false);
  });
});
