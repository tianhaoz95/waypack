import { describe, expect, it } from "vitest";
import { handleMacDownload as route } from "../src/lib/releases.js";
import type { Env } from "../src/env.js";

/** In-memory stand-in for the R2 bucket: just the calls serveStored and the download route make. */
function bucket(files: Record<string, string>) {
  const obj = (k: string, body: string) => ({
    size: body.length,
    httpEtag: `"${k}"`,
    customMetadata: {},
    body,
    json: async () => JSON.parse(body),
  });
  return {
    head: async (k: string) => (k in files ? obj(k, files[k]) : null),
    get: async (k: string, o?: { range?: { offset: number; length: number } }) =>
      k in files ? obj(k, o?.range ? files[k].slice(o.range.offset, o.range.offset + o.range.length) : files[k]) : null,
  };
}
const env = (files: Record<string, string>) => ({ BUCKET: bucket(files), PUBLIC_URL: "http://127.0.0.1:8787" }) as unknown as Env;
const get = (e: Env, path: string, headers: Record<string, string> = {}) => route(new Request(`http://127.0.0.1:8787${path}`, { headers }), e, new URL(`http://127.0.0.1:8787${path}`).pathname);

describe("/download/mac", () => {
  const files = {
    "releases/mac/latest.json": JSON.stringify({ version: "1.2.0", file: "Waypack-1.2.0.dmg" }),
    "releases/mac/Waypack-1.2.0.dmg": "DMGDATA",
    "trips/secret/bundle.zip": "PRIVATE",
  };

  it("redirects to the current versioned DMG", async () => {
    const r = await get(env(files), "/download/mac");
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/download/mac/Waypack-1.2.0.dmg");
  });
  it("serves the DMG as an immutable attachment, with ranges", async () => {
    const r = await get(env(files), "/download/mac/Waypack-1.2.0.dmg");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("application/x-apple-diskimage");
    expect(r.headers.get("Content-Disposition")).toBe('attachment; filename="Waypack-1.2.0.dmg"');
    expect(r.headers.get("Cache-Control")).toContain("immutable");
    expect(await r.text()).toBe("DMGDATA");
    const part = await get(env(files), "/download/mac/Waypack-1.2.0.dmg", { Range: "bytes=0-2" });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("DMG");
  });
  it("404s before the first release, for unknown versions, and never reaches other keys", async () => {
    expect((await get(env({}), "/download/mac")).status).toBe(404);
    expect((await get(env(files), "/download/mac/Waypack-9.9.9.dmg")).status).toBe(404);
    for (const p of ["/download/mac/..%2F..%2Ftrips%2Fsecret%2Fbundle.zip", "/download/mac/x.zip", "/download/mac/Waypack-1.2.0.dmg/../../trips/secret/bundle.zip"]) {
      const r = await get(env(files), p);
      expect(r.status, p).toBe(404);
      expect(await r.text()).not.toContain("PRIVATE");
    }
  });
});
