/**
 * Sign-in with Google or Apple (via Supabase Auth, PKCE) for the web portal and the MCP
 * authorize page. Users never type an email or a code.
 *
 *   /auth/start?provider=google&return=/account      (portal)
 *   POST /authorize  step=oauth provider=apple       (MCP consent page → startOAuth)
 *   /auth/callback?code=…                             (Supabase redirects back here)
 */
import type { Env } from "../env.js";
import { b64url, randomToken } from "../lib/crypto.js";
import { makeSessionCookie } from "./session.js";

export type Provider = "google" | "apple";
export const PROVIDERS: Provider[] = ["google", "apple"];
export const isProvider = (p: unknown): p is Provider => p === "google" || p === "apple";

export interface PendingLogin {
  purpose: "portal" | "mcp";
  provider: Provider;
  verifier: string;
  /** portal: where to go after sign-in (same-origin path) */
  returnTo?: string;
  /** mcp: the consent handle + display details to finish the OAuth grant */
  handle?: string;
  created: number;
}

const STATE_COOKIE = "wp_oauth";
const TTL = 600;

export const callbackUrl = (env: Env) => `${env.PUBLIC_URL}/auth/callback`;

/** Only same-origin absolute paths (no `//host`, no schemes). */
export function safeReturnPath(p: string | null | undefined): string {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return "/account";
  return p;
}

async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Redirects the browser to Google/Apple via Supabase, remembering what to do afterwards. */
export async function startOAuth(env: Env, req: Request, pending: Omit<PendingLogin, "verifier" | "created">, extraHeaders?: Headers): Promise<Response> {
  const verifier = randomToken(48);
  const state = randomToken(18);
  const record: PendingLogin = { ...pending, verifier, created: Date.now() };
  await env.CACHE_KV.put(`oauth:${state}`, JSON.stringify(record), { expirationTtl: TTL });

  const u = new URL(`${env.SUPABASE_URL}/auth/v1/authorize`);
  u.searchParams.set("provider", pending.provider);
  u.searchParams.set("redirect_to", callbackUrl(env));
  u.searchParams.set("code_challenge", await challengeFor(verifier));
  u.searchParams.set("code_challenge_method", "s256");
  if (pending.provider === "google") u.searchParams.set("scopes", "email profile");

  const headers = extraHeaders ?? new Headers();
  const secure = new URL(req.url).protocol === "https:";
  // Binds the login to this browser (login-CSRF protection): the callback must carry it.
  headers.append("Set-Cookie", `${STATE_COOKIE}=${state}; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${TTL}${secure ? "; Secure" : ""}`);
  headers.set("Location", u.toString());
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}

export interface CallbackResult { userId: string; email?: string; pending: PendingLogin; headers: Headers }

export class OAuthCallbackError extends Error {}

/** Validates the callback, exchanges the PKCE code with Supabase, and sets the session cookie. */
export async function finishOAuth(env: Env, req: Request, fetcher: typeof fetch = (i, n) => fetch(i, n)): Promise<CallbackResult> {
  const url = new URL(req.url);
  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) throw new OAuthCallbackError(providerError.replace(/\+/g, " "));
  const code = url.searchParams.get("code");
  const state = req.headers.get("Cookie")?.split(/;\s*/).find((c) => c.startsWith(`${STATE_COOKIE}=`))?.slice(STATE_COOKIE.length + 1);
  if (!code || !state) throw new OAuthCallbackError("This sign-in link is incomplete or was opened in a different browser. Please try again.");
  const pending = await env.CACHE_KV.get<PendingLogin>(`oauth:${state}`, "json");
  if (!pending) throw new OAuthCallbackError("This sign-in expired. Please try again.");
  await env.CACHE_KV.delete(`oauth:${state}`);

  const res = await fetcher(`${env.SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ auth_code: code, code_verifier: pending.verifier }),
  });
  if (!res.ok) throw new OAuthCallbackError(`Sign-in failed (${res.status}). Please try again.`);
  const j = (await res.json()) as { user?: { id: string; email?: string } };
  if (!j.user?.id) throw new OAuthCallbackError("Sign-in failed. Please try again.");

  const headers = new Headers();
  headers.append("Set-Cookie", await makeSessionCookie(env.SIGNING_SECRET, j.user.id, j.user.email, url.protocol === "https:"));
  headers.append("Set-Cookie", `${STATE_COOKIE}=; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=0`);
  return { userId: j.user.id, email: j.user.email, pending, headers };
}

// ---------- dev-only sign-in (local development + automated tests) ----------

/** True only for a local development server; never in production. */
export function devSignInAllowed(env: Env): boolean {
  if (env.ENVIRONMENT !== "development") return false;
  const host = new URL(env.PUBLIC_URL).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

/**
 * Creates (if needed) and signs in a user by email using the Supabase admin API.
 * Returns a real Supabase session so the mobile app can use it too.
 */
export async function devSession(env: Env, email: string): Promise<{ userId: string; email: string; access_token: string; refresh_token: string }> {
  const admin = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
  const link = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, { method: "POST", headers: admin, body: JSON.stringify({ type: "magiclink", email }) });
  if (!link.ok) throw new Error(`dev sign-in: generate_link ${link.status} ${await link.text()}`);
  const l = (await link.json()) as { hashed_token?: string; verification_type?: string; properties?: { hashed_token?: string; verification_type?: string } };
  const tokenHash = l.hashed_token ?? l.properties?.hashed_token;
  // New users get a "signup" token, existing users a "magiclink" token.
  const type = l.verification_type ?? l.properties?.verification_type ?? "magiclink";
  const v = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ type, token_hash: tokenHash }),
  });
  if (!v.ok) throw new Error(`dev sign-in: verify ${v.status} ${await v.text()}`);
  const s = (await v.json()) as { access_token: string; refresh_token: string; user: { id: string; email: string } };
  return { userId: s.user.id, email: s.user.email, access_token: s.access_token, refresh_token: s.refresh_token };
}
