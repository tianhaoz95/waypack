// Public, remixable trips (DECISIONS #44). A share is a frozen, redacted snapshot of a published
// version, served read-only on the preview origin at /t/<token>/ (same isolation as previews).
// Viewers get a "Plan this trip" button that leads to /remix/<token> on the main site, which
// hands their own agent the link; the agent reads the plan with get_shared_trip.
import { unzipBundle, type BundleFile, type Manifest } from "@waypack/bundle-schema";
import type { Env } from "../env.js";
import { randomToken, sha256 } from "./crypto.js";
import { Db, eq } from "./db.js";
import { contentTypeFor, previewOrigin, type PreviewFileRef } from "./previews.js";

export const MAX_LIVE_SHARES = 25;

export interface ShareRow {
  id: string;
  user_id: string;
  trip_id: string;
  version: number;
  token: string;
  title: string | null;
  summary: string | null;
  start_date: string | null;
  end_date: string | null;
  files: Record<string, PreviewFileRef>;
  bytes: number;
  redactions: number;
  remix_count: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export class ShareError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const shareKeys = {
  prefix: (userId: string, shareId: string) => `shares/${userId}/${shareId}/`,
  blob: (userId: string, shareId: string, sha: string) => `shares/${userId}/${shareId}/blobs/${sha}`,
};

const COLS = "id,user_id,trip_id,version,token,title,summary,start_date,end_date,files,bytes,redactions,remix_count,created_at,updated_at,revoked_at";
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function shareLinks(env: Env, token: string): { share_url: string; remix_url: string } {
  const origin = previewOrigin(env);
  if (!origin) throw new ShareError("Sharing isn't configured on this server (PREVIEW_URL).", 503);
  return { share_url: `${origin}/t/${token}/`, remix_url: `${env.PUBLIC_URL}/remix/${token}` };
}

// ------------------------------------------------------------------ redaction

/**
 * Masks booking references ("Confirmation #ABC123", "Reservation no. 55-1234", "PNR: QX7T2L").
 * A safety net, not a guarantee: names, private phone numbers or notes can still identify people,
 * which is why sharing always asks the owner first.
 */
const BOOKING_RE =
  /\b(confirmation|confirm|conf|booking|reservation|res|record locator|locator|pnr|itinerary|ticket|order)(\s*(?:number|no\.?|num|code|id|ref(?:erence)?|#))?(\s*[:#.]?\s*)(#?)([A-Z0-9][A-Z0-9-]{3,})/gi;

export function redactText(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(BOOKING_RE, (m, label: string, kind: string | undefined, sep: string, hash: string, code: string) => {
    // Plain words after "booking"/"reservation" ("Reservation recommended") aren't codes.
    if (!/\d/.test(code)) return m;
    count++;
    return `${label}${kind ?? ""}${sep}${hash}••••`;
  });
  return { text: out, count };
}

const TEXTY = /\.(html?|json|txt|md|js|mjs|css|svg|geojson)$/i;

/** Redacts every text file; the shared manifest also drops its trip_id. */
export function redactBundle(files: BundleFile[]): { files: BundleFile[]; count: number } {
  let count = 0;
  const out = files.map((f) => {
    if (!TEXTY.test(f.path)) return f;
    let text = new TextDecoder().decode(f.data);
    if (f.path === "manifest.json") {
      try {
        const m = JSON.parse(text) as Manifest;
        m.trip_id = null;
        text = JSON.stringify(m, null, 2);
      } catch {
        /* leave as-is; it'll still be redacted as text */
      }
    }
    const r = redactText(text);
    count += r.count;
    return { path: f.path, data: new TextEncoder().encode(r.text) };
  });
  return { files: out, count };
}

// ------------------------------------------------------------------ share / unshare

async function currentBundle(env: Env, db: Db, userId: string, tripId: string) {
  if (!uuidRe.test(tripId)) throw new ShareError("`trip_id` must be a UUID (from list_trips).");
  const trip = await db.one<{ id: string; current_version: number }>("trips", `select=id,current_version&id=${eq(tripId)}&user_id=${eq(userId)}&deleted_at=is.null`);
  if (!trip || trip.current_version < 1) throw new ShareError(`Trip ${tripId} not found in your account (only published trips can be shared).`, 404);
  const v = await db.one<{ bundle_key: string; manifest: Manifest }>("trip_versions", `select=bundle_key,manifest&trip_id=${eq(tripId)}&version=${eq(trip.current_version)}`);
  if (!v) throw new ShareError("This trip has no published version yet.", 404);
  return { version: trip.current_version, bundleKey: v.bundle_key, manifest: v.manifest };
}

export interface ShareResult {
  share_id: string;
  trip_id: string;
  version: number;
  share_url: string;
  remix_url: string;
  redactions: number;
  remix_count: number;
  title: string | null;
}

/**
 * Shares the trip's current version (or `files`, e.g. a copy the agent cleaned of personal details).
 * Sharing again updates the same link.
 */
export async function shareTrip(env: Env, db: Db, userId: string, tripId: string, files?: BundleFile[]): Promise<ShareResult> {
  shareLinks(env, "x".repeat(32)); // fail fast if not configured
  const cur = await currentBundle(env, db, userId, tripId);
  let source = files;
  if (!source) {
    const obj = await env.BUCKET.get(cur.bundleKey);
    if (!obj) throw new ShareError("The published bundle is missing; publish the trip again.", 500);
    const u = unzipBundle(new Uint8Array(await obj.arrayBuffer()));
    if (u.errors.length) throw new ShareError(`The published bundle couldn't be read: ${u.errors[0].message}`, 500);
    source = u.files;
  }
  if (!source.some((f) => f.path === "index.html")) throw new ShareError("A shared trip needs an index.html.");
  const { files: clean, count } = redactBundle(source);

  let row = await db.one<ShareRow>("trip_shares", `select=${COLS}&trip_id=${eq(tripId)}&user_id=${eq(userId)}&revoked_at=is.null`);
  if (!row) {
    const live = await db.count("trip_shares", `user_id=${eq(userId)}&revoked_at=is.null`);
    if (live >= MAX_LIVE_SHARES) throw new ShareError(`You're sharing ${live} trips (max ${MAX_LIVE_SHARES}). Stop sharing one first.`, 429);
    [row] = await db.insert<ShareRow>("trip_shares", { user_id: userId, trip_id: tripId, version: cur.version, token: randomToken(24) });
  }

  const map: Record<string, PreviewFileRef> = {};
  await Promise.all(
    clean.map(async (f) => {
      const ref = { sha256: await sha256(f.data), bytes: f.data.byteLength, type: contentTypeFor(f.path) };
      map[f.path] = ref;
      await env.BUCKET.put(shareKeys.blob(userId, row!.id, ref.sha256), f.data, { httpMetadata: { contentType: ref.type } });
    }),
  );
  const m = cur.manifest;
  const [saved] = await db.update<ShareRow>("trip_shares", `id=${eq(row.id)}`, {
    files: map,
    version: cur.version,
    bytes: Object.values(map).reduce((s, f) => s + f.bytes, 0),
    redactions: count,
    title: m.title,
    summary: redactText(String(m.summary ?? "")).text.slice(0, 500) || null,
    start_date: m.start_date ?? null,
    end_date: m.end_date ?? null,
    updated_at: new Date().toISOString(),
  });
  // Drop blobs the new snapshot doesn't use.
  const keep = new Set(Object.values(map).map((f) => shareKeys.blob(userId, saved.id, f.sha256)));
  const list = await env.BUCKET.list({ prefix: `${shareKeys.prefix(userId, saved.id)}blobs/` });
  const drop = list.objects.map((o) => o.key).filter((k) => !keep.has(k));
  if (drop.length) await env.BUCKET.delete(drop);

  return { share_id: saved.id, trip_id: tripId, version: saved.version, redactions: count, remix_count: saved.remix_count, title: saved.title, ...shareLinks(env, saved.token) };
}

/** Stops sharing (the link dies) and deletes the snapshot. No-op if the trip isn't shared. */
export async function unshareTrip(env: Env, db: Db, userId: string, tripId: string): Promise<boolean> {
  const rows = await db.select<ShareRow>("trip_shares", `select=${COLS}&trip_id=${eq(tripId)}&user_id=${eq(userId)}&revoked_at=is.null`);
  for (const row of rows) {
    const list = await env.BUCKET.list({ prefix: shareKeys.prefix(userId, row.id) });
    if (list.objects.length) await env.BUCKET.delete(list.objects.map((o) => o.key));
    await db.update("trip_shares", `id=${eq(row.id)}`, { revoked_at: new Date().toISOString(), files: {} });
  }
  return rows.length > 0;
}

export async function shareByToken(db: Db, token: string): Promise<ShareRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  return db.one<ShareRow>("trip_shares", `select=${COLS}&token=${eq(token)}&revoked_at=is.null`);
}

export async function listShares(env: Env, db: Db, userId: string) {
  const rows = await db.select<ShareRow>("trip_shares", `select=${COLS}&user_id=${eq(userId)}&revoked_at=is.null`);
  return rows.map((r) => ({ trip_id: r.trip_id, version: r.version, redactions: r.redactions, remix_count: r.remix_count, ...shareLinks(env, r.token) }));
}

// ------------------------------------------------------------------ public views

/** Token from a share link, a remix link, or the bare token. */
export function tokenFrom(input: string): string | null {
  const m = input.trim().match(/(?:\/t\/|\/remix\/)([A-Za-z0-9_-]{32})/) ?? input.trim().match(/^([A-Za-z0-9_-]{32})$/);
  return m ? m[1] : null;
}

/** What the public remix page shows (no files, no owner). */
export function publicSummary(env: Env, s: ShareRow) {
  return { title: s.title, summary: s.summary, start_date: s.start_date, end_date: s.end_date, remix_count: s.remix_count, ...shareLinks(env, s.token) };
}

/** Visible text of an HTML page, for agents (no scripts, styles or tags). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article|tr|details|summary)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface SharedTripForAgent {
  title: string | null;
  share_url: string;
  remix_url: string;
  manifest: Record<string, unknown>;
  guide_text: string;
  files: string[];
}

/** The shared plan in a form an agent can adapt: manifest without route geometry + the page's text. */
export async function sharedTripForAgent(env: Env, db: Db, input: string): Promise<SharedTripForAgent> {
  const token = tokenFrom(input);
  const s = token ? await shareByToken(db, token) : null;
  if (!s) throw new ShareError("That shared trip doesn't exist or is no longer shared. Check the link.", 404);
  const read = async (path: string) => {
    const ref = s.files[path];
    if (!ref) return null;
    const obj = await env.BUCKET.get(shareKeys.blob(s.user_id, s.id, ref.sha256));
    return obj ? new TextDecoder().decode(await obj.arrayBuffer()) : null;
  };
  const manifest = JSON.parse((await read("manifest.json")) ?? "{}") as Record<string, unknown>;
  // Route geometry is long and must be recomputed for the new trip anyway.
  if (Array.isArray(manifest.routes)) {
    manifest.routes = (manifest.routes as Record<string, unknown>[]).map((r) => {
      const { geometry: _g, ...rest } = r;
      return { ...rest, geometry: "(omitted: recompute with compute_route)" };
    });
  }
  const guide = htmlToText((await read("index.html")) ?? "");
  await db.rpc("increment_remix", { share_token: s.token }).catch(() => undefined);
  return { title: s.title, manifest, guide_text: guide.slice(0, 24000), files: Object.keys(s.files).sort(), ...shareLinks(env, s.token) };
}
