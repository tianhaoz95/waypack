import { decodeInlineFiles, formatResult, LIMITS, SCHEMA_VERSION, SDK_MAJOR, unzipBundle, validateFiles, validateZip, manifestSchema, type BundleFile, type InlineFile } from "@waypack/bundle-schema";
import type { Env } from "../env.js";
import { Db, eq } from "../lib/db.js";
import { computeRoute, geocode, rateLimit, type LatLon, type Mode } from "../lib/geo.js";
import { publishBundle, tripStatus, type PublishResult, type TripRow } from "../lib/pipeline.js";
import { keys, signedUploadUrl } from "../lib/storage.js";
import { deletePreview, listPreviews, PreviewError, publishPreview, pushPreview, type PushResult } from "../lib/previews.js";
import { ShareError, sharedTripForAgent, shareTrip, unshareTrip } from "../lib/shares.js";
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
Workflow: interview the user → research → geocode every place and compute_route every non-trivial move → write manifest.json + index.html (call get_authoring_guide first if you don't have the Waypack skill) → validate_bundle → upload (create_upload + PUT + finalize_upload, or upload_bundle_inline for chat agents) → get_trip_status until ready → tell the user to tap Download in the app.
Live preview: as soon as there's a skeleton, push_preview and give the user the link; push again (changed files only) at milestones so they can watch it take shape on any device. When they approve, publish_preview publishes it to the app.`;

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
      const previews = await listPreviews(ctx.env, ctx.db, ctx.userId).catch(() => []);
      const text =
        (trips.length
          ? trips.map((t) => `- ${t.title} (${t.start_date} → ${t.end_date}) · v${t.version} · ${t.status} · trip_id ${t.trip_id}`).join("\n")
          : "No trips yet. Plan one and upload it with create_upload/finalize_upload or upload_bundle_inline.") +
        (previews.length
          ? `\n\nPreviews (drafts, not in the app):\n${previews.map((p) => `- ${p.title ?? "Untitled"} · rev ${p.rev}${p.published_version ? ` · published as v${p.published_version}` : ""} · ${p.preview_url} · preview_id ${p.preview_id}`).join("\n")}`
          : "");
      return { text, structured: { trips, previews } };
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
      "Step 1 of the CLI upload: returns a single-use put_url (valid 15 min) for a zipped bundle. Then run `curl -fsS -X PUT -H 'Content-Type: application/zip' -T bundle.zip \"<put_url>\"` and call finalize_upload. Set trip_id to publish a new version of an existing trip. Set preview: true (and preview_id to update one) to push the zip as a live preview instead of publishing it.",
    inputSchema: {
      type: "object",
      properties: {
        trip_id: { type: "string" },
        size_bytes: { type: "integer", minimum: 1 },
        preview: { type: "boolean", description: "Push as a live preview (draft) instead of publishing." },
        preview_id: { type: "string", description: "With preview: true, the preview to replace (from push_preview / an earlier preview upload)." },
      },
      required: ["size_bytes"],
    },
    annotations: { openWorldHint: false },
    async run(args, ctx) {
      const size = Number(args.size_bytes);
      if (!Number.isFinite(size) || size <= 0) throw new ToolError("`size_bytes` must be the zip size in bytes.");
      if (size > LIMITS.maxZippedBytes) throw new ToolError(`Bundle is ${(size / 1048576).toFixed(1)} MB; the limit is 25 MB zipped. Compress images (WebP/JPEG ≤ 1600px) and remove unused assets.`);
      const tripId = tripIdArg(args, false);
      if (tripId) await ownTrip(ctx, tripId);
      const preview = args.preview === true;
      const previewId = preview ? str(args, "preview_id", false) : undefined;
      if (previewId && !uuidRe.test(previewId)) throw new ToolError("`preview_id` must be the id returned by push_preview.");
      const id = crypto.randomUUID();
      const expires = new Date(Date.now() + 15 * 60_000).toISOString();
      await ctx.db.insert("uploads", {
        id,
        user_id: ctx.userId,
        trip_id: tripId ?? null,
        size_bytes: size,
        object_key: keys.upload(ctx.userId, id),
        expires_at: expires,
        purpose: preview ? "preview" : "publish",
        preview_id: previewId ?? null,
      });
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
      if (up.purpose === "preview") {
        const u = unzipBundle(zip);
        await ctx.env.BUCKET.delete(up.object_key);
        if (u.errors.length) {
          await ctx.db.update("uploads", `id=${eq(up.id)}`, { status: "failed" });
          throw new ToolError(`The zip couldn't be read:\n${u.errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n")}`);
        }
        const res = await runPush(ctx, { previewId: up.preview_id ?? undefined, tripId: up.trip_id ?? undefined, files: u.files, replace: true });
        await ctx.db.update("uploads", `id=${eq(up.id)}`, { status: "finalized" });
        return res;
      }
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
    name: "push_preview",
    title: "Push a live preview",
    description:
      "Pushes the bundle you're building to a live preview link the user can open on any device; the page reloads itself on every push. " +
      "Use it early (as soon as there's a manifest + index.html skeleton) and again at milestones (each finished day, research done, final). " +
      "Send only the files that changed since the last push (others are kept); `delete` removes files, `replace: true` starts over. " +
      "Unfinished bundles are fine: validation issues are reported, not blocking. Previews are drafts: they don't appear in the app and don't cut offline maps until publish_preview. " +
      "First call: omit preview_id (or pass trip_id to preview a revision of a published trip); then reuse the returned preview_id. Always show the user the preview_url.",
    inputSchema: {
      type: "object",
      properties: {
        preview_id: { type: "string", description: "From the first push_preview. Omit to start a new preview." },
        trip_id: { type: "string", description: "Preview a revision of this published trip (uses its preview if one exists)." },
        files: filesSchema,
        delete: { type: "array", items: { type: "string" }, description: "Paths to remove from the preview." },
        replace: { type: "boolean", description: "Replace all files instead of merging (default false)." },
      },
    },
    annotations: { openWorldHint: false },
    async run(args, ctx) {
      const files = Array.isArray(args.files) ? (args.files as InlineFile[]) : [];
      const deletes = Array.isArray(args.delete) ? (args.delete as unknown[]).map(String) : [];
      const d = decodeInlineFiles(files);
      if (d.errors.length) throw new ToolError(d.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
      const total = d.files.reduce((n, f) => n + f.data.byteLength, 0);
      if (total > LIMITS.maxInlineBytes) throw new ToolError(`One push can carry 4 MB (got ${(total / 1048576).toFixed(1)} MB). Push fewer files at a time, or zip the bundle and use create_upload with preview: true.`);
      const limited = await rateLimit(ctx.env, ctx.userId, "push_preview", 20, 600);
      if (limited) throw new ToolError(limited);
      return runPush(ctx, {
        previewId: str(args, "preview_id", false),
        tripId: tripIdArg(args, false),
        files: d.files,
        deletes,
        replace: args.replace === true,
      });
    },
  },
  {
    name: "publish_preview",
    title: "Publish a preview",
    description:
      "Publishes the preview's current files as a trip version (a new trip, or a new version of the trip it revises), exactly like an upload: the app shows it and offline maps are cut. Do this when the user is happy with the preview. Fails with the validation errors if the bundle isn't valid yet. The preview link keeps working for further revisions.",
    inputSchema: { type: "object", properties: { preview_id: { type: "string" } }, required: ["preview_id"] },
    annotations: { openWorldHint: false },
    async run(args, ctx) {
      try {
        const r = await publishPreview(ctx.env, ctx.db, ctx.userId, str(args, "preview_id")!);
        const res = publishResult(r);
        return { ...res, structured: { ...res.structured, preview_id: r.preview_id } };
      } catch (e) {
        if (e instanceof PreviewError) throw new ToolError(e.message);
        throw e;
      }
    },
  },
  {
    name: "delete_preview",
    title: "Delete a preview",
    description: "Deletes a preview and its link. Published trips are not affected.",
    inputSchema: { type: "object", properties: { preview_id: { type: "string" } }, required: ["preview_id"] },
    annotations: { destructiveHint: true, openWorldHint: false },
    async run(args, ctx) {
      try {
        await deletePreview(ctx.env, ctx.db, ctx.userId, str(args, "preview_id")!);
        return { text: "Preview deleted; its link no longer works.", structured: { ok: true } };
      } catch (e) {
        if (e instanceof PreviewError) throw new ToolError(e.message);
        throw e;
      }
    },
  },
  {
    name: "share_trip",
    title: "Share a trip publicly",
    description:
      "Creates (or updates) a public, read-only link to a published trip that anyone can open, with a \"Plan this trip\" button so they can have their own agent adapt it. " +
      "Ask the user first. Booking/confirmation numbers are masked automatically, but names, private phone numbers and personal notes are not: " +
      "if the plan has any, pass `files` with a cleaned copy (same bundle, personal details removed) instead of sharing the published files. Sharing again updates the same link.",
    inputSchema: { type: "object", properties: { trip_id: { type: "string" }, files: filesSchema }, required: ["trip_id"] },
    annotations: { openWorldHint: false },
    async run(args, ctx) {
      const tripId = tripIdArg(args, true)!;
      let files: BundleFile[] | undefined;
      if (Array.isArray(args.files) && args.files.length) {
        const d = decodeInlineFiles(args.files as InlineFile[]);
        if (d.errors.length) throw new ToolError(d.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
        files = d.files;
      }
      try {
        const r = await shareTrip(ctx.env, ctx.db, ctx.userId, tripId, files);
        return {
          text:
            `Shared "${r.title}" (v${r.version}).\nPublic page: ${r.share_url}\nRemix page (\"plan this trip for my dates\"): ${r.remix_url}\n` +
            (r.redactions ? `${r.redactions} booking/confirmation number(s) were masked. ` : "") +
            "Anyone with the link can see the plan. To stop sharing, call unshare_trip.",
          structured: { ...r },
        };
      } catch (e) {
        if (e instanceof ShareError) throw new ToolError(e.message);
        throw e;
      }
    },
  },
  {
    name: "unshare_trip",
    title: "Stop sharing a trip",
    description: "Turns off a trip's public link (it stops working immediately).",
    inputSchema: { type: "object", properties: { trip_id: { type: "string" } }, required: ["trip_id"] },
    annotations: { destructiveHint: true, openWorldHint: false },
    async run(args, ctx) {
      const tripId = tripIdArg(args, true)!;
      await ownTrip(ctx, tripId);
      const was = await unshareTrip(ctx.env, ctx.db, ctx.userId, tripId);
      return { text: was ? "Stopped sharing; the public link no longer works." : "This trip wasn't shared.", structured: { ok: true, was_shared: was } };
    },
  },
  {
    name: "get_shared_trip",
    title: "Read a shared trip",
    description:
      "Reads a public Waypack trip (a link like https://…/t/<token>/ or …/remix/<token>) so you can plan a new trip based on it. Returns its manifest (route geometry omitted) and the page's text. " +
      "Use it as a starting point, not a copy: adapt to the user's dates, group and pace, re-check hours, closures and conditions for the new season, " +
      "geocode any new places, recompute every route, set trip_id to null, and credit it (\"Based on a shared Waypack trip\") in the Overview.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "The shared trip link or remix link." } }, required: ["url"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, ctx) {
      try {
        const t = await sharedTripForAgent(ctx.env, ctx.db, str(args, "url")!);
        return {
          text:
            `Shared trip "${t.title}" (${t.share_url}).\n` +
            "Adapt it; don't copy it: new dates/season change hours, closures, daylight and gear. Recompute routes (geometry omitted below). Keep what the user liked.\n\n" +
            `manifest.json:\n\`\`\`json\n${JSON.stringify(t.manifest, null, 2)}\n\`\`\`\n\nPage text (index.html):\n${t.guide_text}\n\nOther files: ${t.files.join(", ")}`,
          structured: { ...t },
        };
      } catch (e) {
        if (e instanceof ShareError) throw new ToolError(e.message);
        throw e;
      }
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
  const up = await ctx.db.one<{ id: string; trip_id: string | null; object_key: string; status: string; expires_at: string; purpose: string; preview_id: string | null }>(
    "uploads",
    `select=*&id=${eq(id)}&user_id=${eq(ctx.userId)}`,
  );
  if (!up) throw new ToolError(`Upload ${id} not found. Call create_upload first.`);
  return up;
}

/** Soft-deletes the trip row and removes its R2 objects (bundles + tiles). */
export async function deleteTripData(env: Env, db: Db, userId: string, tripId: string): Promise<void> {
  await unshareTrip(env, db, userId, tripId);
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

async function runPush(ctx: ToolCtx, input: { previewId?: string; tripId?: string; files: BundleFile[]; deletes?: string[]; replace?: boolean }): Promise<ToolResult> {
  let r: PushResult;
  try {
    r = await pushPreview(ctx.env, ctx.db, ctx.userId, input);
  } catch (e) {
    if (e instanceof PreviewError) throw new ToolError(e.message);
    throw e;
  }
  return { text: formatPush(r), structured: { ...r } };
}

export function formatPush(r: PushResult): string {
  const v = r.validation;
  const list = (xs: { path: string; message: string }[]) => xs.slice(0, 8).map((x) => `  - ${x.path}: ${x.message}`).join("\n") + (xs.length > 8 ? `\n  … and ${xs.length - 8} more` : "");
  const status = v.ok
    ? `Valid${v.warnings.length ? ` with ${v.warnings.length} warning(s)` : ""}: ready to publish_preview when the user is happy.`
    : `Not publishable yet (fine while building). ${v.errors.length} error(s):\n${list(v.errors)}`;
  return [
    `Preview rev ${r.rev}${r.title ? ` of "${r.title}"` : ""}: ${r.preview_url}`,
    r.rev === 1
      ? "Give the user this link now: it opens on any phone or computer and refreshes itself each time you push."
      : "Open copies of the link refresh themselves.",
    `preview_id ${r.preview_id} (pass it to the next push_preview) · ${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB · expires ${r.expires_at.slice(0, 10)} unless pushed again.`,
    status,
  ].join("\n");
}
