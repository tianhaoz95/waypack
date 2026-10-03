import type { Env } from "../env.js";

export interface SupaUser { id: string; email?: string }

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

/** Emails a 6-digit sign-in code (creates the account on first use). */
export async function sendOtp(env: Env, email: string): Promise<void> {
  const res = await authFetch(env, "otp", { method: "POST", body: JSON.stringify({ email, create_user: true }) });
  if (!res.ok) throw new Error(await errorText(res));
}

export async function verifyOtp(env: Env, email: string, token: string): Promise<SupaUser> {
  const res = await authFetch(env, "verify", { method: "POST", body: JSON.stringify({ type: "email", email, token }) });
  if (!res.ok) throw new Error(await errorText(res));
  const j = (await res.json()) as { user: { id: string; email?: string } };
  return { id: j.user.id, email: j.user.email };
}

/** Validates a Supabase access token (from the mobile app) and returns its user. */
export async function userFromAccessToken(env: Env, jwt: string): Promise<SupaUser | null> {
  const res = await authFetch(env, "user", { bearer: jwt });
  if (!res.ok) return null;
  const j = (await res.json()) as { id: string; email?: string };
  return { id: j.id, email: j.email };
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { msg?: string; error_description?: string; message?: string };
    return j.msg ?? j.error_description ?? j.message ?? `auth error ${res.status}`;
  } catch {
    return `auth error ${res.status}`;
  }
}
