import type { Issue } from "./types.js";
import { SDK_PATH_PREFIX } from "./limits.js";

/** Tag → attributes that load a resource (and therefore must stay inside the bundle). */
const RESOURCE_ATTRS: Record<string, string[]> = {
  script: ["src"],
  link: ["href"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  embed: ["src"],
  object: ["data"],
  input: ["src"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
  iframe: ["src"],
  frame: ["src"],
};

const TAG_RE = /<([a-zA-Z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([^\s=/"']+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/g;

export type UrlKind = "external" | "data" | "sdk" | "absolute" | "relative" | "fragment" | "empty";

export function classifyUrl(raw: string): UrlKind {
  const u = raw.trim();
  if (!u) return "empty";
  if (u.startsWith("#")) return "fragment";
  if (/^(data|blob):/i.test(u)) return "data";
  if (u.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(u)) return "external";
  if (u.startsWith(SDK_PATH_PREFIX)) return "sdk";
  if (u.startsWith("/")) return "absolute";
  return "relative";
}

/** Resolves `ref` relative to the directory of `fromFile`; returns null if it escapes the bundle. */
export function resolveRelative(fromFile: string, ref: string): string | null {
  const clean = ref.split(/[?#]/)[0];
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* keep raw */ }
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

function parseAttrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of s.matchAll(ATTR_RE)) out.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

function srcsetUrls(v: string): string[] {
  return v.split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
}

interface ScanCtx { files: Set<string>; errors: Issue[]; warnings: Issue[] }

function checkRef(ctx: ScanCtx, file: string, where: string, url: string, opts: { allowExternal?: boolean } = {}) {
  const kind = classifyUrl(url);
  switch (kind) {
    case "external":
      if (!opts.allowExternal) {
        ctx.errors.push({
          path: file,
          message: `${where} loads external URL \`${url.slice(0, 120)}\``,
          hint: "bundles must work offline — copy the asset into assets/ and use a relative path (or inline it as data:/SVG)",
        });
      }
      return;
    case "absolute":
      ctx.errors.push({
        path: file,
        message: `${where} uses absolute path \`${url}\``,
        hint: `use a relative path (e.g. \`assets/x.css\`); only \`${SDK_PATH_PREFIX}…\` may be absolute`,
      });
      return;
    case "relative": {
      const target = resolveRelative(file, url);
      if (target === null) {
        ctx.errors.push({ path: file, message: `${where} \`${url}\` points outside the bundle` });
      } else if (target && !ctx.files.has(target) && !ctx.files.has(`${target}/index.html`)) {
        ctx.errors.push({ path: file, message: `${where} \`${url}\` not found in bundle` });
      }
      return;
    }
    default:
      return;
  }
}

function scanCss(ctx: ScanCtx, file: string, css: string) {
  for (const m of css.matchAll(CSS_URL_RE)) {
    const url = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
    checkRef(ctx, file, m[0].startsWith("@import") ? "@import" : "url()", url);
  }
}

export function scanHtml(ctx: ScanCtx, file: string, html: string) {
  // Strip comments so commented-out tags don't trip the scanner.
  const src = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of src.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);

    if (tag === "base") {
      ctx.errors.push({ path: file, message: "`<base>` is not allowed", hint: "remove it; links resolve relative to the page" });
      continue;
    }
    if (tag === "iframe" || tag === "frame") {
      ctx.errors.push({ path: file, message: `\`<${tag}>\` is not allowed (blocked by CSP frame-src 'none')` });
      continue;
    }
    if (tag === "meta" && (attrs.get("http-equiv") ?? "").toLowerCase() === "refresh") {
      ctx.errors.push({ path: file, message: "`<meta http-equiv=refresh>` is not allowed" });
      continue;
    }
    if (tag === "form") {
      const action = attrs.get("action");
      if (action && classifyUrl(action) === "external") {
        ctx.errors.push({ path: file, message: `form posts to external URL \`${action}\``, hint: "bundles are read-only; link out with <a> instead" });
      }
      continue;
    }
    if (tag === "link") {
      const rel = (attrs.get("rel") ?? "").toLowerCase();
      // Pure hint rels don't load anything we care about; still reject preconnect/dns-prefetch as pointless.
      if (/\b(preconnect|dns-prefetch)\b/.test(rel)) {
        ctx.warnings.push({ path: file, message: `<link rel="${rel}"> is useless offline — remove it` });
        continue;
      }
      if (/\b(canonical|alternate|author|license|help|search|next|prev)\b/.test(rel)) continue;
    }

    const names = RESOURCE_ATTRS[tag];
    if (names) {
      for (const name of names) {
        const v = attrs.get(name);
        if (v === undefined) continue;
        const urls = name === "srcset" ? srcsetUrls(v) : [v];
        for (const u of urls) checkRef(ctx, file, `<${tag} ${name}>`, u);
      }
    }
    const style = attrs.get("style");
    if (style) scanCss(ctx, file, style);
  }

  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) scanCss(ctx, file, m[1]);
  for (const m of src.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) scanJs(ctx, file, m[1]);
}

export function scanJs(ctx: ScanCtx, file: string, js: string) {
  const re = /\b(fetch|import|importScripts|XMLHttpRequest|EventSource|WebSocket)\s*\(?\s*\(?\s*["'`](https?:|wss?:|\/\/)[^"'`]*/g;
  for (const m of js.matchAll(re)) {
    ctx.warnings.push({
      path: file,
      message: `network call \`${m[0].slice(0, 80)}\` will be blocked offline (CSP connect-src 'self')`,
      hint: "embed the data in the bundle instead",
    });
  }
  if (/\bimport\s+[^;]*?from\s+["'](https?:|\/\/)/.test(js)) {
    ctx.errors.push({ path: file, message: "ES module imported from an external URL", hint: "vendor the module into assets/" });
  }
}

export { scanCss };
export type { ScanCtx };
