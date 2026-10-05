import { describe, expect, it } from "vitest";
import { handleMacDownload as route } from "../src/lib/releases.js";
import type { Env } from "../src/env.js";

const get = (env: Partial<Env>, path: string) => route(new Request(`http://127.0.0.1:8787${path}`), env as Env, path);

describe("/download/mac", () => {
  it("redirects to the latest GitHub release's DMG", () => {
    for (const p of ["/download/mac", "/download/mac/"]) {
      const r = get({}, p);
      expect(r.status).toBe(302);
      expect(r.headers.get("Location")).toBe("https://github.com/tianhaoz95/waypack/releases/latest/download/Waypack.dmg");
      expect(r.headers.get("Cache-Control")).toBe("no-store");
    }
  });
  it("honours MAC_RELEASES_REPO", () => {
    expect(get({ MAC_RELEASES_REPO: "acme/app" }, "/download/mac").headers.get("Location")).toBe("https://github.com/acme/app/releases/latest/download/Waypack.dmg");
  });
  it("404s anything else under /download/mac (no stored files behind it)", () => {
    for (const p of ["/download/mac/latest.json", "/download/mac/Waypack-1.2.0.dmg", "/download/mac/..%2F..%2Ftrips%2Fsecret%2Fbundle.zip"]) {
      expect(get({}, p).status, p).toBe(404);
    }
  });
});
