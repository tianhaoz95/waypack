import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { validateFiles, validateZip, zipBundle, bboxAreaKm2, simplifyLine, decodeInlineFiles, formatResult } from "../src/index.js";
import { baseManifest, f, goodBundle, goodHtml } from "./helpers.js";

const msgs = (r: { errors: { path: string; message: string }[] }) => r.errors.map((e) => `${e.path}: ${e.message}`);

describe("validateFiles", () => {
  it("accepts a good bundle with no warnings", () => {
    const r = validateFiles(goodBundle());
    expect(msgs(r)).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.manifest?.title).toBe("Test Trip");
  });

  it("reports missing manifest and index", () => {
    const r = validateFiles([f("x.txt", "hi")]);
    expect(msgs(r)).toEqual(expect.arrayContaining(["manifest.json: missing", "index.html: missing"]));
  });

  it("reports invalid JSON", () => {
    const r = validateFiles([f("manifest.json", "{"), f("index.html", goodHtml)]);
    expect(r.errors[0].message).toMatch(/not valid JSON/);
  });

  it("reports missing required fields with geocode hint", () => {
    const m = baseManifest() as any;
    delete m.places[1].lat;
    const r = validateFiles(goodBundle(m));
    const e = r.errors.find((x) => x.path === "places[1].lat")!;
    expect(e.message).toBe("missing");
    expect(e.hint).toMatch(/geocode/);
  });

  it("reports bad enums", () => {
    const m = baseManifest() as any;
    m.places[0].category = "hotel";
    m.routes[0].mode = "car";
    const r = validateFiles(goodBundle(m));
    expect(msgs(r).join("\n")).toMatch(/places\[0\]\.category: must be one of/);
    expect(msgs(r).join("\n")).toMatch(/routes\[0\]\.mode: must be one of/);
  });

  it("checks referential integrity", () => {
    const m = baseManifest();
    m.routes[0].to = "nope";
    m.days[0].items[0].place_id = "ghost";
    m.days[0].items[0].route_id = "ghost-route";
    m.emergency!.places = ["hospital"];
    const r = validateFiles(goodBundle(m));
    expect(msgs(r)).toEqual(expect.arrayContaining([
      "routes[0].to: unknown place id `nope`",
      "days[0].items[0].place_id: unknown place id `ghost`",
      "days[0].items[0].route_id: unknown route id `ghost-route`",
      "emergency.places[0]: unknown place id `hospital`",
    ]));
  });

  it("checks dates and duplicate ids", () => {
    const m = baseManifest();
    m.days.push({ date: "2026-12-30", items: [] });
    m.places.push({ ...m.places[0] });
    m.end_date = "2026-12-23";
    const r = validateFiles(goodBundle(m));
    const all = msgs(r).join("\n");
    expect(all).toMatch(/end_date is before start_date/);
    expect(all).toMatch(/duplicate place id `lodge`/);
    expect(all).toMatch(/2026-12-30 is outside/);
  });

  it("validates theme colors and scene values", () => {
    const m = baseManifest() as any;
    m.theme = { accent: "blue", scene: { water: "swamp" } };
    const all = msgs(validateFiles(goodBundle(m))).join("\n");
    expect(all).toMatch(/theme\.accent/);
    expect(all).toMatch(/theme\.scene\.water: must be one of/);
  });

  it("rejects impossible dates and bad time zones", () => {
    const m = baseManifest();
    m.end_date = "2026-02-30";
    expect(msgs(validateFiles(goodBundle(m))).join("\n")).toMatch(/not a real calendar date/);
    const m2 = baseManifest();
    m2.timezone = "Mars/Olympus";
    expect(msgs(validateFiles(goodBundle(m2))).join("\n")).toMatch(/unknown time zone/);
  });

  it("warns on unsorted items and places outside the bbox with a suggestion", () => {
    const m = baseManifest();
    m.days[0].items.push({ time: "08:00", title: "Early" });
    m.places.push({ id: "far", name: "Far", category: "sight", lat: 37.0, lon: -119.2 });
    const r = validateFiles(goodBundle(m));
    expect(r.ok).toBe(true);
    const w = r.warnings.map((x) => x.message).join("\n");
    expect(w).toMatch(/not sorted by time/);
    expect(w).toMatch(/outside every map area/);
    expect(r.warnings.find((x) => x.path === "map.bbox")?.hint).toMatch(/expand to \[/);
  });

  it("enforces bbox area and route coordinate limits", () => {
    const m = baseManifest();
    m.map.bbox = [-124, 32, -114, 42];
    m.routes[0].geometry = { type: "LineString", coordinates: Array.from({ length: 5001 }, (_, i) => [-118.9 + i * 1e-5, 36.45] as [number, number]) };
    const r = validateFiles(goodBundle(m));
    const all = msgs(r).join("\n");
    expect(all).toMatch(/map\.bbox: area is ~[\d,]+ km²; max is 40,000/);
    expect(all).toMatch(/5001 coordinates; max is 5000/);
  });

  it("rejects more than 4 map areas and bad zoom", () => {
    const m = baseManifest();
    m.map.max_zoom = 18;
    m.map.extra_areas = Array.from({ length: 4 }, () => ({ bbox: [-118.9, 36.4, -118.8, 36.5] as [number, number, number, number] }));
    const r = validateFiles(goodBundle(m));
    expect(msgs(r).join("\n")).toMatch(/map\.max_zoom/);
    expect(msgs(r).join("\n")).toMatch(/map\.extra_areas/);
  });

  it("rejects external resources, absolute paths, base, iframes", () => {
    const html = `<!doctype html><html><head><meta name=viewport content=x>
      <script src="https://cdn.example.com/x.js"></script>
      <link rel=stylesheet href="//fonts.example.com/a.css">
      <link rel="preconnect" href="https://fonts.gstatic.com">
      <base href="/">
      </head><body><img srcset="assets/a.png 1x, https://x.com/b.png 2x"><img src="/abs.png">
      <iframe src="https://youtube.com"></iframe><img src="missing.png">
      <div style="background:url('https://x.com/bg.png')"></div>
      <a href="https://ok.example.com">ok</a><a href="tel:911">call</a>
      <!-- <script src="https://commented.out/x.js"></script> -->
      </body></html>`;
    const r = validateFiles([...goodBundle().filter((x) => x.path !== "index.html"), f("index.html", html), f("assets/a.png", "x")]);
    const all = msgs(r).join("\n");
    expect(all).toMatch(/<script src> loads external URL `https:\/\/cdn\.example\.com\/x\.js`/);
    expect(all).toMatch(/<link href> loads external URL `\/\/fonts/);
    expect(all).toMatch(/<img srcset> loads external URL `https:\/\/x\.com\/b\.png`/);
    expect(all).toMatch(/absolute path `\/abs\.png`/);
    expect(all).toMatch(/`<base>` is not allowed/);
    expect(all).toMatch(/`<iframe>` is not allowed/);
    expect(all).toMatch(/`missing\.png` not found/);
    expect(all).toMatch(/url\(\) loads external URL `https:\/\/x\.com\/bg\.png`/);
    expect(all).not.toMatch(/commented\.out/);
    expect(all).not.toMatch(/ok\.example/);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/preconnect/);
  });

  it("rejects external urls in css files and module imports", () => {
    const files = goodBundle().map((x) =>
      x.path === "assets/style.css" ? f(x.path, "@import 'https://x.com/a.css'; @media (prefers-color-scheme: dark){}") :
      x.path === "assets/app.js" ? f(x.path, "import x from 'https://esm.sh/lodash'; fetch('https://api.x.com/y')") : x);
    const r = validateFiles(files);
    expect(msgs(r).join("\n")).toMatch(/@import loads external URL/);
    expect(msgs(r).join("\n")).toMatch(/ES module imported from an external URL/);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/will be blocked offline/);
  });

  it("rejects path traversal in file paths", () => {
    const r = validateFiles([...goodBundle(), f("../evil.js", "x"), f("/etc/passwd", "x"), f("a\\b", "x")]);
    expect(msgs(r)).toEqual(expect.arrayContaining([
      "../evil.js: unsafe path: `..` segment",
      "/etc/passwd: unsafe path: absolute path",
      "a\\b: unsafe path: backslash in path",
    ]));
  });

  it("warns on coverage gaps", () => {
    const m = baseManifest();
    delete m.live_checks;
    delete m.emergency;
    const r = validateFiles(goodBundle(m, "<html><body>hi</body></html>"));
    const w = r.warnings.map((x) => `${x.path}: ${x.message}`).join("\n");
    expect(w).toMatch(/live_checks: no live checks/);
    expect(w).toMatch(/emergency: no emergency numbers/);
    expect(w).toMatch(/packing list/);
    expect(w).toMatch(/SDK not included/);
    expect(w).toMatch(/no top bar \(data-waypack-bar\)/);
    expect(w).toMatch(/Add to calendar/);
  });
});

describe("validateZip", () => {
  it("round-trips a bundle via zipBundle", () => {
    const r = validateZip(zipBundle(goodBundle()));
    expect(msgs(r)).toEqual([]);
    expect(r.stats?.zipped_bytes).toBeGreaterThan(0);
  });

  it("strips a single top-level folder", () => {
    const z: Record<string, Uint8Array> = {};
    for (const x of goodBundle()) z[`my-trip/${x.path}`] = x.data;
    z["__MACOSX/._junk"] = strToU8("x");
    const r = validateZip(zipSync(z));
    expect(msgs(r)).toEqual([]);
    expect(r.files.map((x) => x.path)).toContain("manifest.json");
  });

  it("rejects traversal entries", () => {
    const r = validateZip(zipSync({ "../../evil.sh": strToU8("x"), "manifest.json": strToU8("{}") }));
    expect(msgs(r)).toContain("../../evil.sh: unsafe zip entry: `..` segment");
  });

  it("rejects symlinks", () => {
    const zip = zipSync({ "manifest.json": strToU8("{}"), "link": [strToU8("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] });
    const r = validateZip(zip);
    expect(msgs(r)).toContain("link: symlinks are not allowed");
  });

  it("rejects oversize zips and non-zips", () => {
    expect(msgs(validateZip(new Uint8Array(26 * 1024 * 1024)))[0]).toMatch(/max is 25\.0 MB/);
    expect(msgs(validateZip(strToU8("hello")))[0]).toMatch(/not a zip/);
  });

  it("rejects too many files", () => {
    const z: Record<string, Uint8Array> = {};
    for (let i = 0; i < 2001; i++) z[`a/${i}.txt`] = strToU8("x");
    z["manifest.json"] = strToU8("{}");
    expect(msgs(validateZip(zipSync(z))).join()).toMatch(/2002 files; max is 2000/);
  });
});

describe("helpers", () => {
  it("computes bbox area", () => {
    const a = bboxAreaKm2([-118.95, 36.4, -118.55, 36.8]);
    expect(a).toBeGreaterThan(1500);
    expect(a).toBeLessThan(1700);
  });

  it("simplifies lines to the max", () => {
    const line = Array.from({ length: 20000 }, (_, i) => [i * 1e-4, Math.sin(i / 50) * 0.01] as [number, number]);
    const s = simplifyLine(line, 5000);
    expect(s.length).toBeLessThanOrEqual(5000);
    expect(s[0]).toEqual(line[0]);
    expect(s.at(-1)).toEqual(line.at(-1));
  });

  it("decodes inline files", () => {
    const r = decodeInlineFiles([{ path: "a.txt", content: "hé" }, { path: "b.bin", content: "AAEC", encoding: "base64" }, { path: "c", content: "x", encoding: "latin1" as any }]);
    expect(r.files[1].data).toEqual(new Uint8Array([0, 1, 2]));
    expect(r.errors[0].message).toMatch(/unknown encoding/);
  });

  it("formats results", () => {
    const t = formatResult(validateFiles([f("x", "y")]));
    expect(t).toMatch(/ERROR   manifest.json: missing/);
  });
});
