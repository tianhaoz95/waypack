import { readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { BundleFile } from "@waypack/bundle-schema";

const SKIP = new Set([".DS_Store", "Thumbs.db", ".git", "node_modules"]);

/** Reads every file under `dir` as bundle files (posix relative paths). Symlinks are rejected. */
export function readBundleDir(dir: string): { files: BundleFile[]; symlinks: string[] } {
  const files: BundleFile[] = [];
  const symlinks: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (SKIP.has(name)) continue;
      const p = join(d, name);
      const rel = relative(dir, p).split(sep).join("/");
      const st = lstatSync(p);
      if (st.isSymbolicLink()) symlinks.push(rel);
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push({ path: rel, data: new Uint8Array(readFileSync(p)) });
    }
  };
  walk(dir);
  return { files, symlinks };
}

export const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

export const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pbf: "application/x-protobuf",
  pmtiles: "application/octet-stream",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  geojson: "application/geo+json",
  gpx: "application/gpx+xml",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

export const contentType = (path: string) => CONTENT_TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

/** The runtime CSP the app sets on bundle HTML (design §4.4). Keep in sync with apps/mobile. */
export const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
  "worker-src 'self' blob:; frame-src 'none'; object-src 'none'";
