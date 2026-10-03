import validateSchema from "./generated/validate-manifest.js";
import type { Issue, Manifest } from "./types.js";
import { LIMITS } from "./limits.js";
import { bboxAreaKm2, countCoords, expandBBox, inAnyArea, mapAreas, padBBox } from "./geo.js";

export interface ManifestCheck { errors: Issue[]; warnings: Issue[]; manifest?: Manifest }

/** `/places/3/lat` → `places[3].lat` */
export function pointerToPath(ptr: string): string {
  if (!ptr) return "manifest";
  return ptr
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), "");
}

const FIELD_HINTS: Record<string, string> = {
  lat: "call the `geocode` tool to get coordinates; never guess them",
  lon: "call the `geocode` tool to get coordinates; never guess them",
  geometry: "call the `compute_route` tool and paste its `geometry`",
  bbox: "use [minLon, minLat, maxLon, maxLat] covering every place plus a few km",
  timezone: "use an IANA zone like America/Los_Angeles",
};

export function parseManifestText(text: string): { manifest?: unknown; error?: Issue } {
  try {
    return { manifest: JSON.parse(text.replace(/^﻿/, "")) };
  } catch (e) {
    return { error: { path: "manifest.json", message: `not valid JSON: ${(e as Error).message}` } };
  }
}

export function checkManifest(data: unknown): ManifestCheck {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (!validateSchema(data)) {
    const seen = new Set<string>();
    for (const e of validateSchema.errors ?? []) {
      // oneOf on geometry produces noisy duplicates; keep the first per path.
      let path = pointerToPath(e.instancePath);
      let message: string;
      if (e.keyword === "required") {
        const prop = String(e.params.missingProperty);
        path = path === "manifest" ? prop : `${path}.${prop}`;
        message = "missing";
      } else if (e.keyword === "enum") {
        message = `must be one of: ${(e.params.allowedValues as string[]).join(", ")}`;
      } else if (e.keyword === "format") {
        message = e.params.format === "date" ? "not a real calendar date (use YYYY-MM-DD)" : "must be a UUID (or null for a new trip)";
      } else if (e.keyword === "additionalProperties") {
        message = `unexpected property \`${String(e.params.additionalProperty)}\``;
      } else {
        message = e.message ?? e.keyword;
      }
      const key = `${path}|${e.keyword === "oneOf" || e.keyword === "const" ? "geom" : message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const leaf = path.split(".").pop()!.replace(/\[\d+\]$/, "");
      errors.push({ path, message, hint: FIELD_HINTS[leaf] });
    }
    return { errors, warnings };
  }

  const m = data as Manifest;
  semanticChecks(m, errors, warnings);
  return { errors, warnings, manifest: m };
}

function isValidDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function semanticChecks(m: Manifest, errors: Issue[], warnings: Issue[]): void {
  // Timezone must be a real IANA zone (the app uses it to compute "today").
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: m.timezone });
  } catch {
    errors.push({ path: "timezone", message: `unknown time zone \`${m.timezone}\``, hint: FIELD_HINTS.timezone });
  }

  for (const k of ["start_date", "end_date"] as const) {
    if (!isValidDate(m[k])) errors.push({ path: k, message: `\`${m[k]}\` is not a real calendar date` });
  }
  if (m.start_date > m.end_date) errors.push({ path: "end_date", message: "end_date is before start_date" });

  // Unique ids across places and routes.
  const placeIds = new Set<string>();
  const routeIds = new Set<string>();
  m.places.forEach((p, i) => {
    if (placeIds.has(p.id)) errors.push({ path: `places[${i}].id`, message: `duplicate place id \`${p.id}\`` });
    placeIds.add(p.id);
  });
  m.routes.forEach((r, i) => {
    if (routeIds.has(r.id)) errors.push({ path: `routes[${i}].id`, message: `duplicate route id \`${r.id}\`` });
    if (placeIds.has(r.id)) warnings.push({ path: `routes[${i}].id`, message: `route id \`${r.id}\` is also a place id` });
    routeIds.add(r.id);
  });

  // Routes: references, coordinate limits, sanity.
  m.routes.forEach((r, i) => {
    for (const end of ["from", "to"] as const) {
      const ref = r[end];
      if (ref && !placeIds.has(ref)) {
        errors.push({ path: `routes[${i}].${end}`, message: `unknown place id \`${ref}\``, hint: "add the place to `places` or fix the id" });
      }
    }
    const n = countCoords(r.geometry);
    if (n > LIMITS.maxRouteCoords) {
      errors.push({
        path: `routes[${i}].geometry`,
        message: `${n} coordinates; max is ${LIMITS.maxRouteCoords}`,
        hint: "simplify the line (compute_route already returns ≤ 5,000 points)",
      });
    }
    const lines = r.geometry.type === "LineString" ? [r.geometry.coordinates] : r.geometry.coordinates;
    const bad = lines.flat().find(([lon, lat]) => Math.abs(lon) > 180 || Math.abs(lat) > 90);
    if (bad) {
      errors.push({ path: `routes[${i}].geometry`, message: `coordinate [${bad.join(", ")}] out of range`, hint: "coordinates are [lon, lat] — check the order" });
    }
    if (r.mode !== "flight" && r.mode !== "ferry" && n === 2) {
      warnings.push({ path: `routes[${i}].geometry`, message: "straight line with only 2 points", hint: "use `compute_route` for a real road/trail geometry" });
    }
  });

  // Days: within range, unique, sorted; items: references and time order.
  const dates = new Set<string>();
  let prevDate = "";
  m.days.forEach((d, di) => {
    if (!isValidDate(d.date)) errors.push({ path: `days[${di}].date`, message: `\`${d.date}\` is not a real calendar date` });
    if (d.date < m.start_date || d.date > m.end_date) {
      errors.push({ path: `days[${di}].date`, message: `${d.date} is outside ${m.start_date}..${m.end_date}` });
    }
    if (dates.has(d.date)) errors.push({ path: `days[${di}].date`, message: `duplicate day ${d.date}` });
    if (d.date < prevDate) warnings.push({ path: `days[${di}].date`, message: "days are not in date order" });
    dates.add(d.date);
    prevDate = d.date;

    let prevTime = "";
    d.items.forEach((it, ii) => {
      const p = `days[${di}].items[${ii}]`;
      if (it.place_id && !placeIds.has(it.place_id)) errors.push({ path: `${p}.place_id`, message: `unknown place id \`${it.place_id}\`` });
      if (it.route_id && !routeIds.has(it.route_id)) errors.push({ path: `${p}.route_id`, message: `unknown route id \`${it.route_id}\`` });
      if (it.time) {
        if (prevTime && it.time < prevTime) warnings.push({ path: `${p}.time`, message: `items not sorted by time (${it.time} after ${prevTime})` });
        prevTime = it.time;
        if (it.end_time && it.end_time < it.time) {
          warnings.push({ path: `${p}.end_time`, message: "end_time is before time (overnight items should be split across days)" });
        }
      }
    });
  });
  for (let d = new Date(`${m.start_date}T00:00:00Z`); d.toISOString().slice(0, 10) <= m.end_date && dates.size; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = d.toISOString().slice(0, 10);
    if (!dates.has(s)) warnings.push({ path: "days", message: `no entry for ${s}`, hint: "add a day (even a rest day) so the Today view isn't empty" });
  }

  // Emergency place references.
  m.emergency?.places?.forEach((id, i) => {
    if (!placeIds.has(id)) errors.push({ path: `emergency.places[${i}]`, message: `unknown place id \`${id}\`` });
  });

  // Map areas: limits and coverage.
  const areas = mapAreas(m);
  areas.forEach((a, i) => {
    const path = i === 0 ? "map.bbox" : `map.extra_areas[${i - 1}].bbox`;
    const [minLon, minLat, maxLon, maxLat] = a.bbox;
    if (minLon >= maxLon || minLat >= maxLat) {
      errors.push({ path, message: "bbox must be [minLon, minLat, maxLon, maxLat] with min < max", hint: FIELD_HINTS.bbox });
      return;
    }
    const km2 = bboxAreaKm2(a.bbox);
    if (km2 > LIMITS.maxAreaKm2) {
      errors.push({
        path,
        message: `area is ~${Math.round(km2).toLocaleString("en-US")} km²; max is ${LIMITS.maxAreaKm2.toLocaleString("en-US")} km² per box`,
        hint: "split into smaller boxes with `map.extra_areas` (max 4 boxes total), e.g. one per base",
      });
    }
  });

  let suggested = m.map.bbox;
  m.places.forEach((p, i) => {
    if (!inAnyArea(m, p.lon, p.lat)) {
      warnings.push({ path: `places[${i}]`, message: `\`${p.id}\` (${p.lat}, ${p.lon}) is outside every map area — it won't have offline tiles` });
      suggested = expandBBox(suggested, p.lon, p.lat);
    }
  });
  if (suggested !== m.map.bbox) {
    const s = padBBox(suggested, 2);
    warnings.push({
      path: "map.bbox",
      message: "some places fall outside the offline map",
      hint: `expand to [${s.join(", ")}] (~${Math.round(bboxAreaKm2(s)).toLocaleString("en-US")} km²) or add an extra_area around the outliers`,
    });
  }

  // Coverage nudges.
  if (!m.live_checks?.length) warnings.push({ path: "live_checks", message: "no live checks", hint: "add links for road/weather/park alerts — never present conditions as fact" });
  if (!m.emergency?.numbers?.length) warnings.push({ path: "emergency", message: "no emergency numbers" });
  if (!m.places.some((p) => p.category === "lodging")) warnings.push({ path: "places", message: "no lodging place", hint: "add where travelers sleep (or mark the trip as a day trip in the summary)" });
  if (!m.summary) warnings.push({ path: "summary", message: "no summary" });
  if (m.days.every((d) => d.items.length === 0)) warnings.push({ path: "days", message: "every day is empty" });
}
