// Live previews (DECISIONS #39). An agent pushes its in-progress bundle as it builds; the user
// opens an unguessable link on any device and the page reloads itself on every push.
//
// - A preview is a draft, not a version: it never reaches the app, never counts toward trip
//   limits and never cuts offline maps (the page uses the online basemap). publish_preview
//   turns the current files into a normal trip version.
// - Files are content-addressed blobs in R2; the DB row maps path → sha256. A push uploads
//   the new blobs first, then swaps the map in one conditional update, so a viewer never
//   sees half a push.
// - Previews are agent-written HTML, so they're served from a separate origin (PREVIEW_URL)
//   that has no cookies, no API and no MCP. Never serve them from PUBLIC_URL.
import { LIMITS, unsafePathReason, validateFiles, type BundleFile, type Issue } from "@waypack/bundle-schema";
import type { Env } from "../env.js";
import { randomToken, sha256 } from "./crypto.js";
import { Db, eq } from "./db.js";
import { publishBundle, type PublishResult } from "./pipeline.js";
import { resolvePlanet } from "./planet.js";
import { LIVE_JS } from "./preview-live.js";

export const PREVIEW_TTL_DAYS = 14;
/** Open (unexpired) previews per account. */
export const MAX_OPEN_PREVIEWS = 10;
/** Raw (unzipped) size of all files in one preview. */
export const MAX_PREVIEW_BYTES = LIMITS.maxZippedBytes;

export interface PreviewFileRef { sha256: string; bytes: number; type: string }
export interface PreviewRow {
  id: string;
  user_id: string;
  trip_id: string | null;
  token: string;
  title: string | null;
  files: Record<string, PreviewFileRef>;
  rev: number;
  bytes: number;
  validation: { ok: boolean; errors: Issue[]; warnings: Issue[] } | null;
  published_version: number | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export class PreviewError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const previewKeys = {
  prefix: (userId: string, previewId: string) => `previews/${userId}/${previewId}/`,
  blob: (userId: string, previewId: string, sha: string) => `previews/${userId}/${previewId}/blobs/${sha}`,
};

/** CSP the app sets on bundle HTML (packages/cli/src/files.ts), plus no framing. */
export const PREVIEW_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
  "worker-src 'self' blob:; frame-src 'none'; object-src 'none'; frame-ancestors 'none'";

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ origin

/** The preview origin, or null if it isn't configured or would share the main site's host. */
export function previewOrigin(env: Env): string | null {
  const raw = env.PREVIEW_URL?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const p = new URL(raw);
    // Same host = same cookie jar as the portal: agent-written scripts could act as the user.
    if (p.hostname === new URL(env.PUBLIC_URL).hostname) return null;
    return p.origin;
  } catch {
    return null;
  }
}

export function isPreviewHost(req: Request, env: Env): boolean {
  const origin = previewOrigin(env);
  return !!origin && new URL(req.url).host === new URL(origin).host;
}

export function previewLink(env: Env, token: string): string {
  const origin = previewOrigin(env);
  if (!origin) throw new PreviewError("Previews aren't configured on this server (PREVIEW_URL).", 503);
  return `${origin}/t/${token}/`;
}

// ------------------------------------------------------------------ pure helpers

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  avif: "image/avif", ico: "image/x-icon", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", geojson: "application/geo+json",
  pbf: "application/x-protobuf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", pdf: "application/pdf",
};
export const contentTypeFor = (path: string) => TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

/** Applies one push to the current path → blob map. `replace` starts from nothing. */
export function mergeFiles(
  current: Record<string, PreviewFileRef>,
  adds: { path: string; ref: PreviewFileRef }[],
  deletes: string[],
  replace: boolean,
): Record<string, PreviewFileRef> {
  const next: Record<string, PreviewFileRef> = replace ? {} : { ...current };
  for (const d of deletes) delete next[d];
  for (const a of adds) next[a.path] = a.ref;
  return next;
}

export function limitErrors(files: Record<string, PreviewFileRef>): string[] {
  const n = Object.keys(files).length;
  const bytes = Object.values(files).reduce((s, f) => s + f.bytes, 0);
  const out: string[] = [];
  if (n > LIMITS.maxFiles) out.push(`a preview can hold ${LIMITS.maxFiles} files (this push would make ${n})`);
  if (bytes > MAX_PREVIEW_BYTES) out.push(`a preview can hold ${MAX_PREVIEW_BYTES / 1048576} MB (this push would make ${(bytes / 1048576).toFixed(1)} MB); compress images or drop unused assets`);
  return out;
}

/** Adds the live-reload script to a page. Pages without </body> get it appended. */
export function injectLive(html: string, rev: number): string {
  const tag = `<script src="/__waypack/preview/live.js" data-rev="${rev}"></script>`;
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

const days = (n: number, from = Date.now()) => new Date(from + n * 86400000).toISOString();

// ------------------------------------------------------------------ rows

const COLS = "id,user_id,trip_id,token,title,files,rev,bytes,validation,published_version,created_at,updated_at,expires_at";

async function ownPreview(db: Db, userId: string, id: string): Promise<PreviewRow> {
  if (!uuidRe.test(id)) throw new PreviewError("`preview_id` must be the id returned by push_preview.");
  const row = await db.one<PreviewRow>("trip_previews", `select=${COLS}&id=${eq(id)}&user_id=${eq(userId)}&expires_at=gt.${new Date().toISOString()}`);
  if (!row) throw new PreviewError(`Preview ${id} not found (it may have expired after ${PREVIEW_TTL_DAYS} days without changes). Push again without preview_id to start a new one.`, 404);
  return row;
}

async function createPreview(db: Db, userId: string, tripId: string | null): Promise<PreviewRow> {
  const open = await db.count("trip_previews", `user_id=${eq(userId)}&expires_at=gt.${new Date().toISOString()}`);
  if (open >= MAX_OPEN_PREVIEWS) {
    throw new PreviewError(`You have ${open} open previews (max ${MAX_OPEN_PREVIEWS}). Publish or delete one (delete_preview), or keep pushing to an existing preview_id.`, 429);
  }
  const [row] = await db.insert<PreviewRow>("trip_previews", {
    user_id: userId,
    trip_id: tripId,
    token: randomToken(24),
    expires_at: days(PREVIEW_TTL_DAYS),
  });
  return row;
}

/** The preview to push into: by id, by the trip it revises, or a new one. */
async function targetPreview(env: Env, db: Db, userId: string, previewId?: string, tripId?: string): Promise<PreviewRow> {
  if (previewId) return ownPreview(db, userId, previewId);
  if (tripId) {
    if (!uuidRe.test(tripId)) throw new PreviewError("`trip_id` must be a UUID (from list_trips).");
    const trip = await db.one<{ id: string }>("trips", `select=id&id=${eq(tripId)}&user_id=${eq(userId)}&deleted_at=is.null`);
    if (!trip) throw new PreviewError(`Trip ${tripId} not found in your account.`, 404);
    const existing = await db.one<PreviewRow>("trip_previews", `select=${COLS}&trip_id=${eq(tripId)}&user_id=${eq(userId)}`);
    if (existing) {
      if (Date.parse(existing.expires_at) > Date.now()) return existing;
      await deletePreviewData(env, db, existing);
    }
    return createPreview(db, userId, tripId);
  }
  return createPreview(db, userId, null);
}

async function readBlob(env: Env, row: PreviewRow, ref: PreviewFileRef): Promise<Uint8Array> {
  const obj = await env.BUCKET.get(previewKeys.blob(row.user_id, row.id, ref.sha256));
  if (!obj) throw new PreviewError(`a stored preview file is missing (${ref.sha256.slice(0, 12)}); push the full bundle again with replace: true`, 500);
  return new Uint8Array(await obj.arrayBuffer());
}

/** All current files with their bytes (for validation and publishing). */
export async function previewBundleFiles(env: Env, row: PreviewRow): Promise<BundleFile[]> {
  return Promise.all(Object.entries(row.files).map(async ([path, ref]) => ({ path, data: await readBlob(env, row, ref) })));
}

// ------------------------------------------------------------------ push

export interface PushInput {
  previewId?: string;
  tripId?: string;
  files: BundleFile[];
  deletes?: string[];
  /** Replace every file (a full push, e.g. from a zip) instead of merging. */
  replace?: boolean;
}

export interface PushResult {
  preview_id: string;
  preview_url: string;
  rev: number;
  title: string | null;
  trip_id: string | null;
  files: number;
  bytes: number;
  expires_at: string;
  validation: { ok: boolean; errors: Issue[]; warnings: Issue[] };
}

export async function pushPreview(env: Env, db: Db, userId: string, input: PushInput): Promise<PushResult> {
  previewLink(env, "x".repeat(32)); // fails fast if previews aren't configured
  const deletes = input.deletes ?? [];
  for (const p of [...input.files.map((f) => f.path), ...deletes]) {
    const why = unsafePathReason(p);
    if (why) throw new PreviewError(`${p}: ${why}`);
  }
  if (!input.files.length && !deletes.length) throw new PreviewError("Nothing to push: pass `files` (changed files only is fine) and/or `delete`.");

  const adds = await Promise.all(
    input.files.map(async (f) => ({ path: f.path, data: f.data, ref: { sha256: await sha256(f.data), bytes: f.data.byteLength, type: contentTypeFor(f.path) } })),
  );

  let row = await targetPreview(env, db, userId, input.previewId, input.tripId);
  for (let attempt = 0; ; attempt++) {
    const next = mergeFiles(row.files, adds, deletes, !!input.replace);
    const over = limitErrors(next);
    if (over.length) throw new PreviewError(over.join("; "), 413);

    // Blobs first (content-addressed, so re-uploading an unchanged file is skipped).
    const have = new Set(Object.values(row.files).map((f) => f.sha256));
    await Promise.all(
      adds
        .filter((a) => !have.has(a.ref.sha256))
        .map((a) => env.BUCKET.put(previewKeys.blob(userId, row.id, a.ref.sha256), a.data, { httpMetadata: { contentType: a.ref.type } })),
    );

    // Validate the whole draft. Unfinished bundles are fine here; only publishing requires ok.
    const nextRow: PreviewRow = { ...row, files: next };
    const pushed = new Map(adds.map((a) => [a.ref.sha256, a.data]));
    const all = await Promise.all(Object.entries(next).map(async ([path, ref]) => ({ path, data: pushed.get(ref.sha256) ?? (await readBlob(env, nextRow, ref)) })));
    const v = validateFiles(all);
    const title = (v.manifest?.title as string | undefined) ?? manifestTitle(all) ?? row.title;
    const bytes = Object.values(next).reduce((s, f) => s + f.bytes, 0);

    // Swap in one conditional update: if another push landed meanwhile, merge onto it and retry.
    const updated = await db.update<PreviewRow>("trip_previews", `id=${eq(row.id)}&rev=${eq(row.rev)}`, {
      files: next,
      rev: row.rev + 1,
      bytes,
      title,
      validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
      updated_at: new Date().toISOString(),
      expires_at: days(PREVIEW_TTL_DAYS),
    });
    if (updated.length) {
      const saved = updated[0];
      await collectGarbage(env, saved, row.files);
      return {
        preview_id: saved.id,
        preview_url: previewLink(env, saved.token),
        rev: saved.rev,
        title: saved.title,
        trip_id: saved.trip_id,
        files: Object.keys(next).length,
        bytes,
        expires_at: saved.expires_at,
        validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
      };
    }
    if (attempt >= 3) throw new PreviewError("The preview kept changing during this push; try again.", 409);
    row = await ownPreview(db, userId, row.id);
  }
}

function manifestTitle(files: BundleFile[]): string | null {
  const m = files.find((f) => f.path === "manifest.json");
  if (!m) return null;
  try {
    const t = JSON.parse(new TextDecoder().decode(m.data))?.title;
    return typeof t === "string" ? t.slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** Deletes blobs that neither the new nor the previous file map uses (a viewer may still be on the previous rev). */
async function collectGarbage(env: Env, row: PreviewRow, previous: Record<string, PreviewFileRef>): Promise<void> {
  const keep = new Set([...Object.values(row.files), ...Object.values(previous)].map((f) => previewKeys.blob(row.user_id, row.id, f.sha256)));
  const prefix = `${previewKeys.prefix(row.user_id, row.id)}blobs/`;
  let cursor: string | undefined;
  const drop: string[] = [];
  do {
    const list = await env.BUCKET.list({ prefix, cursor });
    for (const o of list.objects) if (!keep.has(o.key)) drop.push(o.key);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < drop.length; i += 1000) await env.BUCKET.delete(drop.slice(i, i + 1000));
}

// ------------------------------------------------------------------ publish / list / delete

export async function publishPreview(env: Env, db: Db, userId: string, previewId: string): Promise<PublishResult & { preview_id: string }> {
  const row = await ownPreview(db, userId, previewId);
  if (!Object.keys(row.files).length) throw new PreviewError("This preview has no files yet.");
  const files = await previewBundleFiles(env, row);
  const r = await publishBundle(env, db, userId, { files }, row.trip_id);
  if (r.ok) {
    if (row.trip_id !== r.trip_id) {
      // One preview per trip: if an older preview pointed at this trip, detach it.
      await db.update("trip_previews", `trip_id=${eq(r.trip_id)}&id=neq.${row.id}`, { trip_id: null });
    }
    await db.update("trip_previews", `id=${eq(row.id)}`, { trip_id: r.trip_id, published_version: r.version, expires_at: days(PREVIEW_TTL_DAYS) });
  }
  return { ...r, preview_id: row.id };
}

export interface PreviewSummary {
  preview_id: string;
  preview_url: string;
  title: string | null;
  trip_id: string | null;
  rev: number;
  files: number;
  bytes: number;
  updated_at: string;
  expires_at: string;
  published_version: number | null;
  errors: number;
  warnings: number;
}

export async function listPreviews(env: Env, db: Db, userId: string): Promise<PreviewSummary[]> {
  const rows = await db.select<PreviewRow>("trip_previews", `select=${COLS}&user_id=${eq(userId)}&expires_at=gt.${new Date().toISOString()}&order=updated_at.desc`);
  return rows.map((r) => summarize(env, r));
}

export function summarize(env: Env, r: PreviewRow): PreviewSummary {
  return {
    preview_id: r.id,
    preview_url: previewLink(env, r.token),
    title: r.title,
    trip_id: r.trip_id,
    rev: r.rev,
    files: Object.keys(r.files ?? {}).length,
    bytes: r.bytes,
    updated_at: r.updated_at,
    expires_at: r.expires_at,
    published_version: r.published_version,
    errors: r.validation?.errors.length ?? 0,
    warnings: r.validation?.warnings.length ?? 0,
  };
}

export async function deletePreview(env: Env, db: Db, userId: string, previewId: string): Promise<void> {
  if (!uuidRe.test(previewId)) throw new PreviewError("`preview_id` must be the id returned by push_preview.");
  const row = await db.one<PreviewRow>("trip_previews", `select=${COLS}&id=${eq(previewId)}&user_id=${eq(userId)}`);
  if (!row) throw new PreviewError(`Preview ${previewId} not found.`, 404);
  await deletePreviewData(env, db, row);
}

async function deletePreviewData(env: Env, db: Db, row: PreviewRow): Promise<void> {
  let cursor: string | undefined;
  do {
    const list = await env.BUCKET.list({ prefix: previewKeys.prefix(row.user_id, row.id), cursor });
    if (list.objects.length) await env.BUCKET.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await db.delete("trip_previews", `id=${eq(row.id)}`);
}

/** Cron: drop previews that went 14 days without a push. */
export async function expirePreviews(env: Env, db: Db, now = new Date()): Promise<number> {
  const due = await db.select<PreviewRow>("trip_previews", `select=${COLS}&expires_at=lt.${now.toISOString()}`);
  for (const row of due) await deletePreviewData(env, db, row);
  return due.length;
}

// ------------------------------------------------------------------ preview host

const BASE_HEADERS: Record<string, string> = {
  // The token is the capability: never leak it to sites the plan links to.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 20px;color:#0f172a}@media(prefers-color-scheme:dark){body{background:#0b1120;color:#e8edf6}}</style>
<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p>`;
  return new Response(html, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

const notFound = () => page(404, "Preview not found", "This trip preview doesn't exist or has expired (previews last 14 days after the last change). Ask your agent to push it again.");

async function byToken(db: Db, token: string): Promise<PreviewRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  return db.one<PreviewRow>("trip_previews", `select=${COLS}&token=${eq(token)}&expires_at=gt.${new Date().toISOString()}`);
}

/** Everything served on PREVIEW_URL. Nothing else (API, MCP, portal, cookies) exists on this origin. */
export async function handlePreviewHost(req: Request, env: Env, db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: BASE_HEADERS });
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/" || path === "/favicon.ico") return page(200, "Waypack trip previews", "Open the link your agent gave you to watch your trip plan as it's built.");
  if (path === "/__waypack/preview/live.js") {
    return new Response(LIVE_JS, { headers: { ...BASE_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  }
  if (path.startsWith("/__waypack/sdk/v1/")) {
    if (!env.ASSETS) return new Response("SDK not deployed", { status: 404, headers: BASE_HEADERS });
    const res = await env.ASSETS.fetch(req);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(BASE_HEADERS)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  }

  let m = path.match(/^\/__waypack\/preview\/([^/]+)\/state$/);
  if (m) {
    const row = await byToken(db, m[1]);
    if (!row) return Response.json({ error: "not found" }, { status: 404, headers: { ...BASE_HEADERS, "Cache-Control": "no-store" } });
    return Response.json(
      { rev: row.rev, updated_at: row.updated_at, title: row.title, published_version: row.published_version, errors: row.validation?.errors.length ?? 0, warnings: row.validation?.warnings.length ?? 0, expires_at: row.expires_at },
      { headers: { ...BASE_HEADERS, "Cache-Control": "no-store" } },
    );
  }

  m = path.match(/^\/__waypack\/tiles\/([^/]+)\/(index\.json|online\.pmtiles)$/);
  if (m) {
    const row = await byToken(db, m[1]); // only live previews may use the tile proxy
    if (!row) return Response.json({ error: "not found" }, { status: 404, headers: BASE_HEADERS });
    const online = await onlineTilesUrl(env);
    if (m[2] === "index.json") {
      return Response.json({ extracts: [], online: online ? `/__waypack/tiles/${m[1]}/online.pmtiles` : null }, { headers: { ...BASE_HEADERS, "Cache-Control": "no-store" } });
    }
    if (!online) return new Response("no online basemap", { status: 404, headers: BASE_HEADERS });
    return proxyTiles(req, online);
  }

  m = path.match(/^\/t\/([^/]+)(\/.*)?$/);
  if (!m) return notFound();
  if (!m[2]) return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: `/t/${m[1]}/` } });
  const row = await byToken(db, m[1]);
  if (!row) return notFound();

  let rel: string;
  try {
    rel = decodeURIComponent(m[2].slice(1));
  } catch {
    return notFound();
  }
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (rel === "index.html" && !row.files["index.html"]) {
    const title = row.title ? `${escapeHtml(row.title)} — preview` : "Preview starting…";
    return withLiveCsp(page(200, title, `Your agent hasn't pushed the page yet. This tab refreshes by itself when it does.<script src="/__waypack/preview/live.js" data-rev="${row.rev}"></script>`));
  }
  const ref = row.files[rel];
  if (!ref) return new Response("not found", { status: 404, headers: { ...BASE_HEADERS, "Cache-Control": "no-cache" } });

  const isHtml = /\.html?$/i.test(rel);
  // HTML embeds the rev for live reload, so its validator includes it.
  const etag = `"${ref.sha256.slice(0, 32)}${isHtml ? `-${row.rev}` : ""}"`;
  const headers: Record<string, string> = { ...BASE_HEADERS, "Content-Type": ref.type || contentTypeFor(rel), "Cache-Control": "no-cache", ETag: etag };
  if (isHtml) headers["Content-Security-Policy"] = PREVIEW_CSP;
  if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });

  const obj = await env.BUCKET.get(previewKeys.blob(row.user_id, row.id, ref.sha256));
  if (!obj) return new Response("missing", { status: 404, headers: BASE_HEADERS });
  if (isHtml) {
    const html = injectLive(new TextDecoder().decode(await obj.arrayBuffer()), row.rev);
    return new Response(req.method === "HEAD" ? null : html, { headers });
  }
  headers["Content-Length"] = String(ref.bytes);
  return new Response(req.method === "HEAD" ? null : obj.body, { headers });
}

function withLiveCsp(res: Response): Response {
  // The "waiting" page loads live.js from this origin.
  res.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  return res;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Online basemap for previews: ONLINE_TILES_URL if it's a .pmtiles, else the planet the tiler uses. */
async function onlineTilesUrl(env: Env): Promise<string | null> {
  if (env.ONLINE_TILES_URL && /\.pmtiles(\?|$)/.test(env.ONLINE_TILES_URL)) return env.ONLINE_TILES_URL;
  try {
    return (await resolvePlanet(env)).url;
  } catch {
    return null;
  }
}

/** Same-origin proxy (the page's CSP only allows connect-src 'self'): forwards Range only. */
async function proxyTiles(req: Request, upstream: string): Promise<Response> {
  const range = req.headers.get("Range");
  const res = await fetch(upstream, { method: req.method, headers: range ? { Range: range } : {} });
  const h = new Headers(BASE_HEADERS);
  for (const k of ["Content-Type", "Content-Length", "Content-Range", "ETag", "Last-Modified", "Accept-Ranges"]) {
    const v = res.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("Cache-Control", "public, max-age=86400");
  return new Response(res.body, { status: res.status, headers: h });
}

