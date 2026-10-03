import * as maplibregl from "maplibre-gl";
import { PMTiles } from "pmtiles";
import { host, sdkBase, tripIdFromLocation } from "./host.js";
import type { TilesIndex } from "./types.js";

interface Archive { pm: PMTiles; minZoom: number; maxZoom: number; bounds: [number, number, number, number] }

export interface TileSourceInfo {
  /** Vector source spec for the basemap, or null when no tiles are available. */
  source: maplibregl.VectorSourceSpecification | null;
  offline: boolean;
  maxZoom: number;
}

const groups = new Map<string, Archive[]>();
let protocolRegistered = false;

function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

const intersects = (a: number[], b: number[]) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/**
 * `wpk://{group}/{z}/{x}/{y}` serves a tile from the first archive in the group
 * that covers it. This lets several offline extracts (and an optional online
 * fallback) act as one basemap source without duplicating style layers.
 */
function registerProtocol() {
  if (protocolRegistered) return;
  protocolRegistered = true;
  maplibregl.setWorkerUrl(new URL("waypack-worker.js", sdkBase).href);
  maplibregl.addProtocol("wpk", async (params, abort) => {
    const m = params.url.match(/^wpk:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) throw new Error(`bad tile url ${params.url}`);
    const [, key, zs, xs, ys] = m;
    const z = +zs, x = +xs, y = +ys;
    const tb = tileBounds(z, x, y);
    for (const a of groups.get(key) ?? []) {
      if (z < a.minZoom || z > a.maxZoom || !intersects(tb, a.bounds)) continue;
      const r = await a.pm.getZxy(z, x, y, abort.signal);
      if (r) return { data: new Uint8Array(r.data), cacheControl: r.cacheControl, expires: r.expires };
    }
    return { data: new Uint8Array() };
  });
}

async function loadIndex(): Promise<TilesIndex | null> {
  const base = host().tilesBase ?? "/__waypack/tiles/";
  try {
    const res = await fetch(`${base}${encodeURIComponent(tripIdFromLocation())}/index.json`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as TilesIndex;
  } catch {
    return null;
  }
}

export async function resolveTiles(): Promise<TileSourceInfo> {
  registerProtocol();
  const idx = await loadIndex();
  const archives: Archive[] = [];
  const urls = (idx?.extracts ?? []).map((e) => e.url);
  const online = idx?.online && navigator.onLine ? idx.online : null;
  if (online && /\.pmtiles(\?|$)/.test(online)) urls.push(online);

  for (const url of urls) {
    try {
      const pm = new PMTiles(new URL(url, location.href).href);
      const h = await pm.getHeader();
      archives.push({ pm, minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat] });
    } catch (e) {
      console.warn("[waypack] could not open tiles", url, e);
    }
  }
  const offline = archives.length > 0 && (idx?.extracts.length ?? 0) > 0;

  if (archives.length) {
    const key = `g${groups.size}`;
    groups.set(key, archives);
    const maxZoom = Math.max(...archives.map((a) => a.maxZoom));
    return {
      offline,
      maxZoom,
      source: {
        type: "vector",
        tiles: [`wpk://${key}/{z}/{x}/{y}`],
        minzoom: 0,
        maxzoom: maxZoom,
        attribution: '<a href="https://openstreetmap.org/copyright">© OpenStreetMap contributors</a>, <a href="https://protomaps.com">Protomaps</a>',
      },
    };
  }
  if (online) {
    // TileJSON endpoint (e.g. a hosted Protomaps API URL).
    return { offline: false, maxZoom: 15, source: { type: "vector", url: online, attribution: "© OpenStreetMap contributors, Protomaps" } };
  }
  return { offline: false, maxZoom: 15, source: null };
}
