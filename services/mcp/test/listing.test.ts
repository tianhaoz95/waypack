import { describe, expect, it } from "vitest";
import { unzipBundle, type BundleFile } from "@waypack/bundle-schema";
import type { Env } from "../src/env.js";
import type { Db } from "../src/lib/db.js";
import { portalListing, publishBundle, tripStatus } from "../src/lib/pipeline.js";
import { keys, serveStored } from "../src/lib/storage.js";

// ---- in-memory stand-ins: just enough PostgREST and R2 for publishing
type Row = Record<string, unknown>;
const match = (row: Row, q: string) =>
  q.split("&").every((part) => {
    const [k, v] = part.split(/=(.*)/s);
    if (["select", "order", "limit", "or"].includes(k)) return true;
    const val = decodeURIComponent(v ?? "");
    if (val.startsWith("eq.")) return String(row[k]) === val.slice(3);
    if (val === "is.null") return row[k] == null;
    return true;
  });
class FakeDb {
  tables: Record<string, Row[]> = {};
  async select<T>(t: string, q = "") { return (this.tables[t] ?? []).filter((r) => match(r, q)).map((r) => structuredClone(r)) as T[]; }
  async one<T>(t: string, q: string) { return ((await this.select<T>(t, q))[0] ?? null) as T | null; }
  async insert<T>(t: string, row: Row) {
    const r = { id: crypto.randomUUID(), current_version: 0, deleted_at: null, ...row };
    (this.tables[t] ??= []).push(r);
    return [structuredClone(r)] as T[];
  }
  async update<T>(t: string, q: string, patch: Row) {
    const rows = (this.tables[t] ?? []).filter((r) => match(r, q));
    for (const r of rows) Object.assign(r, structuredClone(patch));
    return rows as T[];
  }
}
class FakeBucket {
  objects = new Map<string, { data: Uint8Array; type?: string }>();
  async put(k: string, v: Uint8Array | string, o?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(k, { data: typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v), type: o?.httpMetadata?.contentType });
  }
  async head(k: string) { const o = this.objects.get(k); return o ? { size: o.data.byteLength, httpEtag: '"e"' } : null; }
  async get(k: string) { const o = this.objects.get(k); return o ? { body: o.data, arrayBuffer: async () => o.data.slice().buffer } : null; }
}

/** A PNG header with the given size (enough for the validator's sniffing and sizing). */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

const te = new TextEncoder();
const text = (path: string, t: string): BundleFile => ({ path, data: te.encode(t) });

/** A small valid bundle (future dates) with a listing: a raster cover, a screenshot and an SVG screenshot. */
function bundle(): BundleFile[] {
  const manifest = {
    schema_version: 1,
    sdk_version: "1",
    trip_id: null,
    title: "Yosemite Valley Overnight",
    summary: "An easy overnight in the valley.",
    timezone: "America/Los_Angeles",
    start_date: "2099-06-12",
    end_date: "2099-06-13",
    map: { bbox: [-119.7, 37.7, -119.5, 37.8], max_zoom: 15, extra_areas: [] },
    places: [
      { id: "lodge", name: "Yosemite Valley Lodge", category: "lodging", lat: 37.7425, lon: -119.6025 },
      { id: "falls", name: "Lower Yosemite Fall", category: "trailhead", lat: 37.7465, lon: -119.5968 },
    ],
    routes: [],
    days: [
      { date: "2099-06-12", items: [{ time: "15:00", title: "Check in", place_id: "lodge", kind: "lodging" }] },
      { date: "2099-06-13", items: [{ time: "09:00", title: "Walk to the falls", place_id: "falls", kind: "activity" }] },
    ],
    live_checks: [{ label: "Conditions", url: "https://www.nps.gov/yose/" }],
    emergency: { numbers: [{ label: "Emergency", value: "911" }], places: [] },
    theme: { preset: "lake-summer", accent: "#2F7F9E" },
    listing: {
      tagline: "Granite walls and a valley lodge",
      cover: "listing/cover.png",
      screenshots: [{ src: "listing/today.png", caption: "Today" }, { src: "listing/plan.svg" }],
    },
  };
  return [
    text("manifest.json", JSON.stringify(manifest)),
    text("index.html", `<!doctype html><html><head><meta name="viewport" content="width=device-width"><script src="/__waypack/sdk/v1/waypack.js"></script></head>
<body><header data-waypack-bar><h1>Trip</h1></header><h2>Packing</h2><h2>Budget</h2><h2>Emergency</h2><h2>Backup plan</h2>
<button onclick="Waypack.openInMaps('lodge')">Navigate</button><button onclick="Waypack.addToCalendar({date:'2099-06-12',index:0})">Add to calendar</button></body></html>`),
    { path: "listing/cover.png", data: png(1600, 900) },
    { path: "listing/today.png", data: png(390, 844) },
    text("listing/plan.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 844"><rect width="390" height="844" fill="#f3eadb"/></svg>'),
  ];
}

function setup() {
  const db = new FakeDb();
  const bucket = new FakeBucket();
  const env = { PUBLIC_URL: "http://127.0.0.1:8787", BUCKET: bucket, SIGNING_SECRET: "test-secret", MAP_EXTRACTS: "device" } as unknown as Env;
  return { db, bucket, env, dbx: db as unknown as Db };
}

describe("store listing on publish", () => {
  it("stores listing media next to the bundle, never inside it", async () => {
    const { bucket, env, dbx } = setup();
    const r = await publishBundle(env, dbx, "u1", { files: bundle() });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const base = `bundles/u1/${r.trip_id}/v1`;
    expect(bucket.objects.get(`${base}/listing/cover.png`)?.type).toBe("image/png");
    expect(bucket.objects.get(`${base}/listing/today.png`)?.type).toBe("image/png");
    expect(bucket.objects.get(`${base}/listing/plan.svg`)?.type).toBe("image/svg+xml");
    // The app's download has no listing files.
    const zipped = unzipBundle(bucket.objects.get(keys.bundle("u1", r.trip_id, 1))!.data).files.map((f) => f.path);
    expect(zipped).toContain("index.html");
    expect(zipped.filter((p) => p.startsWith("listing/"))).toEqual([]);
    // With no cover_image, the raster listing cover doubles as the app's card cover.
    expect(bucket.objects.has(keys.cover("u1", r.trip_id, 1, "png"))).toBe(true);
  });

  it("keeps the previous version's listing files when an update doesn't include them", async () => {
    const { bucket, env, dbx, db } = setup();
    const first = await publishBundle(env, dbx, "u1", { files: bundle() });
    if (!first.ok) throw new Error(first.message);
    // An update built from get_trip: same manifest (with trip_id), no listing files, one new screenshot ref without a file.
    const files = bundle().filter((f) => !f.path.startsWith("listing/"));
    const m = JSON.parse(new TextDecoder().decode(files[0].data));
    m.trip_id = first.trip_id;
    m.listing.screenshots.push({ src: "listing/gone.png" });
    files[0] = text("manifest.json", JSON.stringify(m));
    const r = await publishBundle(env, dbx, "u1", { files });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe(2);
    const v2 = `bundles/u1/${r.trip_id}/v2`;
    expect(bucket.objects.has(`${v2}/listing/cover.png`)).toBe(true);
    expect(bucket.objects.has(`${v2}/listing/today.png`)).toBe(true);
    expect(bucket.objects.has(keys.cover("u1", r.trip_id, 2, "png"))).toBe(true);
    const saved = (db.tables.trip_versions.find((x) => x.version === 2)!.manifest as { listing: { screenshots: { src: string }[] } }).listing;
    expect(saved.screenshots.map((x) => x.src)).toEqual(["listing/today.png", "listing/plan.svg"]); // the dangling one is dropped
  });

  it("gives the portal signed listing URLs and a manifest digest", async () => {
    const { env, dbx } = setup();
    const r = await publishBundle(env, dbx, "u1", { files: bundle() });
    if (!r.ok) throw new Error(r.message);
    const s = await tripStatus(env, dbx, "u1", r.trip_id, { portal: true });
    const l = s!.listing!;
    expect(l.tagline).toBe("Granite walls and a valley lodge");
    expect(l.cover_url).toMatch(new RegExp(`/files/bundles/u1/${r.trip_id}/v1/listing/cover\\.png\\?`));
    expect(l.screenshots.map((x) => x.caption)).toEqual(["Today", null]);
    expect(l.days).toBeGreaterThan(0);
    expect(l.places).toBeGreaterThan(0);
    // Agents' status calls don't carry portal media.
    expect((await tripStatus(env, dbx, "u1", r.trip_id))!.listing).toBeUndefined();
  });

  it("portal listing without media is just the digest", async () => {
    const { env } = setup();
    const l = await portalListing(env, "u1", "t1", 1, { title: "x", days: [], places: [], routes: [], theme: { accent: "#C2562D" } } as never);
    expect(l.cover_url).toBeNull();
    expect(l.screenshots).toEqual([]);
    expect(l.theme.accent).toBe("#C2562D");
  });

  it("serves listing SVGs so they can't run anything if opened directly", async () => {
    const { bucket, env } = setup();
    await bucket.put("bundles/u1/t1/v1/listing/a.svg", "<svg/>");
    const res = await serveStored(env, "bundles/u1/t1/v1/listing/a.svg", new Request("http://x/"));
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'none'/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
