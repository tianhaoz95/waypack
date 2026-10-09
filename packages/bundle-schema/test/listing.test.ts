import { describe, expect, it } from "vitest";
import { imageSize, listingPaths, sniffImage, validateFiles, type BundleFile } from "../src/index.js";
import { baseManifest, f, goodBundle } from "./helpers.js";

/** A PNG header (signature + IHDR) with the given size: enough for sniffing and sizing. */
function png(width: number, height: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
const bin = (path: string, data: Uint8Array): BundleFile => ({ path, data });

function withListing(listing: object, extra: BundleFile[]) {
  const m = { ...baseManifest(), listing };
  return validateFiles([...goodBundle(m), ...extra]);
}
const msgs = (r: { errors: { path: string; message: string }[] }) => r.errors.map((e) => `${e.path}: ${e.message}`);

describe("manifest.listing", () => {
  it("accepts a cover and screenshots", () => {
    const r = withListing(
      { tagline: "Snow and sequoias", cover: "listing/cover.png", screenshots: [{ src: "listing/today.png", caption: "Today" }, { src: "listing/plan.svg" }] },
      [bin("listing/cover.png", png(1600, 900)), bin("listing/today.png", png(390, 844)), f("listing/plan.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 844"><rect width="390" height="844" fill="#f3eadb"/></svg>')],
    );
    expect(msgs(r)).toEqual([]);
    expect(r.warnings.filter((w) => w.path.startsWith("listing/") || w.path.includes("listing"))).toEqual([]);
  });

  it("is optional", () => {
    expect(validateFiles(goodBundle()).ok).toBe(true);
    expect(listingPaths(baseManifest())).toEqual([]);
  });

  it("rejects missing files, wrong types, unsafe SVG and paths outside listing/", () => {
    const r = withListing(
      { cover: "listing/missing.png", screenshots: [{ src: "listing/fake.png" }, { src: "listing/x.svg" }] },
      [bin("listing/fake.png", new TextEncoder().encode("not an image")), f("listing/x.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    );
    const e = msgs(r).join("\n");
    // Missing files only warn (updates from get_trip don't carry them; publishing keeps the old copy).
    expect(r.warnings.map((w) => `${w.path}: ${w.message}`).join("\n")).toMatch(/listing\/missing\.png is not in this upload/);
    expect(e).toMatch(/listing\/fake\.png: not a PNG, JPEG, WebP or SVG/);
    expect(e).toMatch(/listing\/x\.svg: SVG contains <script>/);
    // Paths outside listing/ fail the schema.
    const outside = withListing({ screenshots: [{ src: "assets/app.png" }] }, []);
    expect(msgs(outside).join("\n")).toMatch(/listing\.screenshots\[0\]\.src/);
  });

  it("limits size and count, and warns about shape and unreferenced files", () => {
    const big = withListing({ cover: "listing/cover.png" }, [bin("listing/cover.png", png(1600, 900, 1_600_000))]);
    expect(msgs(big).join("\n")).toMatch(/listing images must be ≤ 1.5 MB/);
    const many = withListing({ screenshots: Array.from({ length: 7 }, (_, i) => ({ src: `listing/s${i}.png` })) }, Array.from({ length: 7 }, (_, i) => bin(`listing/s${i}.png`, png(390, 844))));
    expect(many.ok).toBe(false);
    const shape = withListing({ cover: "listing/cover.png", screenshots: [{ src: "listing/s.png" }] }, [bin("listing/cover.png", png(800, 800)), bin("listing/s.png", png(1600, 900)), bin("listing/extra.png", png(390, 844))]);
    const w = shape.warnings.map((x) => `${x.path}: ${x.message}`).join("\n");
    expect(w).toMatch(/cover is 800×800/);
    expect(w).toMatch(/screenshot is 1600×900/);
    expect(w).toMatch(/listing\/extra\.png: in listing\/ but not referenced/);
  });

  it("sniffs and sizes images", () => {
    expect(sniffImage(png(10, 20))).toBe("png");
    expect(imageSize(png(10, 20), "png")).toEqual({ width: 10, height: 20 });
    expect(sniffImage(new TextEncoder().encode('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>'))).toBe("svg");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
  });
});
