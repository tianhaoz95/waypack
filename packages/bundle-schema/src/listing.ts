// The optional store-style listing (manifest.listing): a promotional cover and phone screenshots
// shown in the web portal. Files live under listing/; the server stores them apart from the bundle,
// so the app never downloads them. Images are only ever shown with <img>, never as documents.
import type { Issue, Manifest } from "./types.js";

export const LISTING_DIR = "listing/";
export const LISTING_LIMITS = {
  maxFileBytes: 1_500_000,
  maxTotalBytes: 5_000_000,
  maxScreenshots: 6,
} as const;

export type ListingImageType = "png" | "jpeg" | "webp" | "svg";

export const isListingPath = (p: string) => p.startsWith(LISTING_DIR);

/** Every listing file the manifest references (cover first, then screenshots). */
export function listingPaths(m: Pick<Manifest, "listing"> | null | undefined): string[] {
  const l = m?.listing;
  if (!l) return [];
  return [...(l.cover ? [l.cover] : []), ...(l.screenshots ?? []).map((s) => s.src)];
}

export const LISTING_CONTENT_TYPES: Record<ListingImageType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** Image type from the file's bytes (not its name). */
export function sniffImage(b: Uint8Array): ListingImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  const head = new TextDecoder().decode(b.subarray(0, 512)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** Pixel size of a PNG / JPEG / WebP, or null if it can't be read. */
export function imageSize(b: Uint8Array, type: ListingImageType): { width: number; height: number } | null {
  try {
    if (type === "png" && b.length >= 24) return { width: u32be(b, 16), height: u32be(b, 20) };
    if (type === "jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const len = u16be(b, i + 2);
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (type === "webp" && b.length >= 30) {
      const chunk = ascii(b, 12, 4);
      if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
      if (chunk === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* unreadable header */
  }
  return null;
}

/** SVG features that could run code or fetch from the network (inert as <img>, but rejected anyway). */
function unsafeSvg(text: string): string | null {
  if (/<script[\s>]/i.test(text)) return "contains <script>";
  if (/\son[a-z]+\s*=/i.test(text)) return "contains an event handler attribute (on…=)";
  if (/javascript:/i.test(text)) return "contains a javascript: URL";
  if (/<foreignObject[\s>]/i.test(text)) return "contains <foreignObject>";
  if (/(?:href|src)\s*=\s*["']\s*(?:https?:)?\/\//i.test(text)) return "references a remote URL (embed everything)";
  if (/url\(\s*["']?\s*(?:https?:)?\/\//i.test(text)) return "references a remote URL in CSS (embed everything)";
  return null;
}

/** Checks manifest.listing against the bundle's files. */
export function checkListing(m: Manifest, files: Map<string, Uint8Array>): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const referenced = new Set(listingPaths(m));
  let total = 0;

  const check = (path: string, where: string, shape: "landscape" | "portrait") => {
    const data = files.get(path);
    if (!data) {
      // Not an error: listing files aren't part of the downloaded bundle, so an update built from
      // get_trip won't have them. Publishing keeps the previous version's copy, or drops the entry.
      warnings.push({ path: where, message: `${path} is not in this upload`, hint: "when updating a trip, the published listing keeps the previous version's file; otherwise add it under listing/" });
      return;
    }
    total += data.byteLength;
    if (data.byteLength > LISTING_LIMITS.maxFileBytes) {
      errors.push({ path: path, message: `${(data.byteLength / 1e6).toFixed(1)} MB; listing images must be ≤ 1.5 MB`, hint: "resize (≤ 1600px wide) and compress as WebP or JPEG" });
    }
    const type = sniffImage(data);
    if (!type) {
      errors.push({ path, message: "not a PNG, JPEG, WebP or SVG image" });
      return;
    }
    const ext = path.split(".").pop()!.toLowerCase();
    if ((ext === "jpg" ? "jpeg" : ext) !== type) errors.push({ path, message: `file is ${type.toUpperCase()} but named .${ext}` });
    if (type === "svg") {
      const why = unsafeSvg(new TextDecoder().decode(data));
      if (why) errors.push({ path, message: `SVG ${why}`, hint: "listing SVGs must be plain, self-contained artwork" });
      return;
    }
    const size = imageSize(data, type);
    if (size) {
      const r = size.width / size.height;
      if (shape === "landscape" && r < 1.2) warnings.push({ path, message: `cover is ${size.width}×${size.height}; it's shown wide (about 16:9) and will be cropped` });
      if (shape === "portrait" && r > 0.8) warnings.push({ path, message: `screenshot is ${size.width}×${size.height}; phone screenshots are portrait (about 9:19.5)` });
      if (size.width < 300) warnings.push({ path, message: `only ${size.width}px wide; it will look blurry`, hint: "use at least 390px (screenshots) or 1200px (cover)" });
    }
  };

  const l = m.listing;
  if (l?.cover) check(l.cover, "manifest.listing.cover", "landscape");
  (l?.screenshots ?? []).forEach((s, i) => check(s.src, `manifest.listing.screenshots[${i}]`, "portrait"));
  if (total > LISTING_LIMITS.maxTotalBytes) {
    errors.push({ path: "manifest.listing", message: `listing images total ${(total / 1e6).toFixed(1)} MB; max is 5 MB` });
  }
  for (const p of files.keys()) {
    if (isListingPath(p) && !referenced.has(p)) {
      warnings.push({ path: p, message: "in listing/ but not referenced by manifest.listing; it won't be shown or kept", hint: "add it to manifest.listing.cover or .screenshots, or delete it" });
    }
  }
  return { errors, warnings };
}
