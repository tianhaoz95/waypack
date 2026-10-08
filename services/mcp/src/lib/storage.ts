import type { Env } from "../env.js";
import { signPath } from "./crypto.js";

export const keys = {
  upload: (userId: string, uploadId: string) => `uploads/${userId}/${uploadId}.zip`,
  bundle: (userId: string, tripId: string, version: number) => `bundles/${userId}/${tripId}/v${version}/bundle.zip`,
  manifest: (userId: string, tripId: string, version: number) => `bundles/${userId}/${tripId}/v${version}/manifest.json`,
  cover: (userId: string, tripId: string, version: number, ext = "jpg") => `bundles/${userId}/${tripId}/v${version}/cover.${ext}`,
  tiles: (userId: string, tripId: string, hash: string) => `tiles/${userId}/${tripId}/${hash}.pmtiles`,
};

/** Short-lived URL served by this Worker (`GET /files/<key>`), with Range support. */
export async function signedFileUrl(env: Env, key: string, ttlSeconds = 3600): Promise<string> {
  return `${env.PUBLIC_URL}${await signPath(env.SIGNING_SECRET, `/files/${key}`, ttlSeconds)}`;
}

export async function signedUploadUrl(env: Env, uploadId: string, ttlSeconds = 900): Promise<string> {
  return `${env.PUBLIC_URL}${await signPath(env.SIGNING_SECRET, `/upload/${uploadId}`, ttlSeconds)}`;
}

/** Streams a stored file honoring a single `Range: bytes=a-b` header (pmtiles + resumable downloads). */
export async function serveStored(env: Env, key: string, req: Request, extra: Record<string, string> = {}): Promise<Response> {
  const head = await env.BUCKET.head(key);
  if (!head) return new Response("not found", { status: 404 });
  const size = head.size;
  const h = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": key.endsWith(".zip")
      ? "application/zip"
      : key.endsWith(".json")
        ? "application/json"
        : key.endsWith(".png")
          ? "image/png"
          : key.endsWith(".webp")
            ? "image/webp"
            : key.endsWith(".jpg") || key.endsWith(".jpeg")
              ? "image/jpeg"
              : key.endsWith(".dmg")
                ? "application/x-apple-diskimage"
                : "application/octet-stream",
    ETag: head.httpEtag,
    "Cache-Control": "private, max-age=3600",
    ...extra,
  });
  const range = req.headers.get("Range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start: number, end: number;
    if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const obj = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return new Response("not found", { status: 404 });
    h.set("Content-Range", `bytes ${start}-${end}/${size}`);
    h.set("Content-Length", String(end - start + 1));
    return new Response(req.method === "HEAD" ? null : obj.body, { status: 206, headers: h });
  }
  h.set("Content-Length", String(size));
  if (req.method === "HEAD") return new Response(null, { headers: h });
  const obj = await env.BUCKET.get(key);
  return new Response(obj!.body, { headers: h });
}
