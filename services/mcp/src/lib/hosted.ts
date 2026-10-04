// Everything served on the preview origin (PREVIEW_URL): live previews (drafts) and public shares.
// Both are agent-written HTML, so this origin has no cookies, API, MCP or portal (DECISIONS #40).
import type { Env } from "../env.js";
import { Db, eq } from "./db.js";
import { resolvePlanet } from "./planet.js";
import { LIVE_JS } from "./preview-live.js";
import { contentTypeFor, injectLive, PREVIEW_CSP, previewKeys, type PreviewFileRef, type PreviewRow } from "./previews.js";
import { SHARE_JS } from "./share-banner.js";
import { shareByToken, shareKeys } from "./shares.js";

const BASE_HEADERS: Record<string, string> = {
  // The token is the capability: never leak it to sites the plan links to.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const PREVIEW_COLS = "id,user_id,trip_id,token,title,files,rev,bytes,validation,published_version,base_version,note,created_at,updated_at,expires_at";

/** A page set served at /t/<token>/: a live preview or a public share. */
interface Hosted {
  kind: "preview" | "share";
  files: Record<string, PreviewFileRef>;
  blobKey: (sha: string) => string;
  title: string | null;
  /** HTML injection: live reload for previews, the "Plan this trip" banner for shares. */
  inject: (html: string) => string;
  /** Part of HTML ETags (the injected script differs per revision). */
  tag: string;
  preview?: PreviewRow;
}

async function previewByToken(db: Db, token: string): Promise<PreviewRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  return db.one<PreviewRow>("trip_previews", `select=${PREVIEW_COLS}&token=${eq(token)}&expires_at=gt.${new Date().toISOString()}`);
}

async function resolve(env: Env, db: Db, token: string): Promise<Hosted | null> {
  if (!TOKEN_RE.test(token)) return null;
  const p = await previewByToken(db, token);
  if (p) {
    return {
      kind: "preview",
      files: p.files,
      blobKey: (sha) => previewKeys.blob(p.user_id, p.id, sha),
      title: p.title,
      inject: (html) => injectLive(html, p.rev),
      tag: `p${p.rev}`,
      preview: p,
    };
  }
  const s = await shareByToken(db, token);
  if (s) {
    const remix = `${env.PUBLIC_URL}/remix/${s.token}`;
    return {
      kind: "share",
      files: s.files,
      blobKey: (sha) => shareKeys.blob(s.user_id, s.id, sha),
      title: s.title,
      inject: (html) => injectBefore(html, `<script src="/__waypack/share.js" data-remix="${escapeAttr(remix)}"></script>`),
      tag: `s${s.version}`,
    };
  }
  return null;
}

function injectBefore(html: string, tag: string): string {
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 20px;color:#0f172a}@media(prefers-color-scheme:dark){body{background:#0b1120;color:#e8edf6}}</style>
<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p>`;
  return new Response(html, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

const notFound = () => page(404, "Trip not found", "This trip link doesn't exist, has expired (previews last 14 days after the last change) or is no longer shared.");

/** Everything served on PREVIEW_URL. */
export async function handlePreviewHost(req: Request, env: Env, db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: BASE_HEADERS });
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/" || path === "/favicon.ico") return page(200, "Waypack trips", "Open the link you were given to see a trip plan.");
  if (path === "/__waypack/preview/live.js") return script(LIVE_JS);
  if (path === "/__waypack/share.js") return script(SHARE_JS);
  if (path.startsWith("/__waypack/sdk/v1/")) {
    if (!env.ASSETS) return new Response("SDK not deployed", { status: 404, headers: BASE_HEADERS });
    const res = await env.ASSETS.fetch(req);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(BASE_HEADERS)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  }

  let m = path.match(/^\/__waypack\/preview\/([^/]+)\/state$/);
  if (m) {
    const row = await previewByToken(db, m[1]);
    if (!row) return Response.json({ error: "not found" }, { status: 404, headers: { ...BASE_HEADERS, "Cache-Control": "no-store" } });
    return Response.json(
      { rev: row.rev, updated_at: row.updated_at, title: row.title, note: row.note, published_version: row.published_version, errors: row.validation?.errors.length ?? 0, warnings: row.validation?.warnings.length ?? 0, expires_at: row.expires_at },
      { headers: { ...BASE_HEADERS, "Cache-Control": "no-store" } },
    );
  }

  m = path.match(/^\/__waypack\/tiles\/([^/]+)\/(index\.json|online\.pmtiles)$/);
  if (m) {
    if (!(await resolve(env, db, m[1]))) return Response.json({ error: "not found" }, { status: 404, headers: BASE_HEADERS }); // only live links may use the proxy
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
  const doc = await resolve(env, db, m[1]);
  if (!doc) return notFound();

  let rel: string;
  try {
    rel = decodeURIComponent(m[2].slice(1));
  } catch {
    return notFound();
  }
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (doc.kind === "preview" && rel === "index.html" && !doc.files["index.html"]) {
    const title = doc.title ? `${escapeHtml(doc.title)} — preview` : "Preview starting…";
    const res = page(200, title, `Your agent hasn't pushed the page yet. This tab refreshes by itself when it does.<script src="/__waypack/preview/live.js" data-rev="${doc.preview!.rev}"></script>`);
    res.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'");
    return res;
  }
  const ref = doc.files[rel];
  if (!ref) return new Response("not found", { status: 404, headers: { ...BASE_HEADERS, "Cache-Control": "no-cache" } });

  const isHtml = /\.html?$/i.test(rel);
  const etag = `"${ref.sha256.slice(0, 32)}${isHtml ? `-${doc.tag}` : ""}"`;
  const headers: Record<string, string> = { ...BASE_HEADERS, "Content-Type": ref.type || contentTypeFor(rel), "Cache-Control": "no-cache", ETag: etag };
  if (isHtml) headers["Content-Security-Policy"] = PREVIEW_CSP;
  if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });

  const obj = await env.BUCKET.get(doc.blobKey(ref.sha256));
  if (!obj) return new Response("missing", { status: 404, headers: BASE_HEADERS });
  if (isHtml) {
    const html = doc.inject(new TextDecoder().decode(await obj.arrayBuffer()));
    return new Response(req.method === "HEAD" ? null : html, { headers });
  }
  headers["Content-Length"] = String(ref.bytes);
  return new Response(req.method === "HEAD" ? null : obj.body, { headers });
}

const script = (js: string) => new Response(js, { headers: { ...BASE_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" } });
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const escapeAttr = escapeHtml;

/** Online basemap for previews and shares: ONLINE_TILES_URL if it's a .pmtiles, else the planet the tiler uses. */
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
