import { describe, expect, it } from "vitest";
import { devSignInAllowed, finishOAuth, OAuthCallbackError, safeReturnPath, startOAuth, type PendingLogin } from "../src/auth/oauth.js";
import { readSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";

function kv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string, t?: string) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)!) : m.get(k)) : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}
const baseEnv = () => ({ PUBLIC_URL: "https://waypack.app", SUPABASE_URL: "https://sb.example", SUPABASE_ANON_KEY: "anon", SIGNING_SECRET: "s".repeat(40), ENVIRONMENT: "production", CACHE_KV: kv() }) as unknown as Env & { CACHE_KV: ReturnType<typeof kv> };

describe("oauth", () => {
  it("sanitizes return paths", () => {
    expect(safeReturnPath("/account?x=1")).toBe("/account?x=1");
    for (const bad of ["//evil.example", "https://evil.example", "\\\\evil", "", null, "account"]) expect(safeReturnPath(bad)).toBe("/account");
  });

  it("dev sign-in is only allowed for a local development server", () => {
    expect(devSignInAllowed({ ...baseEnv(), ENVIRONMENT: "development", PUBLIC_URL: "http://127.0.0.1:8787" } as Env)).toBe(true);
    expect(devSignInAllowed({ ...baseEnv(), ENVIRONMENT: "development", PUBLIC_URL: "https://waypack.app" } as Env)).toBe(false);
    expect(devSignInAllowed({ ...baseEnv(), ENVIRONMENT: "production", PUBLIC_URL: "http://127.0.0.1:8787" } as Env)).toBe(false);
  });

  it("start → callback: PKCE exchange, session cookie, one-time state", async () => {
    const env = baseEnv();
    const start = await startOAuth(env, new Request("https://waypack.app/auth/start"), { purpose: "portal", provider: "google", returnTo: "/account" });
    const loc = new URL(start.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://sb.example/auth/v1/authorize");
    expect(loc.searchParams.get("redirect_to")).toBe("https://waypack.app/auth/callback");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    const stateCookie = start.headers.get("Set-Cookie")!.split(";")[0];
    expect(stateCookie).toMatch(/^wp_oauth=/);
    const pending = [...env.CACHE_KV.m.values()].map((v) => JSON.parse(v) as PendingLogin)[0];

    let sent: { auth_code: string; code_verifier: string } | undefined;
    const fetcher = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ user: { id: "user-1", email: "a@gmail.com" } });
    }) as unknown as typeof fetch;
    const cbReq = new Request("https://waypack.app/auth/callback?code=xyz", { headers: { Cookie: stateCookie } });
    const r = await finishOAuth(env, cbReq, fetcher);
    expect(sent).toEqual({ auth_code: "xyz", code_verifier: pending.verifier });
    expect(r.userId).toBe("user-1");
    const session = r.headers.get("Set-Cookie")!.split(", ").find((c) => c.startsWith("wp_session="))!.split(";")[0];
    expect((await readSession(env.SIGNING_SECRET, new Request("https://x", { headers: { Cookie: session } })))?.uid).toBe("user-1");
    // State is single-use.
    await expect(finishOAuth(env, cbReq, fetcher)).rejects.toBeInstanceOf(OAuthCallbackError);
  });

  it("rejects missing state, provider errors and failed exchanges", async () => {
    const env = baseEnv();
    await expect(finishOAuth(env, new Request("https://waypack.app/auth/callback?code=x"))).rejects.toThrow(/different browser/);
    await expect(finishOAuth(env, new Request("https://waypack.app/auth/callback?error=access_denied&error_description=User+cancelled"))).rejects.toThrow(/User cancelled/);
    const start = await startOAuth(env, new Request("https://waypack.app/x"), { purpose: "portal", provider: "apple" });
    const cookie = start.headers.get("Set-Cookie")!.split(";")[0];
    const failing = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await expect(finishOAuth(env, new Request("https://waypack.app/auth/callback?code=x", { headers: { Cookie: cookie } }), failing)).rejects.toThrow(/Sign-in failed/);
  });
});
