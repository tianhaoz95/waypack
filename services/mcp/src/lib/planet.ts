import type { Env } from "../env.js";

export interface Planet { url: string; build: string }

/**
 * Resolves the basemap planet to extract from.
 * - `PLANET_URL=latest` → newest daily Protomaps build (dev). The choice is cached for
 *   30 days so area hashes (and therefore re-cuts) stay stable within a month.
 * - Otherwise PLANET_URL is used as-is (production: the monthly R2 mirror).
 */
export async function resolvePlanet(env: Env): Promise<Planet> {
  if (env.PLANET_URL && env.PLANET_URL !== "latest") {
    return { url: env.PLANET_URL, build: env.PLANET_URL.split("/").pop()!.replace(/\.pmtiles$/, "") };
  }
  const cached = await env.CACHE_KV.get<Planet>("planet:latest", "json");
  if (cached) return cached;
  const res = await fetch("https://build-metadata.protomaps.dev/builds.json");
  if (!res.ok) throw new Error(`could not list Protomaps builds (${res.status})`);
  const builds = (await res.json()) as { key: string }[];
  const key = builds.at(-1)!.key;
  const p = { url: `https://build.protomaps.com/${key}`, build: key.replace(/\.pmtiles$/, "") };
  await env.CACHE_KV.put("planet:latest", JSON.stringify(p), { expirationTtl: 30 * 86400 });
  return p;
}
