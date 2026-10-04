import type { BundleFile, InlineFile, Issue, ValidationResult } from "./types.js";
import { LIMITS, SDK_SCRIPT_PATH } from "./limits.js";
import { checkManifest, parseManifestText } from "./manifest.js";
import { scanCss, scanHtml, scanJs, type ScanCtx } from "./html.js";
import { mb, unsafePathReason, unzipBundle } from "./zip.js";

export * from "./types.js";
export * from "./limits.js";
export * from "./geo.js";
export { checkManifest, pointerToPath } from "./manifest.js";
export { classifyUrl, resolveRelative } from "./html.js";
export { unzipBundle, zipBundle, readCentralDirectory, unsafePathReason } from "./zip.js";
export { default as manifestSchema } from "./generated/schema.js";

const td = new TextDecoder("utf-8");
const te = new TextEncoder();

export function decodeInlineFiles(files: InlineFile[]): { files: BundleFile[]; errors: Issue[] } {
  const errors: Issue[] = [];
  const out: BundleFile[] = [];
  for (const [i, f] of files.entries()) {
    const enc = (f.encoding ?? "utf-8").toLowerCase();
    try {
      if (enc === "base64") out.push({ path: f.path, data: base64ToBytes(f.content) });
      else if (enc === "utf-8" || enc === "utf8") out.push({ path: f.path, data: te.encode(f.content) });
      else errors.push({ path: `files[${i}].encoding`, message: `unknown encoding \`${f.encoding}\``, hint: "use utf-8 or base64" });
    } catch {
      errors.push({ path: `files[${i}]`, message: `\`${f.path}\` has invalid base64 content` });
    }
  }
  return { files: out, errors };
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validates an in-memory set of bundle files. Pure; runs in Node, Workers and browsers. */
export function validateFiles(input: BundleFile[]): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const files = new Map<string, Uint8Array>();
  let bytes = 0;

  for (const f of input) {
    const p = f.path.replace(/^\.\//, "");
    const why = unsafePathReason(p);
    if (why) { errors.push({ path: f.path, message: `unsafe path: ${why}` }); continue; }
    if (files.has(p)) errors.push({ path: p, message: "duplicate file path" });
    files.set(p, f.data);
    bytes += f.data.byteLength;
    if (/\.(png|jpe?g|webp|gif|avif)$/i.test(p) && f.data.byteLength > LIMITS.maxImageBytesWarn) {
      warnings.push({ path: p, message: `image is ${mb(f.data.byteLength)}`, hint: "resize to ≤ 1600px and compress (WebP/JPEG)" });
    }
  }
  if (files.size > LIMITS.maxFiles) errors.push({ path: "bundle", message: `${files.size} files; max is ${LIMITS.maxFiles}` });
  if (bytes > LIMITS.maxUnzippedBytes) errors.push({ path: "bundle", message: `bundle is ${mb(bytes)} unzipped; max is ${mb(LIMITS.maxUnzippedBytes)}` });

  // manifest.json
  let manifest: ValidationResult["manifest"];
  const mBytes = files.get("manifest.json");
  if (!mBytes) {
    errors.push({ path: "manifest.json", message: "missing", hint: "every bundle needs manifest.json at its root (see get_authoring_guide)" });
  } else {
    const parsed = parseManifestText(td.decode(mBytes));
    if (parsed.error) errors.push(parsed.error);
    else {
      const r = checkManifest(parsed.manifest);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
      manifest = r.manifest;
    }
  }

  // index.html + resource scan
  const index = files.get("index.html");
  if (!index) errors.push({ path: "index.html", message: "missing", hint: "the bundle entry point must be index.html at the root" });

  const ctx: ScanCtx = { files: new Set(files.keys()), errors, warnings };
  let allText = "";
  for (const [p, data] of files) {
    if (/\.html?$/i.test(p)) {
      const t = td.decode(data);
      scanHtml(ctx, p, t);
      allText += t;
    } else if (/\.css$/i.test(p)) {
      const t = td.decode(data);
      scanCss(ctx, p, t);
      allText += t;
    } else if (/\.m?js$/i.test(p)) {
      const t = td.decode(data);
      scanJs(ctx, p, t);
      allText += t;
    }
  }

  // Coverage nudges based on the rich HTML experience.
  if (index) {
    const html = td.decode(index);
    if (!html.includes(SDK_SCRIPT_PATH)) {
      warnings.push({ path: "index.html", message: "Waypack SDK not included", hint: `add <script src="${SDK_SCRIPT_PATH}"></script> for offline maps and Navigate buttons` });
    }
    if (!/<meta[^>]+name=["']?viewport/i.test(html)) warnings.push({ path: "index.html", message: "no viewport meta tag; the page won't be mobile-friendly" });
  }
  const lower = allText.toLowerCase();
  const nudges: [RegExp, string][] = [
    [/packing/, "no packing list section detected"],
    [/budget|cost estimate/, "no budget section detected"],
    [/emergenc/, "no emergency/safety section detected"],
    [/backup|plan b|rain plan|if closed/, "no backup plans detected"],
    [/openinmaps/, "no Navigate buttons (Waypack.openInMaps) detected"],
    [/addtocalendar|data-cal/, "no Add to calendar buttons (Waypack.addToCalendar) detected"],
    [/prefers-color-scheme/, "no dark mode support (prefers-color-scheme) detected"],
    [/@media[^{]*min-width/, "no wide-screen layout (@media (min-width: …)) detected — plans must look good on iPad and desktop"],
  ];
  for (const [re, msg] of nudges) if (allText && !re.test(lower)) warnings.push({ path: "bundle", message: msg });

  return { ok: errors.length === 0, errors, warnings, manifest, stats: { files: files.size, bytes } };
}

export function validateZip(zip: Uint8Array): ValidationResult & { files: BundleFile[] } {
  const u = unzipBundle(zip);
  if (u.errors.length) return { ok: false, errors: u.errors, warnings: [], files: [] };
  const r = validateFiles(u.files);
  return { ...r, stats: { ...r.stats!, zipped_bytes: zip.byteLength }, files: u.files };
}

/** Human/agent friendly multi-line report. */
export function formatResult(r: ValidationResult): string {
  const lines: string[] = [];
  lines.push(r.ok ? "✓ Bundle is valid." : `✗ ${r.errors.length} error(s) — fix these before uploading:`);
  for (const e of r.errors) lines.push(`  ERROR   ${e.path}: ${e.message}${e.hint ? ` — ${e.hint}` : ""}`);
  if (r.warnings.length) lines.push(`${r.warnings.length} warning(s):`);
  for (const w of r.warnings) lines.push(`  warn    ${w.path}: ${w.message}${w.hint ? ` — ${w.hint}` : ""}`);
  if (r.stats) lines.push(`${r.stats.files} files, ${mb(r.stats.bytes)} unzipped${r.stats.zipped_bytes ? `, ${mb(r.stats.zipped_bytes)} zipped` : ""}.`);
  return lines.join("\n");
}
