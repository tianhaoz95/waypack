const te = new TextEncoder();

export function hex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? te.encode(data) : (data as Uint8Array<ArrayBuffer>)));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmac(secret: string, msg: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), te.encode(msg));
  return b64url(new Uint8Array(sig));
}

/** Constant-time comparison via HMAC verify. */
export async function hmacVerify(secret: string, msg: string, sig: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(sig) as Uint8Array<ArrayBuffer>, te.encode(msg));
  } catch {
    return false;
  }
}

export function b64url(u: Uint8Array): string {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Signs `path` so it can be fetched without other credentials until `exp` (unix seconds). */
export async function signPath(secret: string, path: string, ttlSeconds: number, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = await hmac(secret, `${path}\n${exp}`);
  return `${path}${path.includes("?") ? "&" : "?"}exp=${exp}&sig=${sig}`;
}

export async function verifySignedPath(secret: string, url: URL, now = Date.now()): Promise<boolean> {
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!exp || exp * 1000 < now) return false;
  return hmacVerify(secret, `${url.pathname}\n${exp}`, sig);
}
