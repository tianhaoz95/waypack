import type { BBox, Manifest, MapArea, RouteGeometry } from "./types.js";
import { LIMITS } from "./limits.js";

/** Approximate area of a lon/lat box in km². Good enough for limit checks. */
export function bboxAreaKm2([minLon, minLat, maxLon, maxLat]: BBox): number {
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const w = Math.abs(maxLon - minLon) * 111.32 * Math.cos(midLat);
  const h = Math.abs(maxLat - minLat) * 110.574;
  return w * h;
}

export function bboxContains([minLon, minLat, maxLon, maxLat]: BBox, lon: number, lat: number): boolean {
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

export function expandBBox(b: BBox, lon: number, lat: number): BBox {
  return [Math.min(b[0], lon), Math.min(b[1], lat), Math.max(b[2], lon), Math.max(b[3], lat)];
}

/** Pads a bbox by `km` on every side. */
export function padBBox(b: BBox, km: number): BBox {
  const dLat = km / 110.574;
  const midLat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  const dLon = km / (111.32 * Math.max(Math.cos(midLat), 0.01));
  return [round(b[0] - dLon), round(b[1] - dLat), round(b[2] + dLon), round(b[3] + dLat)];
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** All offline map areas the manifest asks for, with max_zoom defaulted. */
export function mapAreas(m: Pick<Manifest, "map">): Required<Pick<MapArea, "bbox" | "max_zoom">>[] {
  const z = m.map.max_zoom ?? LIMITS.defaultMaxZoom;
  return [
    { bbox: m.map.bbox, max_zoom: z },
    ...(m.map.extra_areas ?? []).map((a) => ({ bbox: a.bbox, max_zoom: a.max_zoom ?? z })),
  ];
}

export function inAnyArea(m: Pick<Manifest, "map">, lon: number, lat: number): boolean {
  return mapAreas(m).some((a) => bboxContains(a.bbox, lon, lat));
}

export function countCoords(g: RouteGeometry): number {
  return g.type === "LineString" ? g.coordinates.length : g.coordinates.reduce((n, l) => n + l.length, 0);
}

/**
 * Douglas–Peucker simplification that keeps at most `max` points by raising the
 * tolerance until the result fits. Used by `compute_route` and the CLI.
 */
export function simplifyLine(coords: [number, number][], max = LIMITS.maxRouteCoords): [number, number][] {
  if (coords.length <= max) return coords;
  let tol = 1e-5;
  let out = coords;
  while (out.length > max && tol < 1) {
    out = douglasPeucker(coords, tol);
    tol *= 2;
  }
  return out;
}

function douglasPeucker(pts: [number, number][], tol: number): [number, number][] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function segDist2(p: [number, number], a: [number, number], b: [number, number]): number {
  let [x, y] = a;
  let dx = b[0] - x, dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x; dy = p[1] - y;
  return dx * dx + dy * dy;
}
