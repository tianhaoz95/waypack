import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { AuthProps, Env, TileJob } from "./env.js";
import { handleApp } from "./api.js";
import { resolveApiToken } from "./auth/tokens.js";
import { Db } from "./lib/db.js";
import { runExpiry, runTileJob } from "./lib/tiles.js";
import { handleMcpRequest } from "./mcp/protocol.js";
import { INSTRUCTIONS, tools, type ToolCtx } from "./mcp/tools.js";

export { TilerContainer } from "./lib/tiles.js";

const VERSION = "1.0.0";

const mcpHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext & { props?: AuthProps }): Promise<Response> {
    const props = ctx.props;
    if (!props?.userId) return new Response("unauthorized", { status: 401 });
    const toolCtx: ToolCtx = { env, db: new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY), userId: props.userId };
    return handleMcpRequest(req, { name: "waypack", version: VERSION, instructions: INSTRUCTIONS, tools, ctx: toolCtx });
  },
};

let provider: OAuthProvider<Env> | null = null;
let providerFor = "";

/** Built lazily because the resource URL comes from env (differs per environment). */
function getProvider(env: Env): OAuthProvider<Env> {
  if (provider && providerFor === env.PUBLIC_URL) return provider;
  const resource = `${env.PUBLIC_URL}/mcp`;
  providerFor = env.PUBLIC_URL;
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler as never,
    defaultHandler: { fetch: (req: Request, e: Env) => handleApp(req, e) } as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: ["mcp", "offline_access"],
    requiredScopes: ["mcp"],
    resourceMetadata: { resource, authorization_servers: [env.PUBLIC_URL], resource_name: "Waypack" },
    accessTokenTTL: 3600,
    refreshTokenTTL: 90 * 86400,
    // Headless fallback (design §6.1): personal API tokens from the app's Settings.
    resolveExternalToken: async ({ token, env: e }) => {
      const r = await resolveApiToken(e as Env, token);
      return r ? { props: { userId: r.userId, via: "api_token" } satisfies AuthProps, audience: resource } : null;
    },
  });
  return provider;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(req, env, ctx);
  },

  async queue(batch: MessageBatch<TileJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await runTileJob(env, msg.body);
        msg.ack();
      } catch (e) {
        console.error("tile job failed", msg.body, e);
        msg.retry({ delaySeconds: 30 });
      }
    }
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === "17 3 * * *") console.log("expiry", await runExpiry(env));
    // "0 4 2 * *": planet mirror refresh is run by the tiler (services/tiler/README.md).
  },
} satisfies ExportedHandler<Env, TileJob>;
