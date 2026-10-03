import { unzipSync, zipSync, type Zippable } from "fflate";
import type { BundleFile, Issue } from "./types.js";
import { LIMITS } from "./limits.js";

interface CentralEntry { name: string; uncompressed: number; compressed: number; isSymlink: boolean; isDir: boolean }

/**
 * Reads the zip central directory without inflating anything, so we can reject
 * symlinks, traversal, and zip bombs before spending CPU.
 */
export function readCentralDirectory(buf: Uint8Array): CentralEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Find End Of Central Directory record (scan back over the max comment length).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  let count = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) {
    // ZIP64: the locator sits just before the EOCD.
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error("bad zip64 locator");
    const z64 = Number(dv.getBigUint64(loc + 8, true));
    count = Number(dv.getBigUint64(z64 + 32, true));
    offset = Number(dv.getBigUint64(z64 + 48, true));
  }
  const out: CentralEntry[] = [];
  const dec = new TextDecoder();
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt central directory");
    const madeBy = dv.getUint16(p + 4, true) >> 8;
    let compressed = dv.getUint32(p + 20, true);
    let uncompressed = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const ext = dv.getUint32(p + 38, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    // zip64 extra field carries real sizes
    if (uncompressed === 0xffffffff || compressed === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = dv.getUint16(e, true), sz = dv.getUint16(e + 2, true);
        if (id === 1) {
          let q = e + 4;
          if (uncompressed === 0xffffffff) { uncompressed = Number(dv.getBigUint64(q, true)); q += 8; }
          if (compressed === 0xffffffff) compressed = Number(dv.getBigUint64(q, true));
        }
        e += 4 + sz;
      }
    }
    const unixMode = madeBy === 3 ? ext >>> 16 : 0;
    out.push({
      name,
      compressed,
      uncompressed,
      isSymlink: (unixMode & 0o170000) === 0o120000,
      isDir: name.endsWith("/") || (unixMode & 0o170000) === 0o040000,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const IGNORED = (p: string) => p.startsWith("__MACOSX/") || /(^|\/)(\.DS_Store|Thumbs\.db)$/.test(p);

/** Returns an error message if the path is unsafe, else null. */
export function unsafePathReason(p: string): string | null {
  if (!p) return "empty path";
  if (p.includes("\\")) return "backslash in path";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "absolute path";
  if (p.split("/").some((s) => s === "..")) return "`..` segment";
  if (p.includes("\0")) return "NUL byte in path";
  return null;
}

/**
 * If every entry sits under a single top-level folder and there's no root
 * manifest.json, strip that folder (people often zip the directory itself).
 */
export function stripCommonRoot(paths: string[]): string {
  if (paths.includes("manifest.json")) return "";
  const firsts = new Set(paths.map((p) => p.split("/")[0]));
  if (firsts.size !== 1) return "";
  const root = [...firsts][0];
  return paths.every((p) => p.startsWith(`${root}/`)) && paths.includes(`${root}/manifest.json`) ? `${root}/` : "";
}

export interface UnzipResult { files: BundleFile[]; errors: Issue[] }

export function unzipBundle(buf: Uint8Array): UnzipResult {
  const errors: Issue[] = [];
  if (buf.byteLength > LIMITS.maxZippedBytes) {
    errors.push({ path: "bundle.zip", message: `zip is ${mb(buf.byteLength)}; max is ${mb(LIMITS.maxZippedBytes)}`, hint: "compress images (WebP/JPEG ≤ 1600px) and drop unused assets" });
    return { files: [], errors };
  }
  let entries: CentralEntry[];
  try {
    entries = readCentralDirectory(buf);
  } catch (e) {
    errors.push({ path: "bundle.zip", message: (e as Error).message });
    return { files: [], errors };
  }
  let total = 0;
  for (const e of entries) {
    if (IGNORED(e.name)) continue;
    const why = unsafePathReason(e.name);
    if (why) errors.push({ path: e.name, message: `unsafe zip entry: ${why}` });
    if (e.isSymlink) errors.push({ path: e.name, message: "symlinks are not allowed" });
    total += e.uncompressed;
  }
  if (total > LIMITS.maxUnzippedBytes) errors.push({ path: "bundle.zip", message: `unzipped size ${mb(total)} exceeds ${mb(LIMITS.maxUnzippedBytes)}` });
  const fileEntries = entries.filter((e) => !e.isDir && !IGNORED(e.name));
  if (fileEntries.length > LIMITS.maxFiles) errors.push({ path: "bundle.zip", message: `${fileEntries.length} files; max is ${LIMITS.maxFiles}` });
  if (errors.length) return { files: [], errors };

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(buf, { filter: (f) => !f.name.endsWith("/") && !IGNORED(f.name) });
  } catch (e) {
    errors.push({ path: "bundle.zip", message: `could not unzip: ${(e as Error).message}` });
    return { files: [], errors };
  }
  const names = Object.keys(raw);
  const prefix = stripCommonRoot(names);
  return { files: names.map((n) => ({ path: n.slice(prefix.length), data: raw[n] })), errors };
}

export function zipBundle(files: BundleFile[]): Uint8Array {
  const z: Zippable = {};
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    // Already-compressed formats: store, don't deflate.
    const level = /\.(png|jpe?g|webp|gif|avif|woff2?|zip|pmtiles|mp4|mp3)$/i.test(f.path) ? 0 : 6;
    z[f.path] = [f.data, { level, mtime: new Date("2000-01-01T00:00:00Z") }];
  }
  return zipSync(z);
}

export const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
