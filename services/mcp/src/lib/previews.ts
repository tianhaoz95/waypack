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
//   that has no cookies, no API and no MCP (served by hosted.ts). Never serve them from PUBLIC_URL.
import { LIMITS, unsafePathReason, validateFiles, type BundleFile, type Issue } from "@waypack/bundle-schema";
import type { Env } from "../env.js";
import { randomToken, sha256 } from "./crypto.js";
import { Db, eq } from "./db.js";
import { publishBundle, type PublishResult } from "./pipeline.js";

export const PREVIEW_TTL_DAYS = 14;
/** Open (unexpired) previews per account. */
export const MAX_OPEN_PREVIEWS = 10;
/** Blobs younger than this are never garbage-collected: a concurrent push may be about to reference them. */
export const GC_GRACE_MS = 10 * 60 * 1000;
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

/**
 * Deletes blobs that neither the new nor the previous file map uses (a viewer may still be on the
 * previous rev). Recent blobs are kept: a push racing this one may have uploaded them and not swapped yet.
 */
export async function collectGarbage(env: Env, row: PreviewRow, previous: Record<string, PreviewFileRef>, now = Date.now()): Promise<void> {
  const keep = new Set([...Object.values(row.files), ...Object.values(previous)].map((f) => previewKeys.blob(row.user_id, row.id, f.sha256)));
  const prefix = `${previewKeys.prefix(row.user_id, row.id)}blobs/`;
  let cursor: string | undefined;
  const drop: string[] = [];
  do {
    const list = await env.BUCKET.list({ prefix, cursor });
    for (const o of list.objects) if (!keep.has(o.key) && now - new Date(o.uploaded).getTime() > GC_GRACE_MS) drop.push(o.key);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < drop.length; i += 1000) await env.BUCKET.delete(drop.slice(i, i + 1000));
}

// ------------------------------------------------------------------ publish / list / delete

export async function publishPreview(env: Env, db: Db, userId: string, previewId: string): Promise<PublishResult & { preview_id: string }> {
  const row = await ownPreview(db, userId, previewId);
  if (!Object.keys(row.files).length) throw new PreviewError("This preview has no files yet.");
  const files = await previewBundleFiles(env, row);
  // If the trip this draft revised has since been deleted, publish it as a new trip.
  let tripId = row.trip_id;
  if (tripId && !(await db.one("trips", `select=id&id=${eq(tripId)}&user_id=${eq(userId)}&deleted_at=is.null`))) {
    tripId = null;
    await db.update("trip_previews", `id=${eq(row.id)}`, { trip_id: null });
  }
  const r = await publishBundle(env, db, userId, { files }, tripId);
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
