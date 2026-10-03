import { decodeInlineFiles, formatResult, LIMITS, SCHEMA_VERSION, SDK_MAJOR, validateFiles, validateZip, manifestSchema, type InlineFile } from "@waypack/bundle-schema";
import type { Env } from "../env.js";
import { Db, eq } from "../lib/db.js";
import { computeRoute, geocode, rateLimit, type LatLon, type Mode } from "../lib/geo.js";
import { publishBundle, tripStatus, type PublishResult, type TripRow } from "../lib/pipeline.js";
import { keys, signedUploadUrl } from "../lib/storage.js";
import { GUIDE } from "../generated/guide.js";
import { ToolError, type ToolDef, type ToolResult } from "./protocol.js";

export interface ToolCtx { env: Env; db: Db; userId: string }

const MODES: Mode[] = ["driving", "walking", "hiking", "cycling", "transit", "ferry", "flight"];
const latLonSchema = {
  type: "object",
  properties: { lat: { type: "number", minimum: -90, maximum: 90 }, lon: { type: "number", minimum: -180, maximum: 180 } },
  required: ["lat", "lon"],
};
const filesSchema = {
  type: "array",
  description: "Bundle files. Text as utf-8, binary (images) as base64.",
  items: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path, e.g. index.html or assets/style.css" },
      content: { type: "string" },
      encoding: { type: "string", enum: ["utf-8", "base64"], default: "utf-8" },
    },
    required: ["path", "content"],
  },
};
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(args: Record<string, unknown>, k: string, required = true): string | undefined {
  const v = args[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`\`${k}\` is required.`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`\`${k}\` must be a string.`);
  return v;
}
function tripIdArg(args: Record<string, unknown>, required: boolean): string | undefined {
  const v = str(args, "trip_id", required);
  if (v && !uuidRe.test(v)) throw new ToolError(`\`trip_id\` must be a UUID (from list_trips). Got \`${v}\`.`);
  return v;
}
function latLon(v: unknown, name: string): LatLon {
  const o = v as LatLon;
  if (!o || typeof o.lat !== "number" || typeof o.lon !== "number" || Math.abs(o.lat) > 90 || Math.abs(o.lon) > 180) {
    throw new ToolError(`\`${name}\` must be {lat, lon} in degrees (lat −90..90, lon −180..180). Use geocode to get coordinates.`);
  }
  return { lat: o.lat, lon: o.lon };
}
const json = (text: string, structured: Record<string, unknown>, isError = false): ToolResult => ({ text, structured, isError });

function publishResult(r: PublishResult): ToolResult {
  if (!r.ok) {
    return json(r.upgrade ? r.message : `Upload rejected.\n${r.message}`, { ok: false, errors: r.errors, warnings: r.warnings, upgrade_required: !!r.upgrade }, true);
  }
  const warn = r.warnings.length ? `\n${r.warnings.length} warning(s):\n${r.warnings.map((w) => `  - ${w.path}: ${w.message}${w.hint ? ` — ${w.hint}` : ""}`).join("\n")}` : "";
  return json(r.message + warn, {
    trip_id: r.trip_id,
    version: r.version,
    status: r.status,
    tiles_status: r.tiles_status,
    app_hint: r.app_hint,
    warnings: r.warnings,
  });
}

async function ownTrip(ctx: ToolCtx, tripId: string): Promise<TripRow> {
  const t = await ctx.db.one<TripRow>("trips", `select=*&id=${eq(tripId)}&user_id=${eq(ctx.userId)}&deleted_at=is.null`);
  if (!t) throw new ToolError(`Trip ${tripId} not found in your account. Call list_trips to see your trips.`);
  return t;
}

export const INSTRUCTIONS = `Waypack publishes trip plans as offline mobile bundles for the Waypack phone app.
Workflow: interview the user → research → geocode every place and compute_route every non-trivial move → write manifest.json + index.html (call get_authoring_guide first if you don't have the Waypack skill) → validate_bundle → upload (create_upload + PUT + finalize_upload, or upload_bundle_inline for chat agents) → get_trip_status until ready → tell the user to tap Download in the app.`;

export const tools: ToolDef<ToolCtx>[] = [
  {
    name: "get_authoring_guide",
    title: "Get authoring guide",
    description:
      "Returns the Waypack authoring guide (interview, coverage checklist, bundle rules, SDK, upload steps) and current schema/SDK versions. Call with section='template' to get the starter bundle files to copy, or 'schema' for the manifest JSON Schema. Use this if the Waypack skill isn't installed.",
    inputSchema: {
      type: "object",
      properties: { section: { type: "string", enum: ["guide", "template", "schema", "all"], default: "guide" } },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async run(args) {
      const section = (args.section as string) ?? "guide";
      const versions = `Schema version ${SCHEMA_VERSION} · SDK v${SDK_MAJOR} (\`<script src="/__waypack/sdk/v1/waypack.js"></script>\`)`;
      const guide = [GUIDE.skill, ...Object.entries(GUIDE.references).map(([n, t]) => `\n---\n<!-- reference/${n} -->\n${t}`)].join("\n");
      const template = Object.entries(GUIDE.template).map(([p, t]) => `\n### ${p}\n\`\`\`${p.split(".").pop()}\n${t}\n\`\`\``).join("\n");
      const schema = "```json\n" + JSON.stringify(manifestSchema, null, 2) + "\n```";
      const parts: Record<string, string> = {
        guide: `${versions}\n\n${guide}\n\nCall get_authoring_guide with section="template" for the starter files.`,
        template: `${versions}\n\nStarter bundle (copy these files, then replace the SAMPLE content):\n${template}`,
        schema: `${versions}\n\n${schema}`,
      };
      const text = section === "all" ? [parts.guide, parts.template, parts.schema].join("\n\n") : parts[section] ?? parts.guide;
      return { text, structured: { schema_version: SCHEMA_VERSION, sdk_version: SDK_MAJOR } };
    },
  },
  {
    name: "list_trips",
    title: "List trips",
    description: "Lists the user's Waypack trips (newest first) with id, title, dates, version and processing status.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(_args, ctx) {
      const rows = await ctx.db.select<TripRow>("trips", `select=id,title,start_date,end_date,current_version,status&user_id=${eq(ctx.userId)}&deleted_at=is.null&order=start_date.desc.nullslast`);
      const trips = rows.map((t) => ({ trip_id: t.id, title: t.title, start_date: t.start_date, end_date: t.end_date, version: t.current_version, status: t.status }));
      const text = trips.length
        ? trips.map((t) => `- ${t.title} (${t.start_date} → ${t.end_date}) · v${t.version} · ${t.status} · trip_id ${t.trip_id}`).join("\n")
        : "No trips yet. Plan one and upload it with create_upload/finalize_upload or upload_bundle_inline.";
      return { text, structured: { trips } };
    },
  },
  {
    name: "get_trip",
    title: "Get trip",
    description: "Returns the current manifest.json and status of a trip, so you can revise it. To publish a revision, keep manifest.trip_id set to this id and upload again.",
    inputSchema: { type: "object", properties: { trip_id: { type: "string" } }, required: ["trip_id"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, ctx) {
      const id = tripIdArg(args, true)!;
      const t = await ownTrip(ctx, id);
      const v = await ctx.db.one<{ manifest: Record<string, unknown> }>("trip_versions", `select=manifest&trip_id=${eq(id)}&version=${eq(t.current_version)}`);
      const status = await tripStatus(ctx.db, ctx.userId, id);
      return {
        text: `Trip "${t.title}" v${t.current_version} (${t.status}). Manifest:\n\`\`\`json\n${JSON.stringify(v?.manifest ?? {}, null, 2)}\n\`\`\`\nThe current index.html/assets aren't returned; regenerate them from the manifest and your plan when revising.`,
        structured: { trip_id: id, version: t.current_version, status, manifest: v?.manifest ?? null },
      };
    },
  },
  {
    name: "geocode",
    title: "Geocode a place",
    description: "Finds coordinates for a place name or address. Always use this for every place in a manifest — never guess coordinates. Add town/state/country to the query for precision, and `near` to bias results.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, near: latLonSchema }, required: ["query"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const q = str(args, "query")!;
      const near = args.near ? latLon(args.near, "near") : undefined;
      const limited = await rateLimit(ctx.env, ctx.userId, "geocode", 60, 1500);
      if (limited) throw new ToolError(limited);
      const results = await geocode(ctx.env, q, near);
      if (!results.length) return { text: `No results for "${q}". Try a more specific query (add the town, region and country) or a nearby landmark.`, structured: { results: [] } };
      return {
        text: results.map((r, i) => `${i + 1}. ${r.name} — ${r.lat}, ${r.lon} (confidence ${r.confidence.toFixed(2)})\n   ${r.address}`).join("\n"),
        structured: { results },
      };
    },
  },
  {
    name: "compute_route",
    title: "Compute a route",
    description:
      "Computes a real road/trail route between coordinates. Returns distance_m, duration_s and a GeoJSON LineString geometry (≤ 5,000 points) to paste into manifest.routes[]. Use mode 'hiking' for trails. transit/ferry/flight return a straight line.",
    inputSchema: {
      type: "object",
      properties: { from: latLonSchema, to: latLonSchema, via: { type: "array", items: latLonSchema, maxItems: 20 }, mode: { type: "string", enum: MODES, default: "driving" } },
      required: ["from", "to"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const from = latLon(args.from, "from");
      const to = latLon(args.to, "to");
      const via = Array.isArray(args.via) ? args.via.map((v, i) => latLon(v, `via[${i}]`)) : [];
      const mode = (args.mode as Mode) ?? "driving";
      if (!MODES.includes(mode)) throw new ToolError(`\`mode\` must be one of ${MODES.join(", ")}.`);
      const limited = await rateLimit(ctx.env, ctx.userId, "compute_route", 30, 800);
      if (limited) throw new ToolError(limited);
      const r = await computeRoute(ctx.env, from, to, via, mode);
      const km = (r.distance_m / 1000).toFixed(1);
      const min = Math.round(r.duration_s / 60);
      return {
        text: `${mode}: ${km} km, ~${min} min, ${r.geometry.coordinates.length} points (${r.provider}).${r.note ? ` ${r.note}` : ""} Full geometry is in structuredContent.geometry; copy distance_m, duration_s and geometry into the route.\n${JSON.stringify({ distance_m: r.distance_m, duration_s: r.duration_s, geometry: r.geometry })}`,
        structured: { distance_m: r.distance_m, duration_s: r.duration_s, geometry: r.geometry, provider: r.provider },
      };
    },
  },
  {
    name: "validate_bundle",
    title: "Validate a bundle",
    description: "Validates bundle files (or an uploaded zip by upload_id) against the Waypack v1 contract. Returns {ok, errors, warnings}. Fix all errors before uploading.",
    inputSchema: { type: "object", properties: { files: filesSchema, upload_id: { type: "string" } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, ctx) {
      let r;
      if (Array.isArray(args.files)) {
        const d = decodeInlineFiles(args.files as InlineFile[]);
        r = validateFiles(d.files);
        r.errors.unshift(...d.errors);
        r.ok = r.errors.length === 0;
      } else if (args.upload_id) {
        const up = await ownUpload(ctx, str(args, "upload_id")!);
        const obj = await ctx.env.BUCKET.get(up.object_key);
        if (!obj) throw new ToolError("Nothing has been uploaded for this upload_id yet. PUT the zip to put_url first.");
        r = validateZip(new Uint8Array(await obj.arrayBuffer()));
      } else {
        throw new ToolError("Pass `files` (array of {path, content, encoding}) or `upload_id`.");
      }
      delete r.manifest;
      return { text: formatResult(r), structured: { ok: r.ok, errors: r.errors, warnings: r.warnings, stats: r.stats }, isError: false };
    },
  },
  {
    name: "create_upload",
    title: "Create an upload URL",
    description:
      "Step 1 of the CLI upload: returns a single-use put_url (valid 15 min) for a zipped bundle. Then run `curl -fsS -X PUT -H 'Content-Type: application/zip' -T bundle.zip \"<put_url>\"` and call finalize_upload. Set trip_id to publish a new version of an existing trip.",
    inputSchema: { type: "object", properties: { trip_id: { type: "string" }, size_bytes: { type: "integer", minimum: 1 } }, required: ["size_bytes"] },
    annotations: { openWorldHint: false },
    async run(args, ctx) {
      const size = Number(args.size_bytes);
      if (!Number.isFinite(size) || size <= 0) throw new ToolError("`size_bytes` must be the zip size in bytes.");
      if (size > LIMITS.maxZippedBytes) throw new ToolError(`Bundle is ${(size / 1048576).toFixed(1)} MB; the limit is 25 MB zipped. Compress images (WebP/JPEG ≤ 1600px) and remove unused assets.`);
      const tripId = tripIdArg(args, false);
      if (tripId) await ownTrip(ctx, tripId);
      const id = crypto.randomUUID();
      const expires = new Date(Date.now() + 15 * 60_000).toISOString();
      await ctx.db.insert("uploads", { id, user_id: ctx.userId, trip_id: tripId ?? null, size_bytes: size, object_key: keys.upload(ctx.userId, id), expires_at: expires });
      const put_url = await signedUploadUrl(ctx.env, id, 15 * 60);
      return {
        text: `Upload created (upload_id ${id}, expires ${expires}).\nNext:\n  curl -fsS -X PUT -H "Content-Type: application/zip" -T bundle.zip "${put_url}"\nthen call finalize_upload with upload_id "${id}".`,
        structured: { upload_id: id, put_url, expires_at: expires },
      };
    },
  },
  {
    name: "finalize_upload",
    title: "Finalize an upload",
    description: "Step 3 of the CLI upload: validates the uploaded zip, publishes it as a new trip version and starts offline-map extraction. Returns {trip_id, version, status, app_hint}.",
    inputSchema: { type: "object", properties: { upload_id: { type: "string" } }, required: ["upload_id"] },
    annotations: { openWorldHint: false },
    async run(args, ctx) {
      const up = await ownUpload(ctx, str(args, "upload_id")!);
      if (up.status === "finalized") throw new ToolError("This upload was already finalized. Create a new upload for another version.");
      if (Date.parse(up.expires_at) < Date.now() && up.status === "pending") throw new ToolError("This upload expired. Call create_upload again.");
      const obj = await ctx.env.BUCKET.get(up.object_key);
      if (!obj) throw new ToolError("Nothing has been uploaded yet. PUT the zip to put_url (from create_upload) first, then finalize.");
      const zip = new Uint8Array(await obj.arrayBuffer());
      const r = await publishBundle(ctx.env, ctx.db, ctx.userId, { zip }, up.trip_id);
      await ctx.db.update("uploads", `id=${eq(up.id)}`, { status: r.ok ? "finalized" : "failed" });
      await ctx.env.BUCKET.delete(up.object_key);
      return publishResult(r);
    },
  },
  {
    name: "upload_bundle_inline",
    title: "Upload a bundle inline",
    description:
      "For chat agents without a shell: uploads bundle files directly (≤ 4 MB total) and publishes them. Text files as utf-8, images as base64. Same result as finalize_upload. Set trip_id (or manifest.trip_id) to publish a new version.",
    inputSchema: { type: "object", properties: { trip_id: { type: "string" }, files: filesSchema }, required: ["files"] },
    annotations: { openWorldHint: false },
    async run(args, ctx) {
      if (!Array.isArray(args.files) || !args.files.length) throw new ToolError("`files` must be a non-empty array of {path, content, encoding}.");
      const d = decodeInlineFiles(args.files as InlineFile[]);
      if (d.errors.length) return publishResult({ ok: false, errors: d.errors, warnings: [], message: d.errors.map((e) => `${e.path}: ${e.message}`).join("\n") });
      const total = d.files.reduce((n, f) => n + f.data.byteLength, 0);
      if (total > LIMITS.maxInlineBytes) {
        throw new ToolError(`Inline uploads are limited to 4 MB (got ${(total / 1048576).toFixed(1)} MB). Use inline SVG instead of photos, or upload a zip with create_upload.`);
      }
      const r = await publishBundle(ctx.env, ctx.db, ctx.userId, { files: d.files }, tripIdArg(args, false) ?? null);
      return publishResult(r);
    },
  },
  {
    name: "get_trip_status",
    title: "Get trip status",
    description: "Processing status of a trip: status (processing | ready | failed), tiles_status, and sizes. Poll every ~20 s after uploading until ready.",
    inputSchema: { type: "object", properties: { trip_id: { type: "string" } }, required: ["trip_id"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, ctx) {
      const id = tripIdArg(args, true)!;
      const s = await tripStatus(ctx.db, ctx.userId, id);
      if (!s) throw new ToolError(`Trip ${id} not found in your account.`);
      const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
      const failed = s.extracts.filter((e) => e.status === "failed").map((e) => e.error).join("; ");
      const text =
        `"${s.title}" v${s.version}: ${s.status}. Offline map: ${s.tiles_status}` +
        (s.tiles_status === "not_included" ? " (free plan — map needs a connection)" : "") +
        `. Download size ≈ ${mb(s.sizes.bundle_bytes + s.sizes.tiles_bytes)}.` +
        (failed ? ` Map extraction failed: ${failed}. Re-upload to retry.` : "") +
        (s.status === "ready" ? " Tell the user to open Waypack and tap Download." : "");
      return { text, structured: s };
    },
  },
  {
    name: "delete_trip",
    title: "Delete a trip",
    description: "Permanently deletes a trip, all its versions and offline maps. Requires confirm: true. Ask the user first.",
    inputSchema: { type: "object", properties: { trip_id: { type: "string" }, confirm: { type: "boolean" } }, required: ["trip_id", "confirm"] },
    annotations: { destructiveHint: true, openWorldHint: false },
    async run(args, ctx) {
      const id = tripIdArg(args, true)!;
      if (args.confirm !== true) throw new ToolError("Set confirm: true to delete. Ask the user before deleting a trip.");
      const t = await ownTrip(ctx, id);
      await deleteTripData(ctx.env, ctx.db, ctx.userId, id);
      return { text: `Deleted "${t.title}".`, structured: { ok: true } };
    },
  },
];

async function ownUpload(ctx: ToolCtx, id: string) {
  if (!uuidRe.test(id)) throw new ToolError("`upload_id` must be the id returned by create_upload.");
  const up = await ctx.db.one<{ id: string; trip_id: string | null; object_key: string; status: string; expires_at: string }>(
    "uploads",
    `select=*&id=${eq(id)}&user_id=${eq(ctx.userId)}`,
  );
  if (!up) throw new ToolError(`Upload ${id} not found. Call create_upload first.`);
  return up;
}

/** Soft-deletes the trip row and removes its R2 objects (bundles + tiles). */
export async function deleteTripData(env: Env, db: Db, userId: string, tripId: string): Promise<void> {
  for (const prefix of [`bundles/${userId}/${tripId}/`, `tiles/${userId}/${tripId}/`]) {
    let cursor: string | undefined;
    do {
      const list = await env.BUCKET.list({ prefix, cursor });
      if (list.objects.length) await env.BUCKET.delete(list.objects.map((o) => o.key));
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
  await db.update("map_extracts", `trip_id=${eq(tripId)}`, { status: "skipped", tiles_key: null });
  await db.update("trips", `id=${eq(tripId)}`, { deleted_at: new Date().toISOString() });
}
