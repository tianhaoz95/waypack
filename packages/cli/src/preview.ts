import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { formatResult, validateFiles } from "@waypack/bundle-schema";
import { contentType, CSP, readBundleDir } from "./files.js";

export interface PreviewOptions {
  dir: string;
  port: number;
  host: string;
  /** Local .pmtiles file to serve as the offline extract. */
  tiles?: string;
  /** Remote planet/extract URL to proxy (range requests). `false` disables online tiles. */
  online?: string | false;
  quiet?: boolean;
}

const require = createRequire(import.meta.url);
export function sdkDistDir(): string {
  return join(dirname(require.resolve("@waypack/trip-sdk/package.json")), "dist");
}

let latestBuild: Promise<string | null> | null = null;
/** Latest daily Protomaps planet build (used only for previews). */
export function latestPlanetUrl(): Promise<string | null> {
  latestBuild ??= fetch("https://build-metadata.protomaps.dev/builds.json")
    .then((r) => r.json() as Promise<{ key: string }[]>)
    .then((b) => `https://build.protomaps.com/${b.at(-1)!.key}`)
    .catch(() => null);
  return latestBuild;
}

function safeJoin(root: string, rel: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.includes("\0")) return null;
  const p = normalize(join(root, decoded));
  return p === root || p.startsWith(root + sep) ? p : null;
}

function parseRange(h: string | undefined, size: number): [number, number] | null | "invalid" {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return "invalid";
  let start: number, end: number;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start > end || start >= size ? "invalid" : [start, end];
}

/** Serves a file with HTTP Range support (pmtiles needs it). */
export function sendFile(req: IncomingMessage, res: ServerResponse, path: string, headers: Record<string, string> = {}) {
  const size = statSync(path).size;
  const range = parseRange(req.headers.range, size);
  const base = { "Content-Type": contentType(path), "Accept-Ranges": "bytes", "Cache-Control": "no-cache", ...headers };
  if (range === "invalid") {
    res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` }).end();
  } else if (range) {
    res.writeHead(206, { ...base, "Content-Range": `bytes ${range[0]}-${range[1]}/${size}`, "Content-Length": String(range[1] - range[0] + 1) });
    if (req.method === "HEAD") res.end(); else createReadStream(path, { start: range[0], end: range[1] }).pipe(res);
  } else {
    res.writeHead(200, { ...base, "Content-Length": String(size) });
    if (req.method === "HEAD") res.end(); else createReadStream(path).pipe(res);
  }
}

async function proxyRange(req: IncomingMessage, res: ServerResponse, url: string) {
  // Never stream a whole planet: only ranged reads are proxied.
  if (!req.headers.range) return void res.writeHead(400).end("Range header required");
  try {
    const upstream = await fetch(url, { headers: { Range: req.headers.range } });
    const h: Record<string, string> = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600" };
    for (const k of ["content-range", "content-length", "etag"]) {
      const v = upstream.headers.get(k);
      if (v) h[k] = v;
    }
    res.writeHead(upstream.status, h);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.writeHead(502).end(`tile proxy failed: ${(e as Error).message}`);
  }
}

export async function startPreview(o: PreviewOptions): Promise<{ url: string; close(): Promise<void> }> {
  const root = resolve(o.dir);
  const sdkDir = sdkDistDir();
  if (!existsSync(join(sdkDir, "waypack.js"))) throw new Error(`Trip SDK not built (${sdkDir}). Run: npm run build -w @waypack/trip-sdk`);
  const onlineUrl = o.online === false ? null : o.online ?? (o.tiles ? null : await latestPlanetUrl());
  let lastReport = "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/" || path === "/t/local") return void res.writeHead(302, { Location: "/t/local/" }).end();

    if (path.startsWith("/t/local/")) {
      let rel = path.slice("/t/local/".length) || "index.html";
      if (rel.endsWith("/")) rel += "index.html";
      const file = safeJoin(root, rel);
      if (!file || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end("not found");
      const headers: Record<string, string> = {};
      if (/\.html?$/.test(file)) {
        headers["Content-Security-Policy"] = CSP;
        if (rel === "index.html" && !o.quiet) {
          const r = validateFiles(readBundleDir(root).files);
          const report = formatResult(r);
          if (report !== lastReport) { console.log(`\n[validate] ${new Date().toLocaleTimeString()}\n${report}`); lastReport = report; }
        }
      }
      return sendFile(req, res, file, headers);
    }

    if (path.startsWith("/__waypack/sdk/v1/")) {
      const file = safeJoin(sdkDir, path.slice("/__waypack/sdk/v1/".length));
      if (!file || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end("not found");
      return sendFile(req, res, file, { "Cache-Control": "public, max-age=300" });
    }

    if (path === "/__waypack/tiles/local/index.json") {
      const body = {
        extracts: o.tiles ? [{ url: "/__waypack/tiles/local/extract.pmtiles" }] : [],
        online: onlineUrl ? "/__waypack/tiles/local/online.pmtiles" : null,
      };
      return void res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    }
    if (path === "/__waypack/tiles/local/extract.pmtiles" && o.tiles) return sendFile(req, res, resolve(o.tiles));
    if (path === "/__waypack/tiles/local/online.pmtiles" && onlineUrl) return proxyRange(req, res, onlineUrl);

    if (path === "/__waypack/validate") {
      const r = validateFiles(readBundleDir(root).files);
      delete r.manifest;
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(r, null, 2));
    }
    res.writeHead(404).end("not found");
  });

  await new Promise<void>((ok, fail) => server.once("error", fail).listen(o.port, o.host, ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  return {
    url: `http://${o.host === "0.0.0.0" ? "localhost" : o.host}:${port}/t/local/`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

export function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}
