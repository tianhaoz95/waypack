// `waypack screenshot <dir>`: phone-sized screenshots of a bundle for its store-style listing
// (manifest.listing.screenshots), saved under <dir>/listing/. Uses Playwright when it's installed
// (2x JPEG); otherwise `npx playwright screenshot` (1x PNG). The bundle is served exactly as
// `waypack preview` serves it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LISTING_LIMITS } from "@waypack/bundle-schema";
import { startPreview } from "./preview.js";

/** Playwright version used through npx when it isn't installed. */
export const PLAYWRIGHT_NPX = "playwright@1.56.1";
const VIEWPORT = { width: 390, height: 844 };

/** Sections of the base template, addressed by URL hash. */
export const DEFAULT_SECTIONS = ["today", "plan", "places", "guide"];
const CAPTIONS: Record<string, string> = { today: "What's next", plan: "Day by day", places: "Places", map: "Offline map", guide: "Guide" };

export interface ScreenshotOptions {
  dir: string;
  /** Hash routes ("plan") or paths ("index.html#plan", "extra.html"). */
  sections?: string[];
  /** Write manifest.listing.screenshots (keeps the cover and tagline). */
  manifest?: boolean;
  wait?: number;
  log?: (s: string) => void;
}

export interface Shot { section: string; file: string; bytes: number; caption: string }

interface Browser { newPage(o: object): Promise<Page>; close(): Promise<void> }
interface Page { goto(u: string, o?: object): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; screenshot(o: object): Promise<Buffer>; close(): Promise<void> }

/** Playwright from the bundle's project, the current directory, or next to the CLI; null if none. */
async function loadPlaywright(dir: string): Promise<{ chromium: { launch(o?: object): Promise<Browser> } } | null> {
  for (const base of [resolve(dir), process.cwd(), import.meta.dirname ?? process.cwd()]) {
    try {
      const path = createRequire(join(base, "noop.js")).resolve("playwright");
      // CommonJS from ESM: the exports may sit on `default`.
      const mod = (await import(pathToFileURL(path).href)) as { chromium?: unknown; default?: { chromium?: unknown } };
      const pw = (mod.chromium ? mod : mod.default) as { chromium: { launch(o?: object): Promise<Browser> } } | undefined;
      if (pw?.chromium) return pw;
    } catch {
      /* try the next place */
    }
  }
  return null;
}

const slug = (s: string) => s.replace(/^#/, "").replace(/\.html?(?=#|$)/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "home";
const target = (base: string, s: string) => (s.includes(".html") || s.includes("/") ? new URL(s.replace(/^\//, ""), base).href : `${base}#${s.replace(/^#/, "")}`);
const caption = (s: string) => CAPTIONS[s.replace(/^#/, "")] ?? s.replace(/^#/, "").replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());

export async function takeScreenshots(o: ScreenshotOptions): Promise<Shot[]> {
  const log = o.log ?? ((s: string) => console.log(s));
  const sections = o.sections?.length ? o.sections : DEFAULT_SECTIONS;
  const root = resolve(o.dir);
  const outDir = join(root, "listing");
  mkdirSync(outDir, { recursive: true });
  const preview = await startPreview({ dir: root, port: 0, host: "127.0.0.1", online: false, quiet: true });
  const shots: Shot[] = [];
  try {
    const pw = await loadPlaywright(root);
    if (pw) {
      const browser = await pw.chromium.launch();
      try {
        for (const [i, s] of sections.entries()) {
          const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "light" });
          await page.goto(target(preview.url, s), { waitUntil: "load" });
          await page.waitForTimeout(o.wait ?? 1200);
          const file = join(outDir, `screen-${i + 1}-${slug(s)}.jpg`);
          writeFileSync(file, await page.screenshot({ type: "jpeg", quality: 82 }));
          await page.close();
          shots.push({ section: s, file, bytes: statSync(file).size, caption: caption(s) });
        }
      } finally {
        await browser.close();
      }
    } else {
      log(`Playwright isn't installed here; using npx ${PLAYWRIGHT_NPX} (1x PNG).`);
      for (const [i, s] of sections.entries()) {
        const file = join(outDir, `screen-${i + 1}-${slug(s)}.png`);
        const r = spawnSync("npx", ["-y", PLAYWRIGHT_NPX, "screenshot", "--browser", "chromium", `--viewport-size=${VIEWPORT.width},${VIEWPORT.height}`, `--wait-for-timeout=${o.wait ?? 1200}`, target(preview.url, s), file], { encoding: "utf8" });
        if (r.status !== 0 || !existsSync(file)) {
          const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
          throw new Error(
            /Executable doesn't exist|install/i.test(out)
              ? `no Chromium for Playwright yet. Run once: npx -y ${PLAYWRIGHT_NPX} install chromium`
              : `screenshot of ${s} failed: ${out.trim().split("\n").slice(-3).join(" ")}`,
          );
        }
        shots.push({ section: s, file, bytes: statSync(file).size, caption: caption(s) });
      }
    }
  } finally {
    await preview.close();
  }

  for (const s of shots) {
    const rel = s.file.slice(root.length + 1).replace(/\\/g, "/");
    const big = s.bytes > LISTING_LIMITS.maxFileBytes ? "  (over 1.5 MB: compress it before uploading)" : "";
    log(`  ${rel}  ${(s.bytes / 1024).toFixed(0)} KB  "${s.caption}"${big}`);
  }

  if (o.manifest) {
    const mp = join(root, "manifest.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    m.listing = {
      ...(m.listing ?? {}),
      screenshots: shots.map((s) => ({ src: s.file.slice(root.length + 1).replace(/\\/g, "/"), caption: s.caption })),
    };
    writeFileSync(mp, JSON.stringify(m, null, 2) + "\n");
    log(`Updated manifest.listing.screenshots (${shots.length}).`);
  }
  return shots;
}
