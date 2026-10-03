import { simplifyLine, LIMITS } from "@waypack/bundle-schema";
import type { Env } from "../env.js";
import { sha256 } from "./crypto.js";

export interface GeocodeResult { name: string; lat: number; lon: number; address: string; confidence: number }
export interface RouteResult {
  distance_m: number;
  duration_s: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  provider: string;
  note?: string;
}
export type Mode = "driving" | "walking" | "hiking" | "cycling" | "transit" | "ferry" | "flight";
export interface LatLon { lat: number; lon: number }

const UA = "Waypack/1.0 (+https://waypack.app)";
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

async function cached<T>(env: Env, key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const k = `${key.split(":")[0]}:${await sha256(key)}`;
  const hit = await env.CACHE_KV.get(k, "json");
  if (hit) return hit as T;
  const v = await fn();
  await env.CACHE_KV.put(k, JSON.stringify(v), { expirationTtl: ttl });
  return v;
}

export async function geocode(env: Env, query: string, near?: LatLon): Promise<GeocodeResult[]> {
  const key = `geo:${env.ORS_API_KEY ? "ors" : "nom"}:${query.trim().toLowerCase()}:${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ""}`;
  return cached(env, key, 30 * 86400, () => (env.ORS_API_KEY ? orsGeocode(env.ORS_API_KEY, query, near) : nominatim(query, near)));
}

async function orsGeocode(apiKey: string, query: string, near?: LatLon): Promise<GeocodeResult[]> {
  const u = new URL("https://api.openrouteservice.org/geocode/search");
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("text", query);
  u.searchParams.set("size", "5");
  if (near) {
    u.searchParams.set("focus.point.lat", String(near.lat));
    u.searchParams.set("focus.point.lon", String(near.lon));
  }
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`geocoding failed (${res.status})`);
  const j = (await res.json()) as { features: { geometry: { coordinates: [number, number] }; properties: { name?: string; label?: string; confidence?: number } }[] };
  return j.features.map((f) => ({
    name: f.properties.name ?? f.properties.label ?? query,
    lat: round5(f.geometry.coordinates[1]),
    lon: round5(f.geometry.coordinates[0]),
    address: f.properties.label ?? "",
    confidence: f.properties.confidence ?? 0.5,
  }));
}

async function nominatim(query: string, near?: LatLon): Promise<GeocodeResult[]> {
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("q", query);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", "5");
  if (near) {
    const d = 0.5;
    u.searchParams.set("viewbox", `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const res = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`geocoding failed (${res.status})`);
  const j = (await res.json()) as { lat: string; lon: string; name?: string; display_name: string; importance?: number }[];
  return j.map((x) => ({
    name: x.name || x.display_name.split(",")[0],
    lat: round5(+x.lat),
    lon: round5(+x.lon),
    address: x.display_name,
    confidence: Math.min(1, Math.max(0.1, x.importance ?? 0.5)),
  }));
}

const ORS_PROFILE: Partial<Record<Mode, string>> = { driving: "driving-car", walking: "foot-walking", hiking: "foot-hiking", cycling: "cycling-regular" };
const OSRM_DEV: Partial<Record<Mode, string>> = {
  driving: "https://router.project-osrm.org/route/v1/driving",
  walking: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
  hiking: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
  cycling: "https://routing.openstreetmap.de/routed-bike/route/v1/bike",
};

export async function computeRoute(env: Env, from: LatLon, to: LatLon, via: LatLon[], mode: Mode): Promise<RouteResult> {
  const pts = [from, ...via, to];
  for (const p of pts) {
    if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)) throw new Error(`invalid coordinate ${JSON.stringify(p)}`);
  }
  if (!ORS_PROFILE[mode]) return straightLine(pts, mode);
  const key = `route:${env.ORS_API_KEY ? "ors" : "osrm"}:${mode}:${pts.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(";")}`;
  return cached(env, key, 7 * 86400, async () => {
    const r = env.ORS_API_KEY ? await orsRoute(env.ORS_API_KEY, pts, mode) : await osrmRoute(pts, mode);
    const simplified = simplifyLine(r.geometry.coordinates, LIMITS.maxRouteCoords).map(([a, b]) => [round5(a), round5(b)] as [number, number]);
    return { ...r, geometry: { type: "LineString", coordinates: simplified } };
  });
}

async function orsRoute(apiKey: string, pts: LatLon[], mode: Mode): Promise<RouteResult> {
  const res = await fetch(`https://api.openrouteservice.org/v2/directions/${ORS_PROFILE[mode]}/geojson`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/geo+json" },
    body: JSON.stringify({ coordinates: pts.map((p) => [p.lon, p.lat]) }),
  });
  if (!res.ok) throw new Error(`routing failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { features: { geometry: { coordinates: [number, number][] }; properties: { summary: { distance: number; duration: number } } }[] };
  const f = j.features[0];
  return {
    distance_m: Math.round(f.properties.summary.distance),
    duration_s: Math.round(f.properties.summary.duration),
    geometry: { type: "LineString", coordinates: f.geometry.coordinates.map(([a, b]) => [a, b]) },
    provider: "openrouteservice",
  };
}

async function osrmRoute(pts: LatLon[], mode: Mode): Promise<RouteResult> {
  const coords = pts.map((p) => `${p.lon},${p.lat}`).join(";");
  const res = await fetch(`${OSRM_DEV[mode]}/${coords}?overview=full&geometries=geojson`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`routing failed (${res.status})`);
  const j = (await res.json()) as { code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] };
  if (j.code !== "Ok" || !j.routes?.length) throw new Error(`no route found (${j.code})`);
  const r = j.routes[0];
  let duration = r.duration;
  // The public foot profile assumes flat walking; hiking is slower (Naismith-ish fudge).
  if (mode === "hiking") duration *= 1.4;
  return {
    distance_m: Math.round(r.distance),
    duration_s: Math.round(duration),
    geometry: { type: "LineString", coordinates: r.geometry.coordinates },
    provider: "osrm-dev",
    note: "Dev routing provider (no ORS_API_KEY configured).",
  };
}

function haversine(a: LatLon, b: LatLon): number {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function straightLine(pts: LatLon[], mode: Mode): RouteResult {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
  const speed = mode === "flight" ? 220 : mode === "ferry" ? 9 : 12; // m/s, rough
  return {
    distance_m: Math.round(d),
    duration_s: Math.round(d / speed),
    geometry: { type: "LineString", coordinates: pts.map((p) => [round5(p.lon), round5(p.lat)]) },
    provider: "straight-line",
    note: `${mode} isn't routable; this is a straight line. Use real schedule times in the itinerary.`,
  };
}

/** Fixed-window per-user rate limit backed by KV (approximate, fine for quota protection). */
export async function rateLimit(env: Env, userId: string, bucket: string, perMinute: number, perDay: number): Promise<string | null> {
  const now = Date.now();
  const minuteKey = `rl:${bucket}:${userId}:${Math.floor(now / 60000)}`;
  const dayKey = `rl:${bucket}:${userId}:d${Math.floor(now / 86400000)}`;
  const [m, d] = await Promise.all([env.CACHE_KV.get(minuteKey), env.CACHE_KV.get(dayKey)]);
  if (Number(m ?? 0) >= perMinute) return `Rate limit: max ${perMinute} ${bucket} calls per minute. Wait a minute and retry.`;
  if (Number(d ?? 0) >= perDay) return `Daily limit of ${perDay} ${bucket} calls reached. Try again tomorrow.`;
  await Promise.all([
    env.CACHE_KV.put(minuteKey, String(Number(m ?? 0) + 1), { expirationTtl: 120 }),
    env.CACHE_KV.put(dayKey, String(Number(d ?? 0) + 1), { expirationTtl: 90000 }),
  ]);
  return null;
}
