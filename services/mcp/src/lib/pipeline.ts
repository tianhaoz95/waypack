import { formatResult, isListingPath, LISTING_CONTENT_TYPES, listingPaths, mapAreas, sniffImage, unzipBundle, validateZip, zipBundle, type BundleFile, type Issue, type Manifest } from "@waypack/bundle-schema";
import type { Env } from "../env.js";
import { sha256 } from "./crypto.js";
import { Db, eq } from "./db.js";
import { activeTripCount, planFor, upgradeHint, type Plan } from "./entitlements.js";
import { keys, signedFileUrl } from "./storage.js";
import { devicePlanet, resolvePlanet, type Planet } from "./planet.js";

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
      tiles_status: "processing" | "ready" | "not_included" | "device";
      warnings: Issue[];
      app_hint: string;
      message: string;
    }
  | { ok: false; errors: Issue[]; warnings: Issue[]; message: string; upgrade?: boolean };

export class PublishError extends Error {
  constructor(message: string, public upgrade = false) { super(message); }
}

/** Offline maps are cut by the app from the planet (MAP_EXTRACTS=device) instead of the tiler container. */
export const deviceMaps = (env: Env) => env.MAP_EXTRACTS === "device";

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
  let zip = "zip" in input ? input.zip : zipBundle(input.files);
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
      const msg = `Your ${plan.tier} plan allows ${plan.activeTrips} active trip${plan.activeTrips === 1 ? "" : "s"} and you have ${active}. ${upgradeHint(env.PUBLIC_URL)} Or delete a trip with delete_trip.`;
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

  // Store-listing media (listing/…) goes next to the bundle, not in it: the app never downloads it.
  const filesList = "files" in input ? input.files : unzipBundle(zip).files;
  const wanted = new Set(listingPaths(manifest));
  for (const f of filesList) {
    if (!wanted.has(f.path)) continue;
    const type = sniffImage(f.data);
    if (!type) continue; // the validator already rejected these
    await env.BUCKET.put(keys.listing(userId, tripId, version, f.path), f.data, { httpMetadata: { contentType: LISTING_CONTENT_TYPES[type] } });
  }
  // Updates built from get_trip don't carry listing files: keep the previous version's copy, or drop the entry.
  const present = new Set(filesList.map((f) => f.path));
  const kept = new Set(present);
  for (const path of wanted) {
    if (present.has(path)) continue;
    const prev = trip.current_version > 0 ? await env.BUCKET.get(keys.listing(userId, tripId, trip.current_version, path)) : null;
    if (!prev) continue;
    const data = new Uint8Array(await prev.arrayBuffer());
    const type = sniffImage(data);
    if (!type) continue;
    await env.BUCKET.put(keys.listing(userId, tripId, version, path), data, { httpMetadata: { contentType: LISTING_CONTENT_TYPES[type] } });
    kept.add(path);
  }
  if (stored.listing) {
    const l = stored.listing;
    const screenshots = (l.screenshots ?? []).filter((x) => kept.has(x.src));
    stored.listing = {
      ...(l.tagline ? { tagline: l.tagline } : {}),
      ...(l.cover && kept.has(l.cover) ? { cover: l.cover } : {}),
      ...(screenshots.length ? { screenshots } : {}),
    };
  }
  if (filesList.some((f) => isListingPath(f.path))) zip = zipBundle(filesList.filter((f) => !isListingPath(f.path)));

  // Store the bundle and manifest.
  const bundleSha = await sha256(zip);
  const bundleKey = keys.bundle(userId, tripId, version);
  await env.BUCKET.put(bundleKey, zip, { httpMetadata: { contentType: "application/zip" } });
  await env.BUCKET.put(keys.manifest(userId, tripId, version), JSON.stringify(stored), { httpMetadata: { contentType: "application/json" } });

  // Store cover image separately if present, for fast card preview. With no cover_image, a raster
  // listing cover doubles as the app's card cover.
  const listingCover = manifest.listing?.cover && !/\.svg$/i.test(manifest.listing.cover) ? manifest.listing.cover : undefined;
  const coverPath = manifest.cover_image ?? manifest.theme?.cover_image ?? listingCover;
  const coverFile = filesList.find((f) => f.path === coverPath || (!coverPath && !isListingPath(f.path) && /(^|\/)cover\.(jpg|jpeg|png|webp)$/i.test(f.path)));
  if (coverFile) {
    const ext = coverFile.path.split(".").pop()?.toLowerCase() || "jpg";
    await env.BUCKET.put(keys.cover(userId, tripId, version, ext), coverFile.data, {
      httpMetadata: { contentType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg" },
    });
  } else if (listingCover && coverPath === listingCover && stored.listing?.cover === listingCover) {
    // The listing cover was carried forward from the previous version: it stays the card cover.
    const kept = await env.BUCKET.get(keys.listing(userId, tripId, version, listingCover));
    if (kept) {
      const ext = listingCover.split(".").pop()!.toLowerCase();
      await env.BUCKET.put(keys.cover(userId, tripId, version, ext), new Uint8Array(await kept.arrayBuffer()), {
        httpMetadata: { contentType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg" },
      });
    }
  }

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
        : tilesStatus === "device"
          ? "The app downloads the offline map itself when the user taps Download (needs a connection; larger areas take a minute or two)."
        : "No offline map on the free plan (the map needs a connection). " + upgradeHint(env.PUBLIC_URL);
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
  if (!plan.offlineMaps) {
    return { tilesStatus: "not_included" as const, mapHash: null, warnings };
  }
  if (mapAreas(m).length > plan.maxAreas) warnings.push({ path: "map.extra_areas", message: `only the first ${plan.maxAreas} map areas are extracted on your plan` });
  if (deviceMaps(env)) {
    // Nothing to cut or queue: the app builds the map on download.
    const wanted = await wantedAreas(env, plan, m, await devicePlanet(env));
    return { tilesStatus: "device" as const, mapHash: await mapHashOf(wanted), warnings };
  }
  const existing = await db.select<ExtractRow>("map_extracts", `select=*&trip_id=${eq(trip.id)}`);
  const planet = await resolvePlanet(env);
  const wanted = await wantedAreas(env, plan, m, planet);
  const mapHash = await mapHashOf(wanted);
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

/** The map areas a plan gets for a manifest (capped by plan and BASEMAP_MAX_ZOOM). */
async function wantedAreas(env: Env, plan: Plan, m: Pick<Manifest, "map">, planet: Planet) {
  const zMax = Number(env.BASEMAP_MAX_ZOOM || 15);
  return Promise.all(
    mapAreas(m)
      .slice(0, plan.maxAreas)
      .map(async (a, i) => {
        const z = Math.min(a.max_zoom, zMax);
        return { index: i, bbox: a.bbox, max_zoom: z, hash: await areaHash(a.bbox, z, planet.build) };
      }),
  );
}

const mapHashOf = async (wanted: { hash: string }[]) => (await sha256(wanted.map((w) => w.hash).sort().join("|"))).slice(0, 24);

/**
 * Device-map mode: what the app should cut from the planet itself. `area_hash`
 * changes with the planet build, so unchanged areas are reused across trip updates.
 */
export async function deviceTiles(env: Env, plan: Plan, m: Pick<Manifest, "map">) {
  const planet = await devicePlanet(env);
  const wanted = await wantedAreas(env, plan, m, planet);
  return {
    source: planet.url,
    build: planet.build,
    areas: wanted.map((w) => ({ area_index: w.index, area_hash: w.hash, bbox: w.bbox, max_zoom: w.max_zoom })),
  };
}

/**
 * Cuts offline maps for a published trip that doesn't have them yet — e.g. after the
 * user upgrades from free. No-op if the plan has no offline maps or extracts already exist.
 */
export async function ensureTripExtracts(env: Env, db: Db, userId: string, tripId: string): Promise<"processing" | "ready" | "not_included"> {
  const plan = await planFor(db, userId);
  const trip = await db.one<TripRow>("trips", `select=*&id=${eq(tripId)}&user_id=${eq(userId)}&deleted_at=is.null`);
  if (!trip || !plan.offlineMaps || trip.current_version < 1) return "not_included";
  const v = await db.one<{ manifest: Manifest }>("trip_versions", `select=manifest&trip_id=${eq(tripId)}&version=${eq(trip.current_version)}`);
  if (!v) return "not_included";
  const r = await planExtracts(env, db, plan, trip, trip.current_version, v.manifest);
  await db.update("trips", `id=${eq(tripId)}`, { status: r.tilesStatus === "processing" ? "processing" : "ready" });
  return r.tilesStatus === "device" ? "ready" : r.tilesStatus;
}

/** After an upgrade: provision maps for every trip that hasn't ended yet. */
export async function ensureExtractsForUser(env: Env, db: Db, userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const trips = await db.select<{ id: string }>("trips", `select=id&user_id=${eq(userId)}&deleted_at=is.null&or=(end_date.is.null,end_date.gte.${today})`);
  for (const t of trips) await ensureTripExtracts(env, db, userId, t.id);
  return trips.length;
}

/** Recomputes a trip's status after an extract changes. */
export async function refreshTripStatus(db: Db, tripId: string): Promise<void> {
  const ex = await db.select<ExtractRow>("map_extracts", `select=status&trip_id=${eq(tripId)}&status=in.(pending,processing,ready,failed)`);
  const status = ex.some((e) => e.status === "failed") ? "failed" : ex.some((e) => e.status === "pending" || e.status === "processing") ? "processing" : "ready";
  await db.update("trips", `id=${eq(tripId)}`, { status });
}

/** `userId` is the trip's owner: maps follow the owner's plan. */
export async function tripStatus(env: Env, db: Db, userId: string, tripId: string, opts: { portal?: boolean } = {}) {
  const trip = await db.one<TripRow>("trips", `select=*&id=${eq(tripId)}&user_id=${eq(userId)}&deleted_at=is.null`);
  if (!trip) return null;
  const [ver] = await db.select<{ bundle_bytes: number; created_at: string; manifest: Manifest }>(
    "trip_versions",
    `select=bundle_bytes,created_at,manifest&trip_id=${eq(tripId)}&version=${eq(trip.current_version)}`,
  );
  const ex = await db.select<ExtractRow>("map_extracts", `select=*&trip_id=${eq(tripId)}&status=in.(pending,processing,ready,failed,expired)&order=area_index`);
  const tiles_status =
    deviceMaps(env) ? ((await planFor(db, userId)).offlineMaps ? "device" : "not_included")
    : ex.length === 0 ? "not_included"
      : ex.every((e) => e.status === "expired") ? "expired"
      : ex.some((e) => e.status === "failed") ? "failed"
        : ex.some((e) => e.status === "pending" || e.status === "processing") ? "processing"
          : "ready";

  const listingCover = ver?.manifest?.listing?.cover && !/\.svg$/i.test(ver.manifest.listing.cover) ? ver.manifest.listing.cover : null;
  const coverPath = ver?.manifest?.cover_image ?? ver?.manifest?.theme?.cover_image ?? listingCover;
  let cover_image_url: string | null = null;
  if (ver?.manifest) {
    const exts = [coverPath?.split(".").pop()?.toLowerCase(), "jpg", "jpeg", "png", "webp"].filter(Boolean) as string[];
    for (const ext of exts) {
      const coverKey = keys.cover(userId, trip.id, trip.current_version, ext);
      if (await env.BUCKET.head(coverKey)) {
        cover_image_url = await signedFileUrl(env, coverKey);
        break;
      }
    }
  }

  return {
    trip_id: trip.id,
    title: trip.title,
    version: trip.current_version,
    status: trip.status,
    tiles_status,
    cover_image: coverPath,
    cover_image_url,
    sizes: { bundle_bytes: ver?.bundle_bytes ?? 0, tiles_bytes: ex.reduce((n, e) => n + (e.tiles_bytes ?? 0), 0) },
    extracts: ex.map((e) => ({ area_index: e.area_index, status: e.status, bbox: e.bbox, max_zoom: e.max_zoom, bytes: e.tiles_bytes, error: e.error })),
    ...(opts.portal && ver?.manifest ? { listing: await portalListing(env, userId, trip.id, trip.current_version, ver.manifest) } : {}),
  };
}

/**
 * What the web portal's store-style listing needs: the agent's listing media (signed, short-lived
 * URLs; images only ever shown with <img>) plus a digest of the manifest for the description,
 * "at a glance" facts and the drawn fallback cover.
 */
export async function portalListing(env: Env, userId: string, tripId: string, version: number, m: Manifest) {
  const sign = (path: string) => signedFileUrl(env, keys.listing(userId, tripId, version, path), 6 * 3600);
  const l = m.listing ?? {};
  const lodging = (m.places ?? []).filter((p) => p.category === "lodging").map((p) => p.name).slice(0, 3);
  return {
    tagline: l.tagline ?? null,
    cover_url: l.cover ? await sign(l.cover) : null,
    screenshots: await Promise.all((l.screenshots ?? []).map(async (x) => ({ url: await sign(x.src), caption: x.caption ?? null }))),
    summary: m.summary ?? null,
    days: m.days?.length ?? 0,
    places: m.places?.length ?? 0,
    routes: m.routes?.length ?? 0,
    lodging,
    travelers: m.travelers ? { adults: m.travelers.adults ?? null, children: m.travelers.children?.length ?? 0, pets: m.travelers.pets?.length ?? 0 } : null,
    theme: { accent: m.theme?.accent ?? null, preset: m.theme?.preset ?? null, scene: m.theme?.scene ?? null },
  };
}
