import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { Db } from "../src/lib/db.js";
import {
  handlePreviewHost,
  injectLive,
  isPreviewHost,
  limitErrors,
  mergeFiles,
  previewOrigin,
  pushPreview,
  type PreviewFileRef,
  type PreviewRow,
} from "../src/lib/previews.js";

// ---- in-memory stand-ins: just enough PostgREST and R2 for previews

type Row = Record<string, unknown>;
function match(row: Row, query: string): boolean {
  for (const part of query.split("&")) {
    const [k, v] = part.split(/=(.*)/s);
    if (["select", "order", "limit"].includes(k)) continue;
    const val = decodeURIComponent(v);
    const cell = row[k];
    if (val.startsWith("eq.") && String(cell) !== val.slice(3)) return false;
    if (val.startsWith("neq.") && String(cell) === val.slice(4)) return false;
    if (val.startsWith("gt.") && !(String(cell) > val.slice(3))) return false;
    if (val.startsWith("lt.") && !(String(cell) < val.slice(3))) return false;
    if (val === "is.null" && cell != null) return false;
  }
  return true;
}
class FakeDb {
  tables: Record<string, Row[]> = { trip_previews: [], trips: [] };
  failNextUpdate = 0;
  async select<T>(t: string, q = "") { return (this.tables[t] ?? []).filter((r) => match(r, q)).map((r) => structuredClone(r)) as T[]; }
  async one<T>(t: string, q: string) { return ((await this.select<T>(t, q))[0] ?? null) as T | null; }
  async count(t: string, q: string) { return (await this.select(t, q)).length; }
  async insert<T>(t: string, row: Row) {
    const r = { id: crypto.randomUUID(), files: {}, rev: 0, bytes: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), trip_id: null, title: null, validation: null, published_version: null, ...row };
    (this.tables[t] ??= []).push(r);
    return [structuredClone(r)] as T[];
  }
  async update<T>(t: string, q: string, patch: Row) {
    if (t === "trip_previews" && this.failNextUpdate > 0) {
      // Simulate another push landing first: bump rev under us.
      this.failNextUpdate--;
      for (const r of this.tables[t].filter((r) => match(r, q.replace(/&rev=eq\.\d+/, "")))) r.rev = (r.rev as number) + 1;
      return [] as T[];
    }
    const rows = (this.tables[t] ?? []).filter((r) => match(r, q));
    for (const r of rows) Object.assign(r, structuredClone(patch));
    return rows.map((r) => structuredClone(r)) as T[];
  }
  async delete(t: string, q: string) { this.tables[t] = (this.tables[t] ?? []).filter((r) => !match(r, q)); return null; }
}
class FakeBucket {
  objects = new Map<string, Uint8Array>();
  async put(k: string, v: Uint8Array) { this.objects.set(k, new Uint8Array(v)); }
  async get(k: string) {
    const v = this.objects.get(k);
    return v ? { body: v, arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null;
  }
  uploaded = new Map<string, Date>();
  /** Pretend everything was uploaded long ago unless a test says otherwise. */
  age = 60 * 60 * 1000;
  async list({ prefix }: { prefix: string }) {
    return { objects: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: this.uploaded.get(key) ?? new Date(Date.now() - this.age) })), truncated: false };
  }
  async delete(k: string | string[]) { for (const x of Array.isArray(k) ? k : [k]) this.objects.delete(x); }
}

const enc = (s: string) => new TextEncoder().encode(s);
const MANIFEST = JSON.stringify({ title: "Test Trip" });
function setup(previewUrl: string | null = "http://localhost:8787") {
  const db = new FakeDb();
  const bucket = new FakeBucket();
  const env = { PUBLIC_URL: "http://127.0.0.1:8787", PREVIEW_URL: previewUrl ?? undefined, BUCKET: bucket, SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", PLANET_URL: "https://example.com/planet.pmtiles" } as unknown as Env;
  return { db, bucket, env, dbx: db as unknown as Db };
}
const ref = (sha: string, bytes = 1): PreviewFileRef => ({ sha256: sha, bytes, type: "text/plain" });

describe("preview origin", () => {
  it("must be configured and on a different host than the site", () => {
    expect(previewOrigin(setup(null).env)).toBeNull();
    expect(previewOrigin(setup("http://127.0.0.1:9999").env)).toBeNull(); // same host, other port: same cookies
    expect(previewOrigin(setup("https://waypackpreview.com/").env)).toBe("https://waypackpreview.com");
    const { env } = setup();
    expect(isPreviewHost(new Request("http://localhost:8787/t/x/"), env)).toBe(true);
    expect(isPreviewHost(new Request("http://127.0.0.1:8787/t/x/"), env)).toBe(false);
  });
});

describe("pure helpers", () => {
  it("merges, deletes and replaces files", () => {
    const cur = { "a.html": ref("1"), "b.css": ref("2") };
    expect(mergeFiles(cur, [{ path: "a.html", ref: ref("3") }], [], false)).toEqual({ "a.html": ref("3"), "b.css": ref("2") });
    expect(mergeFiles(cur, [], ["b.css"], false)).toEqual({ "a.html": ref("1") });
    expect(mergeFiles(cur, [{ path: "c.js", ref: ref("4") }], [], true)).toEqual({ "c.js": ref("4") });
  });
  it("enforces file count and size", () => {
    expect(limitErrors({ a: ref("1", 26 * 1048576) })[0]).toMatch(/25 MB/);
    const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`f${i}`, ref(String(i))]));
    expect(limitErrors(many)[0]).toMatch(/2000 files/);
  });
  it("injects the live script before the last </body>", () => {
    expect(injectLive("<p></BODY></html>", 4)).toBe('<p><script src="/__waypack/preview/live.js" data-rev="4"></script></BODY></html>');
    expect(injectLive("<p>no body", 1)).toMatch(/<p>no body<script/);
  });
});

describe("pushPreview", () => {
  const user = "11111111-1111-4111-8111-111111111111";

  it("creates, merges, and only re-uploads changed blobs", async () => {
    const { env, dbx, bucket } = setup();
    const a = await pushPreview(env, dbx, user, { files: [{ path: "manifest.json", data: enc(MANIFEST) }, { path: "index.html", data: enc("<body>1</body>") }] });
    expect(a.rev).toBe(1);
    expect(a.title).toBe("Test Trip");
    expect(a.preview_url).toMatch(/^http:\/\/localhost:8787\/t\/[A-Za-z0-9_-]{32}\/$/);
    expect(bucket.objects.size).toBe(2);
    const b = await pushPreview(env, dbx, user, { previewId: a.preview_id, files: [{ path: "index.html", data: enc("<body>2</body>") }] });
    expect(b.rev).toBe(2);
    expect(b.files).toBe(2);
    expect(bucket.objects.size).toBe(3); // old index blob kept for viewers still on rev 1
    const c = await pushPreview(env, dbx, user, { previewId: a.preview_id, files: [{ path: "index.html", data: enc("<body>3</body>") }] });
    expect(c.rev).toBe(3);
    expect(bucket.objects.size).toBe(3); // rev-1 blob collected: only current + previous remain
  });

  it("never collects blobs a racing push may have just uploaded", async () => {
    const { env, dbx, bucket } = setup();
    bucket.age = 0; // everything is fresh
    const a = await pushPreview(env, dbx, user, { files: [{ path: "index.html", data: enc("<body>1</body>") }] });
    await pushPreview(env, dbx, user, { previewId: a.preview_id, files: [{ path: "index.html", data: enc("<body>2</body>") }] });
    await pushPreview(env, dbx, user, { previewId: a.preview_id, files: [{ path: "index.html", data: enc("<body>3</body>") }] });
    expect(bucket.objects.size).toBe(3); // the rev-1 blob is unreferenced but too new to delete
  });

  it("merges onto a concurrent push instead of overwriting it", async () => {
    const { env, dbx, db } = setup();
    const a = await pushPreview(env, dbx, user, { files: [{ path: "index.html", data: enc("<body>a</body>") }] });
    db.failNextUpdate = 1;
    const b = await pushPreview(env, dbx, user, { previewId: a.preview_id, files: [{ path: "x.css", data: enc("x") }] });
    expect(b.rev).toBe(3); // 1 → (someone else) 2 → ours 3
    expect(b.files).toBe(2);
  });

  it("rejects unsafe paths, empty pushes, oversize drafts and missing config", async () => {
    const { env, dbx } = setup();
    await expect(pushPreview(env, dbx, user, { files: [{ path: "../x", data: enc("x") }] })).rejects.toThrow(/\.\./);
    await expect(pushPreview(env, dbx, user, { files: [] })).rejects.toThrow(/Nothing to push/);
    await expect(pushPreview(env, dbx, user, { files: [{ path: "big.bin", data: new Uint8Array(26 * 1048576) }] })).rejects.toThrow(/25 MB/);
    const off = setup(null);
    await expect(pushPreview(off.env, off.dbx, user, { files: [{ path: "a", data: enc("a") }] })).rejects.toThrow(/PREVIEW_URL/);
  });

  it("caps open previews per account", async () => {
    const { env, dbx } = setup();
    for (let i = 0; i < 10; i++) await pushPreview(env, dbx, user, { files: [{ path: "a.txt", data: enc(String(i)) }] });
    await expect(pushPreview(env, dbx, user, { files: [{ path: "a.txt", data: enc("x") }] })).rejects.toThrow(/open previews/);
  });
});

describe("preview host", () => {
  const user = "22222222-2222-4222-8222-222222222222";
  async function withPreview() {
    const s = setup();
    const r = await pushPreview(s.env, s.dbx, user, {
      files: [
        { path: "index.html", data: enc("<html><body><a href='https://example.com'>x</a></body></html>") },
        { path: "assets/app.js", data: enc("1") },
      ],
    });
    const token = r.preview_url.split("/t/")[1].replace("/", "");
    const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
      handlePreviewHost(new Request(`http://localhost:8787${path}`, { headers, method }), s.env, s.dbx);
    return { ...s, token, get };
  }

  it("serves pages with the live script, the app CSP and no referrer", async () => {
    const { token, get } = await withPreview();
    const res = await get(`/t/${token}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('live.js" data-rev="1"></script></body>');
    expect(res.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const js = await get(`/t/${token}/assets/app.js`);
    expect(js.headers.get("Content-Type")).toMatch(/javascript/);
    expect((await get(`/t/${token}/assets/app.js`, { "If-None-Match": js.headers.get("ETag")! })).status).toBe(304);
  });

  it("reports state, and 404s unknown tokens, missing files and anything that isn't a preview", async () => {
    const { token, get } = await withPreview();
    expect(await (await get(`/__waypack/preview/${token}/state`)).json()).toMatchObject({ rev: 1 });
    expect((await get(`/t/${"x".repeat(32)}/`)).status).toBe(404);
    expect((await get(`/t/${token}/nope.js`)).status).toBe(404);
    expect((await get(`/t/${token}/..%2F..%2Fsecret`)).status).toBe(404);
    expect((await get("/api/me")).status).toBe(404);
    expect((await get("/mcp", {}, "POST")).status).toBe(405);
    expect((await get(`/t/${token}`)).headers.get("Location")).toBe(`/t/${token}/`);
  });

  it("shows a self-refreshing waiting page before index.html exists", async () => {
    const s = setup();
    const r = await pushPreview(s.env, s.dbx, user, { files: [{ path: "manifest.json", data: enc(MANIFEST) }] });
    const res = await handlePreviewHost(new Request(r.preview_url), s.env, s.dbx);
    expect(await res.text()).toMatch(/hasn't pushed the page yet[\s\S]*live\.js/);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });

  it("expired previews are gone", async () => {
    const { token, get, db } = await withPreview();
    (db.tables.trip_previews[0] as unknown as PreviewRow).expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await get(`/t/${token}/`)).status).toBe(404);
    expect((await get(`/__waypack/preview/${token}/state`)).status).toBe(404);
    expect((await get(`/__waypack/tiles/${token}/index.json`)).status).toBe(404);
  });
});
