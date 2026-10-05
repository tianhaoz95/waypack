import type { Env } from "../env.js";

export interface Planet { url: string; build: string }

/**
 * Resolves the basemap planet to extract from.
 * - `PLANET_URL=latest` → newest daily Protomaps build (dev). The choice is cached for
 *   30 days so area hashes (and therefore re-cuts) stay stable within a month.
 * - Otherwise PLANET_URL is used as-is (production: the monthly R2 mirror).
 */
export async function resolvePlanet(env: Env): Promise<Planet> {
  if (env.PLANET_URL === "mirror") {
    // Production: the verified monthly mirror in R2; fall back to the public build until the first mirror lands.
    const m = await env.CACHE_KV.get<Planet>("planet:mirror", "json");
    if (m) return m;
    return latestBuild(env);
  }
  if (env.PLANET_URL && env.PLANET_URL !== "latest") {
    return { url: env.PLANET_URL, build: env.PLANET_URL.split("/").pop()!.replace(/\.pmtiles$/, "") };
  }
  const cached = await env.CACHE_KV.get<Planet>("planet:latest", "json");
  if (cached) return cached;
  return latestBuild(env);
}

/**
 * The planet the app reads directly in device-map mode. Protomaps drops older builds
 * from build.protomaps.com, so the pinned build is re-checked once a day and replaced
 * with the newest one when it stops answering.
 */
export async function devicePlanet(env: Env): Promise<Planet> {
  const p = await resolvePlanet(env);
  const okKey = `planet:ok:${p.build}`;
  if (await env.CACHE_KV.get(okKey)) return p;
  const res = await fetch(p.url, { headers: { Range: "bytes=0-6" } }).catch(() => null);
  if (res?.status === 206) {
    await env.CACHE_KV.put(okKey, "1", { expirationTtl: 86400 });
    return p;
  }
  if (res && (res.status === 404 || res.status === 410 || res.status === 403)) return latestBuild(env, true);
  return p; // transient failure: keep the pinned build; the app retries
}

/** Newest daily Protomaps build (cached 30 days so area hashes stay stable). */
export async function latestBuild(env: Env, fresh = false): Promise<Planet> {
  if (!fresh) {
    const cached = await env.CACHE_KV.get<Planet>("planet:latest", "json");
    if (cached) return cached;
  }
  const res = await fetch("https://build-metadata.protomaps.dev/builds.json");
  if (!res.ok) throw new Error(`could not list Protomaps builds (${res.status})`);
  const builds = (await res.json()) as { key: string }[];
  const key = builds.at(-1)!.key;
  const p = { url: `https://build.protomaps.com/${key}`, build: key.replace(/\.pmtiles$/, "") };
  await env.CACHE_KV.put("planet:latest", JSON.stringify(p), { expirationTtl: 30 * 86400 });
  return p;
}

/**
 * Monthly: ask the tiler container to stream the newest planet build into the BASEMAP
 * bucket (rclone, multipart). Daily: once the object exists, switch extraction to it.
 */
export async function startPlanetMirror(env: Env, startMirror: (body: unknown) => Promise<Response>): Promise<string> {
  if (!env.BASEMAP || !env.BASEMAP_PUBLIC_URL || !env.MIRROR_TOKEN) return "mirror not configured";
  const latest = await latestBuild(env, true);
  const key = `planet-${latest.build}.pmtiles`;
  if (await env.BASEMAP.head(key)) {
    await promoteMirror(env, latest.build, key);
    return `already mirrored: ${key}`;
  }
  const res = await startMirror({ source: latest.url, dest: `r2:${"waypack-basemap"}/${key}` });
  if (!res.ok) throw new Error(`mirror start failed: ${res.status} ${await res.text()}`);
  await env.CACHE_KV.put("planet:pending", JSON.stringify({ build: latest.build, key, started: Date.now() }));
  return `mirror started: ${key}`;
}

export async function checkPlanetMirror(env: Env): Promise<string> {
  if (!env.BASEMAP || !env.BASEMAP_PUBLIC_URL) return "mirror not configured";
  const pending = await env.CACHE_KV.get<{ build: string; key: string }>("planet:pending", "json");
  if (!pending) return "nothing pending";
  const head = await env.BASEMAP.head(pending.key);
  if (!head || head.size < 1e9) return `still copying ${pending.key}`;
  await promoteMirror(env, pending.build, pending.key);
  await env.CACHE_KV.delete("planet:pending");
  // Keep the previous mirror one cycle for extracts in flight; delete older ones.
  const list = await env.BASEMAP.list({ prefix: "planet-" });
  const old = list.objects.map((o) => o.key).filter((k) => k !== pending.key).sort().slice(0, -1);
  if (old.length) await env.BASEMAP.delete(old);
  return `promoted ${pending.key}`;
}

async function promoteMirror(env: Env, build: string, key: string) {
  const p: Planet = { url: `${env.BASEMAP_PUBLIC_URL!.replace(/\/$/, "")}/${key}`, build };
  await env.CACHE_KV.put("planet:mirror", JSON.stringify(p));
}
