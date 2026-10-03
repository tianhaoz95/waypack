import { Container, getContainer } from "@cloudflare/containers";
import type { Env, TileJob } from "../env.js";
import { Db, eq } from "./db.js";
import { hex } from "./crypto.js";
import { keys } from "./storage.js";
import { refreshTripStatus, type ExtractRow } from "./pipeline.js";
import { resolvePlanet } from "./planet.js";

/** Cloudflare Container running services/tiler (pmtiles extract behind a tiny HTTP API). */
export class TilerContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // rclone reads its remote from env (RCLONE_CONFIG_R2_*); only needed for /mirror.
    this.envVars = {
      MIRROR_TOKEN: env.MIRROR_TOKEN ?? "",
      RCLONE_CONFIG_R2_TYPE: "s3",
      RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID ?? "",
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY ?? "",
      RCLONE_CONFIG_R2_ENDPOINT: env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "",
    };
  }
}

export async function callTiler(env: Env, body: unknown, path: "/extract" | "/mirror" = "/extract"): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (path === "/mirror") headers.Authorization = `Bearer ${env.MIRROR_TOKEN ?? ""}`;
  const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
  if (env.TILER_URL) return fetch(`${env.TILER_URL.replace(/\/$/, "")}${path}`, init);
  if (!env.TILER) throw new Error("no tiler configured (set TILER_URL or the TILER container binding)");
  // Spread extracts over a few instances; the long-running mirror gets its own.
  const name = path === "/mirror" ? "tiler-mirror" : `tiler-${Math.floor(Math.random() * 3)}`;
  return getContainer(env.TILER as never, name).fetch(new Request(`http://tiler${path}`, init));
}

/** Queue consumer: cut one PMTiles extract and store it in R2. */
export async function runTileJob(env: Env, job: TileJob): Promise<void> {
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const ex = await db.one<ExtractRow & { trips: { user_id: string } }>("map_extracts", `select=*,trips(user_id)&id=${eq(job.extract_id)}`);
  if (!ex || ex.status === "ready" || ex.status === "expired") return;
  await db.update("map_extracts", `id=${eq(ex.id)}`, { status: "processing", attempts: ex.attempts + 1 });

  try {
    const planet = await resolvePlanet(env);
    const res = await callTiler(env, { source: planet.url, bbox: ex.bbox, maxzoom: ex.max_zoom });
    if (!res.ok || !res.body) throw new Error(`tiler ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const len = Number(res.headers.get("Content-Length"));
    if (!len) throw new Error("tiler response has no Content-Length");

    // Hash while streaming into R2.
    const [toR2, toHash] = res.body.tee();
    const digest = new crypto.DigestStream("SHA-256");
    const hashing = toHash.pipeTo(digest);
    const fixed = new FixedLengthStream(len);
    const piping = toR2.pipeTo(fixed.writable);
    const key = keys.tiles(ex.trips.user_id, ex.trip_id, ex.area_hash);
    await env.BUCKET.put(key, fixed.readable, { httpMetadata: { contentType: "application/octet-stream" } });
    await piping;
    await hashing;
    const sha = hex(await digest.digest);
    // The hash is only known after the upload finishes, so it lives in the DB (the app verifies against it).
    await db.update("map_extracts", `id=${eq(ex.id)}`, { status: "ready", tiles_key: key, tiles_bytes: len, tiles_sha256: sha, error: null });
  } catch (e) {
    const msg = (e as Error).message;
    const final = ex.attempts + 1 >= 3;
    await db.update("map_extracts", `id=${eq(ex.id)}`, { status: final ? "failed" : "pending", error: msg.slice(0, 500) });
    if (!final) throw e; // let the queue retry
  } finally {
    await refreshTripStatus(db, ex.trip_id);
  }
}

/** Daily: expire extracts 30 days after the trip ended, clean stale uploads. */
export async function runExpiry(env: Env, now = new Date()): Promise<{ expired: number; uploads: number }> {
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const due = await db.select<ExtractRow>("map_extracts", `select=id,tiles_key,trip_id&status=eq.ready&expires_at=lt.${now.toISOString()}`);
  for (const e of due) {
    if (e.tiles_key) await env.BUCKET.delete(e.tiles_key);
    await db.update("map_extracts", `id=${eq(e.id)}`, { status: "expired", tiles_key: null });
  }
  const stale = await db.select<{ id: string; object_key: string }>("uploads", `select=id,object_key&status=in.(pending,received)&expires_at=lt.${now.toISOString()}`);
  for (const u of stale) {
    await env.BUCKET.delete(u.object_key);
    await db.update("uploads", `id=${eq(u.id)}`, { status: "expired" });
  }
  return { expired: due.length, uploads: stale.length };
}

/** On-demand re-cut for an entitled user re-downloading an old trip (design §11). */
export async function recutExpired(env: Env, db: Db, tripId: string): Promise<number> {
  const expired = await db.select<ExtractRow>("map_extracts", `select=*&trip_id=${eq(tripId)}&status=eq.expired`);
  let n = 0;
  for (const e of expired) {
    await db.update("map_extracts", `id=${eq(e.id)}`, { status: "pending", attempts: 0, error: null, expires_at: new Date(Date.now() + 30 * 86400000).toISOString() });
    await env.TILE_QUEUE.send({ extract_id: e.id });
    n++;
  }
  if (n) await db.update("trips", `id=${eq(tripId)}`, { status: "processing" });
  return n;
}
