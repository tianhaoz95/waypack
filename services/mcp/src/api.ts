import type { Env } from "./env.js";
import { handleAuthorize } from "./auth/authorize.js";
import { AuthError, confirmPasswordReset, requestPasswordReset, signIn, signUp, userFromAccessToken, type SupaSession } from "./auth/supabase.js";
import { clearSessionCookie, makeSessionCookie, readSession } from "./auth/session.js";
import { availablePlans, createCheckout, createPortal, handleStripeWebhook, stripe, StripeError, type Plan } from "./lib/stripe.js";
import { createApiToken, resolveApiToken } from "./auth/tokens.js";
import { verifySignedPath } from "./lib/crypto.js";
import { Db, eq } from "./lib/db.js";
import { LIMITS } from "@waypack/bundle-schema";
import { planFor } from "./lib/entitlements.js";
import { ensureTripExtracts, tripStatus, type ExtractRow, type TripRow } from "./lib/pipeline.js";
import { serveR2, signedFileUrl } from "./lib/storage.js";
import { recutExpired } from "./lib/tiles.js";
import { deleteTripData } from "./mcp/tools.js";
import { homePage } from "./pages.js";

const jsonErr = (status: number, error: string, extra: Record<string, unknown> = {}) => Response.json({ error, ...extra }, { status });

/** Everything that isn't /mcp or the OAuth endpoints: authorize page, uploads, file downloads, app REST API. */
export async function handleApp(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/healthz") return Response.json({ ok: true });
  if (path === "/stripe/webhook" && req.method === "POST") return handleStripeWebhook(env, req);
  if (path === "/authorize") return handleAuthorize(req, env);

  // Signed, credential-less upload of a bundle zip (from `curl -T`).
  const up = path.match(/^\/upload\/([0-9a-f-]{36})$/);
  if (up && req.method === "PUT") return handleUpload(req, env, up[1], url);

  // Signed, credential-less download with Range support (bundles, tiles).
  if (path.startsWith("/files/") && (req.method === "GET" || req.method === "HEAD")) {
    if (!(await verifySignedPath(env.SIGNING_SECRET, url))) return jsonErr(403, "link expired or invalid");
    return serveR2(env, decodeURIComponent(path.slice("/files/".length)), req);
  }

  if (path.startsWith("/api/auth/")) return handlePortalAuth(req, env, path);
  if (path.startsWith("/api/")) return handleApi(req, env, url);
  // Landing page, account portal and other static files (site/) — same origin as the API.
  if (env.ASSETS && (req.method === "GET" || req.method === "HEAD")) return env.ASSETS.fetch(req);
  if (path === "/" && req.method === "GET") return new Response(homePage(env.PUBLIC_URL), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  return jsonErr(404, "not found");
}

/** Portal sign-up / sign-in / password reset → signed HttpOnly session cookie (shared with the MCP authorize page). */
async function handlePortalAuth(req: Request, env: Env, path: string): Promise<Response> {
  if (req.method !== "POST") return jsonErr(405, "POST only");
  if (!sameOrigin(req, env)) return jsonErr(403, "cross-origin request refused");
  if (path === "/api/auth/signout") return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; code?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const withSession = async (s: SupaSession) =>
    Response.json(
      { ok: true, email: s.user.email ?? email },
      { headers: { "Set-Cookie": await makeSessionCookie(env.SIGNING_SECRET, s.user.id, s.user.email ?? email, new URL(req.url).protocol === "https:") } },
    );
  try {
    switch (path) {
      case "/api/auth/signup": return await withSession(await signUp(env, email, password));
      case "/api/auth/signin": return await withSession(await signIn(env, email, password));
      case "/api/auth/reset/request":
        await requestPasswordReset(env, email);
        return Response.json({ ok: true, message: "If an account exists for that email, we sent a 6-digit code." });
      case "/api/auth/reset/confirm": return await withSession(await confirmPasswordReset(env, email, String(body.code ?? ""), password));
    }
  } catch (e) {
    if (e instanceof AuthError) return jsonErr(e.status, e.message);
    throw e;
  }
  return jsonErr(404, "not found");
}

/**
 * CSRF guard for cookie-authenticated requests: the browser must send our custom header
 * (forces a CORS preflight we never approve) and, when present, a same-origin Origin.
 */
function sameOrigin(req: Request, env: Env): boolean {
  if (req.headers.get("X-Waypack") !== "1") return false;
  const origin = req.headers.get("Origin");
  return !origin || origin === new URL(env.PUBLIC_URL).origin || origin === new URL(req.url).origin;
}

async function handleUpload(req: Request, env: Env, id: string, url: URL): Promise<Response> {
  if (!(await verifySignedPath(env.SIGNING_SECRET, url))) return jsonErr(403, "upload link expired or invalid — call create_upload again");
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const row = await db.one<{ id: string; object_key: string; status: string; size_bytes: number }>("uploads", `select=*&id=${eq(id)}`);
  if (!row || (row.status !== "pending" && row.status !== "received")) return jsonErr(409, "upload is not open");
  const len = Number(req.headers.get("Content-Length"));
  if (!len) return jsonErr(411, "Content-Length required (use curl -T)");
  if (len > LIMITS.maxZippedBytes) return jsonErr(413, "bundle exceeds 25 MB");
  if (!req.body) return jsonErr(400, "empty body");
  await env.BUCKET.put(row.object_key, req.body, { httpMetadata: { contentType: "application/zip" } });
  await db.update("uploads", `id=${eq(id)}`, { status: "received" });
  return Response.json({ ok: true, upload_id: id, bytes: len, next: "call finalize_upload" });
}

/** Authenticates the mobile app (Supabase access token), a personal API token, or the portal session cookie. */
async function authUser(req: Request, env: Env): Promise<{ userId: string; email?: string; via: "bearer" | "cookie" } | null> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    const s = await readSession(env.SIGNING_SECRET, req);
    if (!s) return null;
    if (req.method !== "GET" && !sameOrigin(req, env)) return null;
    return { userId: s.uid, email: s.email, via: "cookie" };
  }
  if (token.startsWith("wpk_")) {
    const r = await resolveApiToken(env, token);
    return r ? { ...r, via: "bearer" } : null;
  }
  const u = await userFromAccessToken(env, token);
  return u ? { userId: u.id, email: u.email, via: "bearer" } : null;
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const user = await authUser(req, env);
  if (!user) return jsonErr(401, "sign in required");
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const path = url.pathname;
  const m = (re: RegExp) => path.match(re);

  if (path === "/api/me" && req.method === "GET") {
    const plan = await planFor(db, user.userId);
    const ent = await db.one<{ tier: string; expires_at: string | null; stripe_subscription_id: string | null; stripe_customer_id: string | null }>(
      "entitlements",
      `select=tier,expires_at,stripe_subscription_id,stripe_customer_id&user_id=${eq(user.userId)}`,
    );
    return Response.json({
      user_id: user.userId,
      email: user.email ?? null,
      plan,
      expires_at: ent?.expires_at ?? null,
      billing: { configured: !!env.STRIPE_SECRET_KEY, plans: availablePlans(env), has_customer: !!ent?.stripe_customer_id, has_subscription: !!ent?.stripe_subscription_id },
      mcp_url: `${env.PUBLIC_URL}/mcp`,
      account_url: `${env.PUBLIC_URL}/account`,
    });
  }

  if (path === "/api/billing/checkout" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { plan?: Plan };
    try {
      return Response.json({ url: await createCheckout(env, db, user, body.plan === "lifetime" ? "lifetime" : "annual") });
    } catch (e) {
      return jsonErr(e instanceof StripeError ? e.status : 500, (e as Error).message);
    }
  }
  if (path === "/api/billing/portal" && req.method === "POST") {
    try {
      return Response.json({ url: await createPortal(env, db, user) });
    } catch (e) {
      return jsonErr(e instanceof StripeError ? e.status : 500, (e as Error).message);
    }
  }

  if (path === "/api/trips" && req.method === "GET") {
    const trips = await db.select<TripRow>("trips", `select=id,title,start_date,end_date,current_version,status,updated_at&user_id=${eq(user.userId)}&deleted_at=is.null&order=start_date.desc.nullslast`);
    const out = await Promise.all(trips.map((t) => tripStatus(db, user.userId, t.id).then((s) => ({ ...t, sizes: s?.sizes, tiles_status: s?.tiles_status }))));
    return Response.json({ trips: out });
  }

  let r = m(/^\/api\/trips\/([0-9a-f-]{36})\/download$/);
  if (r && req.method === "GET") return downloadInfo(env, db, user.userId, r[1]);

  r = m(/^\/api\/trips\/([0-9a-f-]{36})$/);
  if (r && req.method === "DELETE") {
    const t = await db.one<TripRow>("trips", `select=id&id=${eq(r[1])}&user_id=${eq(user.userId)}&deleted_at=is.null`);
    if (!t) return jsonErr(404, "trip not found");
    await deleteTripData(env, db, user.userId, t.id);
    return Response.json({ ok: true });
  }

  if (path === "/api/tokens" && req.method === "GET") {
    const tokens = await db.select("api_tokens", `select=id,label,token_prefix,created_at,last_used_at&user_id=${eq(user.userId)}&revoked_at=is.null&order=created_at.desc`);
    return Response.json({ tokens });
  }
  if (path === "/api/tokens" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { label?: string };
    const t = await createApiToken(db, user.userId, body.label?.slice(0, 60) ?? null);
    return Response.json({ ...t, note: "Shown once. Use as `Authorization: Bearer <token>` for headless MCP clients." }, { status: 201 });
  }
  r = m(/^\/api\/tokens\/([0-9a-f-]{36})$/);
  if (r && req.method === "DELETE") {
    await db.update("api_tokens", `id=${eq(r[1])}&user_id=${eq(user.userId)}`, { revoked_at: new Date().toISOString() });
    return Response.json({ ok: true });
  }

  if (path === "/api/account" && req.method === "DELETE") {
    // Design §12: account deletion removes DB rows and R2 objects. Cancel any subscription first.
    const ent = await db.one<{ stripe_subscription_id: string | null }>("entitlements", `select=stripe_subscription_id&user_id=${eq(user.userId)}`);
    if (ent?.stripe_subscription_id && env.STRIPE_SECRET_KEY) {
      await stripe(env, "POST", `subscriptions/${ent.stripe_subscription_id}/cancel`, {}).catch(() => undefined);
    }
    for (const prefix of [`bundles/${user.userId}/`, `tiles/${user.userId}/`, `uploads/${user.userId}/`]) {
      let cursor: string | undefined;
      do {
        const list = await env.BUCKET.list({ prefix, cursor });
        if (list.objects.length) await env.BUCKET.delete(list.objects.map((o) => o.key));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    }
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.userId}`, {
      method: "DELETE",
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) return jsonErr(500, "could not delete account; contact support");
    return Response.json({ ok: true }, { headers: user.via === "cookie" ? { "Set-Cookie": clearSessionCookie() } : {} });
  }

  return jsonErr(404, "not found");
}

async function downloadInfo(env: Env, db: Db, userId: string, tripId: string): Promise<Response> {
  const t = await db.one<TripRow>("trips", `select=*&id=${eq(tripId)}&user_id=${eq(userId)}&deleted_at=is.null`);
  if (!t) return jsonErr(404, "trip not found");
  const v = await db.one<{ version: number; bundle_key: string; bundle_sha256: string; bundle_bytes: number; manifest: Record<string, unknown> }>(
    "trip_versions",
    `select=version,bundle_key,bundle_sha256,bundle_bytes,manifest&trip_id=${eq(tripId)}&version=${eq(t.current_version)}`,
  );
  if (!v) return jsonErr(409, "trip has no published version yet");
  const plan = await planFor(db, userId);
  let extracts = await db.select<ExtractRow>("map_extracts", `select=*&trip_id=${eq(tripId)}&status=in.(pending,processing,ready,failed,expired)&order=area_index`);
  if (plan.offlineMaps && !extracts.length) {
    // Published on the free plan, upgraded since: cut the map now.
    await ensureTripExtracts(env, db, userId, tripId);
    extracts = await db.select<ExtractRow>("map_extracts", `select=*&trip_id=${eq(tripId)}&status=in.(pending,processing,ready,failed)&order=area_index`);
  }
  if (plan.offlineMaps && extracts.some((e) => e.status === "expired")) {
    await recutExpired(env, db, tripId);
    extracts = await db.select<ExtractRow>("map_extracts", `select=*&trip_id=${eq(tripId)}&status=in.(pending,processing,ready,failed)&order=area_index`);
  }
  const ready = extracts.filter((e) => e.status === "ready" && e.tiles_key);
  const tiles = await Promise.all(
    ready.map(async (e) => ({
      id: e.id,
      area_index: e.area_index,
      area_hash: e.area_hash,
      url: await signedFileUrl(env, e.tiles_key!, 6 * 3600),
      sha256: e.tiles_sha256,
      bytes: e.tiles_bytes,
      bbox: e.bbox,
      max_zoom: e.max_zoom,
    })),
  );
  const tiles_status = !extracts.length ? "not_included" : extracts.some((e) => e.status === "pending" || e.status === "processing") ? "processing" : extracts.some((e) => e.status === "failed") ? "failed" : "ready";
  return Response.json({
    trip_id: t.id,
    title: t.title,
    start_date: t.start_date,
    end_date: t.end_date,
    version: v.version,
    status: t.status,
    bundle: { url: await signedFileUrl(env, v.bundle_key, 6 * 3600), sha256: v.bundle_sha256, bytes: v.bundle_bytes },
    tiles,
    tiles_status,
    online_tiles_url: env.ONLINE_TILES_URL || null,
    manifest: v.manifest,
    expires_in: 6 * 3600,
  });
}
