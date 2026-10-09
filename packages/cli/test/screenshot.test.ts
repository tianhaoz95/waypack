import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sniffImage, validateFiles } from "@waypack/bundle-schema";
import { readBundleDir } from "../src/files.js";
import { takeScreenshots } from "../src/screenshot.js";

const dir = mkdtempSync(join(tmpdir(), "waypack-shot-"));
cpSync(join(__dirname, "../../../skill/templates/base"), dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("waypack screenshot", () => {
  it("captures phone screenshots into listing/ and records them in the manifest", async () => {
    const shots = await takeScreenshots({ dir, sections: ["today", "plan"], manifest: true, wait: 400, log: () => undefined });
    expect(shots.map((s) => s.caption)).toEqual(["What's next", "Day by day"]);
    for (const s of shots) {
      const data = new Uint8Array(readFileSync(s.file));
      expect(sniffImage(data)).toMatch(/jpeg|png/);
      expect(data.byteLength).toBeLessThan(1_500_000);
    }
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(m.listing.screenshots.map((s: { src: string }) => s.src)).toEqual(shots.map((s) => s.file.slice(dir.length + 1)));
    const r = validateFiles(readBundleDir(dir).files);
    expect(r.errors).toEqual([]);
  }, 120_000);
});
