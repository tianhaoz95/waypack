import { formatResult, mapAreas, validateZip, zipBundle, type BundleFile, type Issue, type Manifest } from "@waypack/bundle-schema";
import type { Env } from "../env.js";
import { sha256 } from "./crypto.js";
import { Db, eq } from "./db.js";
import { activeTripCount, planFor, UPGRADE_HINT, type Plan } from "./entitlements.js";
import { keys } from "./storage.js";
import { resolvePlanet } from "./planet.js";

export interface TripRow {
  id: string;
  user_id: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
  current_version: number;
  status: "processing" | "ready" | "failed";
  deleted_at: string | null;
}

export interface ExtractRow {
  id: string;
  trip_id: string;
  version: number;
  area_index: number;
  area_hash: string;
  bbox: number[];
  max_zoom: number;
  basemap_build: string | null;
  tiles_key: string | null;
  tiles_bytes: number | null;
  tiles_sha256: string | null;
  status: "pending" | "processing" | "ready" | "failed" | "expired" | "skipped";
  error: string | null;
  attempts: number;
  expires_at: string | null;
}

export type PublishResult =
  | {
      ok: true;
      trip_id: string;
      version: number;
      status: "processing" | "ready";
      tiles_status: "processing" | "ready" | "not_included";
      warnings: Issue[];
      app_hint: string;
      message: string;
    }
  | { ok: false; errors: Issue[]; warnings: Issue[]; message: string; upgrade?: boolean };

export class PublishError extends Error {
  constructor(message: string, public upgrade = false) { super(message); }
}

export async function areaHash(bbox: number[], maxZoom: number, build: string): Promise<string> {
  return (await sha256(`${bbox.map((n) => n.toFixed(4)).join(",")}|z${maxZoom}|${build}`)).slice(0, 24);
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString();
};

/**
 * Validates and publishes a bundle as a new trip version (design §6.4).
 * `files` is used for inline uploads; `zip` for presigned uploads.
 */
export async function publishBundle(
  env: Env,
  db: Db,
  userId: string,
  input: { zip: Uint8Array } | { files: BundleFile[] },
  tripIdArg?: string | null,
): Promise<PublishResult> {
  const zip = "zip" in input ? input.zip : zipBundle(input.files);
  const v = validateZip(zip);
  if (!v.ok || !v.manifest) {
    return { ok: false, errors: v.errors, warnings: v.warnings, message: formatResult(v) };
  }
  const manifest = v.manifest;
  const requested = tripIdArg ?? manifest.trip_id ?? null;
  if (tripIdArg && manifest.trip_id && tripIdArg !== manifest.trip_id) {
    return {
      ok: false,
      errors: [{ path: "manifest.trip_id", message: `trip_id argument (${tripIdArg}) and manifest.trip_id (${manifest.trip_id}) differ`, hint: "use the same id in both, or omit the argument" }],
      warnings: v.warnings,
      message: "trip_id mismatch",
    };
  }

  const plan = await planFor(db, userId);
  let trip: TripRow | null = null;
  if (requested) {
    trip = await db.one<TripRow>("trips", `select=*&id=${eq(requested)}&user_id=${eq(userId)}&deleted_at=is.null`);
    if (!trip) {
      return {
        ok: false,
        errors: [{ path: "trip_id", message: `trip ${requested} not found in your account`, hint: "call list_trips, or set trip_id to null to create a new trip" }],
        warnings: v.warnings,
        message: "trip not found",
      };
    }
  }

  // Active-trip limit applies when creating a trip, or reviving a past trip into the future.
  const endsInFuture = manifest.end_date >= new Date().toISOString().slice(0, 10);
  const wasActive = trip && (!trip.end_date || trip.end_date >= new Date().toISOString().slice(0, 10));
  if (endsInFuture && !wasActive) {
    const active = await activeTripCount(db, userId, trip?.id);
    if (active >= plan.activeTrips) {
      const msg = `Your ${plan.tier} plan allows ${plan.activeTrips} active trip${plan.activeTrips === 1 ? "" : "s"} and you have ${active}. ${UPGRADE_HINT} Or delete a trip with delete_trip.`;
      return { ok: false, errors: [{ path: "account", message: msg }], warnings: v.warnings, message: msg, upgrade: true };
    }
  }

  if (!trip) {
    [trip] = await db.insert<TripRow>("trips", {
      user_id: userId,
      title: manifest.title,
      start_date: manifest.start_date,
      end_date: manifest.end_date,
      status: "processing",
    });
  }
  const tripId = trip.id;
  const version = trip.current_version + 1;
  const stored: Manifest = { ...manifest, trip_id: tripId };

  // Store the bundle and manifest.
  const bundleSha = await sha256(zip);
  const bundleKey = keys.bundle(userId, tripId, version);
  await env.BUCKET.put(bundleKey, zip, { httpMetadata: { contentType: "application/zip" }, customMetadata: { sha256: bundleSha } });
  await env.BUCKET.put(keys.manifest(userId, tripId, version), JSON.stringify(stored), { httpMetadata: { contentType: "application/json" } });

  // Map extracts.
  const { tilesStatus, mapHash, warnings: mapWarnings } = await planExtracts(env, db, plan, trip, version, stored);

  await db.insert("trip_versions", {
    trip_id: tripId,
    version,
    bundle_key: bundleKey,
    bundle_sha256: bundleSha,
    bundle_bytes: zip.byteLength,
    manifest: stored,
    sdk_version: manifest.sdk_version,
    map_hash: mapHash,
  });
  const status = tilesStatus === "processing" ? "processing" : "ready";
  await db.update("trips", `id=${eq(tripId)}`, {
    title: manifest.title,
    start_date: manifest.start_date,
    end_date: manifest.end_date,
    current_version: version,
    status,
  });

  const warnings = [...v.warnings, ...mapWarnings];
  const app_hint = `Open Waypack on your phone and tap Download on "${manifest.title}" before you lose signal.`;
  const tilesMsg =
    tilesStatus === "processing"
      ? "Offline map is being prepared (usually 1–3 minutes) — poll get_trip_status until ready."
      : tilesStatus === "ready"
        ? "Offline map ready."
        : "No offline map on the free plan (the map needs a connection). " + UPGRADE_HINT;
  return {
    ok: true,
    trip_id: tripId,
    version,
    status,
    tiles_status: tilesStatus,
    warnings,
    app_hint,
    message: `Published "${manifest.title}" as version ${version} (trip_id ${tripId}). ${tilesMsg} ${app_hint}`,
  };
}

async function planExtracts(env: Env, db: Db, plan: Plan, trip: TripRow, version: number, m: Manifest) {
  const warnings: Issue[] = [];
  const existing = await db.select<ExtractRow>("map_extracts", `select=*&trip_id=${eq(trip.id)}`);
  if (!plan.offlineMaps) {
    return { tilesStatus: "not_included" as const, mapHash: null, warnings };
  }
  const planet = await resolvePlanet(env);
  const zMax = Number(env.BASEMAP_MAX_ZOOM || 15);
  const areas = mapAreas(m).slice(0, plan.maxAreas);
  if (mapAreas(m).length > plan.maxAreas) warnings.push({ path: "map.extra_areas", message: `only the first ${plan.maxAreas} map areas are extracted on your plan` });

  const wanted = await Promise.all(
    areas.map(async (a, i) => {
      const z = Math.min(a.max_zoom, zMax);
      return { index: i, bbox: a.bbox, max_zoom: z, hash: await areaHash(a.bbox, z, planet.build) };
    }),
  );
  const mapHash = (await sha256(wanted.map((w) => w.hash).sort().join("|"))).slice(0, 24);
  const expiresAt = addDays(m.end_date, 30);
  const live = new Set(["pending", "processing", "ready"]);

  const toQueue: string[] = [];
  for (const w of wanted) {
    const have = existing.find((e) => e.area_hash === w.hash && live.has(e.status));
    if (have) {
      // Same area as before: keep it, but extend expiry if the trip moved later.
      if (have.expires_at !== expiresAt) await db.update("map_extracts", `id=${eq(have.id)}`, { expires_at: expiresAt, area_index: w.index });
      continue;
    }
    const [row] = await db.insert<ExtractRow>("map_extracts", {
      trip_id: trip.id,
      version,
      area_index: w.index,
      area_hash: w.hash,
      bbox: w.bbox,
      max_zoom: w.max_zoom,
      basemap_build: planet.build,
      status: "pending",
      expires_at: expiresAt,
    });
    toQueue.push(row.id);
  }

  // Areas no longer in the manifest: retire them (the app keeps its local copy until it updates).
  const wantedHashes = new Set(wanted.map((w) => w.hash));
  for (const e of existing) {
    if (!wantedHashes.has(e.area_hash) && live.has(e.status)) {
      // "skipped" = retired by a manifest change ("expired" is reserved for the 30-day expiry, which can be re-cut).
      await db.update("map_extracts", `id=${eq(e.id)}`, { status: "skipped", tiles_key: null });
      if (e.tiles_key) await env.BUCKET.delete(e.tiles_key);
    }
  }

  for (const id of toQueue) await env.TILE_QUEUE.send({ extract_id: id });

  const states = await db.select<ExtractRow>("map_extracts", `select=status&trip_id=${eq(trip.id)}&status=in.(pending,processing,ready)`);
  const tilesStatus = states.some((s) => s.status !== "ready") ? ("processing" as const) : ("ready" as const);
  return { tilesStatus, mapHash, warnings };
}

/** Recomputes a trip's status after an extract changes. */
export async function refreshTripStatus(db: Db, tripId: string): Promise<void> {
  const ex = await db.select<ExtractRow>("map_extracts", `select=status&trip_id=${eq(tripId)}&status=in.(pending,processing,ready,failed)`);
  const status = ex.some((e) => e.status === "failed") ? "failed" : ex.some((e) => e.status === "pending" || e.status === "processing") ? "processing" : "ready";
  await db.update("trips", `id=${eq(tripId)}`, { status });
}

export async function tripStatus(db: Db, userId: string, tripId: string) {
  const trip = await db.one<TripRow>("trips", `select=*&id=${eq(tripId)}&user_id=${eq(userId)}&deleted_at=is.null`);
  if (!trip) return null;
  const [ver] = await db.select<{ bundle_bytes: number; created_at: string }>(
    "trip_versions",
    `select=bundle_bytes,created_at&trip_id=${eq(tripId)}&version=${eq(trip.current_version)}`,
  );
  const ex = await db.select<ExtractRow>("map_extracts", `select=*&trip_id=${eq(tripId)}&status=in.(pending,processing,ready,failed,expired)&order=area_index`);
  const tiles_status =
    ex.length === 0 ? "not_included"
      : ex.every((e) => e.status === "expired") ? "expired"
      : ex.some((e) => e.status === "failed") ? "failed"
        : ex.some((e) => e.status === "pending" || e.status === "processing") ? "processing"
          : "ready";
  return {
    trip_id: trip.id,
    title: trip.title,
    version: trip.current_version,
    status: trip.status,
    tiles_status,
    sizes: { bundle_bytes: ver?.bundle_bytes ?? 0, tiles_bytes: ex.reduce((n, e) => n + (e.tiles_bytes ?? 0), 0) },
    extracts: ex.map((e) => ({ area_index: e.area_index, status: e.status, bbox: e.bbox, max_zoom: e.max_zoom, bytes: e.tiles_bytes, error: e.error })),
  };
}
