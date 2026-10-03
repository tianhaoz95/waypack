import { b64url, hmac, hmacVerify, unb64url } from "../lib/crypto.js";

const COOKIE = "wp_session";
const MAX_AGE = 30 * 86400;

export interface Session { uid: string; email?: string; exp: number }

export async function makeSessionCookie(secret: string, uid: string, email: string | undefined, secure: boolean): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ uid, email, exp: Math.floor(Date.now() / 1000) + MAX_AGE })));
  const sig = await hmac(secret, `session.${payload}`);
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`;
}

export async function readSession(secret: string, req: Request): Promise<Session | null> {
  const raw = req.headers.get("Cookie")?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !(await hmacVerify(secret, `session.${payload}`, sig))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64url(payload))) as Session;
    return s.exp * 1000 > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export const clearSessionCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
