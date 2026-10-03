import type { Env } from "../env.js";
import { sha256 } from "../lib/crypto.js";

export interface SupaUser { id: string; email?: string }
export interface SupaSession { access_token: string; refresh_token: string; user: SupaUser }

export class AuthError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const MIN_PASSWORD = 8;
export const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function authFetch(env: Env, path: string, init: RequestInit & { bearer?: string } = {}) {
  return fetch(`${env.SUPABASE_URL}/auth/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${init.bearer ?? env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function errorOf(res: Response): Promise<{ code: string; msg: string }> {
  try {
    const j = (await res.json()) as { error_code?: string; code?: string | number; msg?: string; error_description?: string; message?: string };
    return { code: String(j.error_code ?? j.code ?? res.status), msg: j.msg ?? j.error_description ?? j.message ?? `auth error ${res.status}` };
  } catch {
    return { code: String(res.status), msg: `auth error ${res.status}` };
  }
}

function checkInput(email: string, password: string) {
  if (!validEmail(email)) throw new AuthError("Enter a valid email address.");
  if (password.length < MIN_PASSWORD) throw new AuthError(`Use a password with at least ${MIN_PASSWORD} characters.`);
}

/** Creates an account with email + password. No confirmation email is sent (confirmations are off). */
export async function signUp(env: Env, email: string, password: string): Promise<SupaSession> {
  checkInput(email, password);
  const res = await authFetch(env, "signup", { method: "POST", body: JSON.stringify({ email, password }) });
  if (!res.ok) {
    const e = await errorOf(res);
    if (e.code === "user_already_exists" || /already registered/i.test(e.msg)) throw new AuthError("An account with this email already exists. Sign in instead.", 409);
    if (e.code === "weak_password") throw new AuthError(`That password is too weak. ${e.msg}`);
    throw new AuthError(e.msg);
  }
  const j = (await res.json()) as Partial<SupaSession> & { id?: string };
  if (!j.access_token || !j.user) throw new AuthError("Account created but sign-in failed. Try signing in.", 500);
  return j as SupaSession;
}

/** Email + password sign-in, with a per-account lockout after repeated failures. */
export async function signIn(env: Env, email: string, password: string): Promise<SupaSession> {
  if (!validEmail(email) || !password) throw new AuthError("Enter your email and password.");
  const key = `login-fail:${(await sha256(email)).slice(0, 32)}`;
  const fails = Number((await env.CACHE_KV.get(key)) ?? 0);
  if (fails >= 10) throw new AuthError("Too many failed attempts. Wait 15 minutes or reset your password.", 429);
  const res = await authFetch(env, "token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
  if (!res.ok) {
    const e = await errorOf(res);
    if (res.status === 400 || e.code === "invalid_credentials") {
      await env.CACHE_KV.put(key, String(fails + 1), { expirationTtl: 900 });
      throw new AuthError("Wrong email or password.", 401);
    }
    throw new AuthError(e.msg, res.status);
  }
  if (fails) await env.CACHE_KV.delete(key);
  return (await res.json()) as SupaSession;
}

/** Sends the 6-digit reset code. Always succeeds from the caller's view (doesn't reveal accounts). */
export async function requestPasswordReset(env: Env, email: string): Promise<void> {
  if (!validEmail(email)) throw new AuthError("Enter a valid email address.");
  const res = await authFetch(env, "recover", { method: "POST", body: JSON.stringify({ email }) });
  if (res.status === 429) throw new AuthError("Too many reset requests. Try again in a little while.", 429);
}

/** Verifies the reset code, sets the new password, and returns a fresh session. */
export async function confirmPasswordReset(env: Env, email: string, code: string, newPassword: string): Promise<SupaSession> {
  checkInput(email, newPassword);
  const v = await authFetch(env, "verify", { method: "POST", body: JSON.stringify({ type: "recovery", email, token: code.replace(/\s+/g, "") }) });
  if (!v.ok) throw new AuthError("That code is wrong or expired. Request a new one.", 400);
  const s = (await v.json()) as SupaSession;
  const u = await authFetch(env, "user", { method: "PUT", bearer: s.access_token, body: JSON.stringify({ password: newPassword }) });
  if (!u.ok) {
    const e = await errorOf(u);
    throw new AuthError(e.code === "same_password" ? "Choose a password different from your old one." : e.msg);
  }
  return s;
}

/** Validates a Supabase access token (from the mobile app) and returns its user. */
export async function userFromAccessToken(env: Env, jwt: string): Promise<SupaUser | null> {
  const res = await authFetch(env, "user", { bearer: jwt });
  if (!res.ok) return null;
  const j = (await res.json()) as { id: string; email?: string };
  return { id: j.id, email: j.email };
}
