import type { Env } from "../env.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { Db, eq } from "../lib/db.js";

export const API_TOKEN_PREFIX = "wpk_";

/** Creates a personal API token. The plaintext is returned once; only its hash is stored. */
export async function createApiToken(db: Db, userId: string, label: string | null): Promise<{ id: string; token: string; prefix: string }> {
  const token = `${API_TOKEN_PREFIX}${randomToken(30)}`;
  const prefix = token.slice(0, 10);
  const [row] = await db.insert<{ id: string }>("api_tokens", { user_id: userId, token_hash: await sha256(token), token_prefix: prefix, label });
  return { id: row.id, token, prefix };
}

export async function resolveApiToken(env: Env, token: string): Promise<{ userId: string } | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const row = await db.one<{ id: string; user_id: string; last_used_at: string | null }>(
    "api_tokens",
    `select=id,user_id,last_used_at&token_hash=${eq(await sha256(token))}&revoked_at=is.null`,
  );
  if (!row) return null;
  // Touch at most hourly to avoid a write per request.
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 3600_000) {
    await db.update("api_tokens", `id=${eq(row.id)}`, { last_used_at: new Date().toISOString() });
  }
  return { userId: row.user_id };
}
