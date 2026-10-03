import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPreview } from "../src/preview.js";

const example = resolve(__dirname, "../../../examples/sequoia-winter");
const fixture = resolve(__dirname, "../../trip-sdk/test/fixtures/giant-forest-z14.pmtiles");
let srv: Awaited<ReturnType<typeof startPreview>>;
let base: string;

beforeAll(async () => {
  srv = await startPreview({ dir: example, port: 0, host: "127.0.0.1", tiles: fixture, online: false, quiet: true });
  base = srv.url.replace(/\/t\/local\/$/, "");
});
afterAll(() => srv.close());

describe("waypack preview", () => {
  it("serves bundle HTML with the runtime CSP", async () => {
    const r = await fetch(`${base}/t/local/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(await r.text()).toContain("/__waypack/sdk/v1/waypack.js");
  });
  it("serves the SDK and glyphs", async () => {
    expect((await fetch(`${base}/__waypack/sdk/v1/waypack.js`)).status).toBe(200);
    expect((await fetch(`${base}/__waypack/sdk/v1/assets/fonts/Noto%20Sans%20Regular/0-255.pbf`)).status).toBe(200);
  });
  it("lists tiles and supports Range", async () => {
    const idx = await (await fetch(`${base}/__waypack/tiles/local/index.json`)).json();
    expect(idx).toEqual({ extracts: [{ url: "/__waypack/tiles/local/extract.pmtiles" }], online: null });
    const r = await fetch(`${base}/__waypack/tiles/local/extract.pmtiles`, { headers: { Range: "bytes=0-6" } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe("PMTiles");
    expect((await fetch(`${base}/__waypack/tiles/local/extract.pmtiles`, { headers: { Range: "bytes=999999999-" } })).status).toBe(416);
  });
  it("blocks path traversal", async () => {
    expect((await fetch(`${base}/t/local/%2e%2e/%2e%2e/package.json`)).status).toBe(404);
    expect((await fetch(`${base}/__waypack/sdk/v1/%2e%2e/%2e%2e/package.json`)).status).toBe(404);
  });
});

describe("waypack cli", () => {
  const cli = resolve(__dirname, "../dist/cli.js");
  it("validates the example and zips it", () => {
    expect(execFileSync("node", [cli, "validate", example]).toString()).toContain("Bundle is valid");
    const dir = mkdtempSync(join(tmpdir(), "wp-"));
    execFileSync("node", [cli, "zip", example, "-o", join(dir, "b.zip")]);
    expect(execFileSync("node", [cli, "validate", join(dir, "b.zip")]).toString()).toContain("Bundle is valid");
    rmSync(dir, { recursive: true });
  });
  it("init creates a valid bundle", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "wp-")), "trip");
    execFileSync("node", [cli, "init", dir, "--title", "My Trip"]);
    expect(existsSync(join(dir, "index.html"))).toBe(true);
    expect(execFileSync("node", [cli, "validate", dir]).toString()).toContain("Bundle is valid");
  });
  it("exits 1 on invalid bundles", () => {
    let code = 0;
    try { execFileSync("node", [cli, "validate", __dirname], { stdio: "pipe" }); } catch (e) { code = (e as { status: number }).status; }
    expect(code).toBe(1);
  });
});
