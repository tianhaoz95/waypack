# Uploading a bundle

All tools are on the Waypack MCP server (`https://waypack.app/mcp`). Sign-in happens via OAuth the first time a tool is used.

## Live preview (recommended while building)
A preview is a **draft** with its own link that anyone can open on any device; open pages reload themselves when you push. It isn't in the app, doesn't count toward trip limits and doesn't cut offline maps (the page uses the online map).

- **Push:** `push_preview { "files": [...] }` → `{ preview_id, preview_url, rev, validation }`. Show the user `preview_url`.
- **Push changes:** `push_preview { "preview_id": "...", "files": [only the changed files], "delete"?: ["old/file.css"] }`. `"replace": true` drops every file not in this push.
- **Revise a published trip:** `push_preview { "trip_id": "...", "files": [...] }` (reuses that trip's preview if it has one).
- **CLI agents:** push the whole zip as a preview: `create_upload { "size_bytes": n, "preview": true, "preview_id"?: "..." }` → `curl -T` → `finalize_upload` (replaces all the preview's files).
- **Publish:** `publish_preview { "preview_id": "..." }` → same response as `finalize_upload`. Fails with the validation errors if the bundle isn't valid yet.
- **Clean up:** `delete_preview { "preview_id": "..." }`. Unpublished previews expire 14 days after the last push.
- Limits: 4 MB per `push_preview` call, 25 MB / 2,000 files per preview, 10 open previews per account.

## Sharing and remixing
- `share_trip { "trip_id", "files"? }` → `{ share_url, remix_url, redactions }`. Public read-only page (+ "Plan this trip" button → `remix_url`). Sharing again moves the same link to the current version. Pass `files` to share a copy with personal details removed.
- `unshare_trip { "trip_id" }` → the link stops working. Deleting a trip also stops sharing it.
- `get_shared_trip { "url" }` → `{ manifest (route geometry omitted), guide_text }` to plan a new trip from someone's shared one. Adapt, don't copy.

## CLI agents (filesystem + shell)
1. `npx @waypack/cli validate ./waypack/<slug>` → fix errors.
2. `npx @waypack/cli zip ./waypack/<slug> -o ./waypack/<slug>.zip` (prints `size_bytes`).
3. MCP `create_upload { "trip_id"?: "<uuid for updates>", "size_bytes": <n> }` → `{ upload_id, put_url, expires_at }`.
4. `curl -fsS -X PUT -H "Content-Type: application/zip" -T ./waypack/<slug>.zip "<put_url>"`
5. MCP `finalize_upload { "upload_id": "<id>" }` → `{ trip_id, version, status, app_hint }`.
6. MCP `get_trip_status { "trip_id" }` until `status: "ready"`.

If `finalize_upload` returns validation errors, fix, re-zip, and repeat from step 3 (upload ids are single-use).

## Chat agents (no shell)
`upload_bundle_inline { "trip_id"?: "...", "files": [ { "path": "manifest.json", "content": "{...}", "encoding": "utf-8" }, { "path": "assets/photo.webp", "content": "<base64>", "encoding": "base64" } ] }`
- ≤ 4 MB total. Prefer inline SVG and few/no photos.
- Same response as `finalize_upload`.

## Updating
- `list_trips` → find the trip; `get_trip { trip_id }` → the latest published `manifest.json` + `index.html` (+ `paths` for other files, `download_url` for the whole zip).
- Revise those files (see SKILL.md, "Updating an existing trip"), then `push_preview { trip_id, files: [changed files only], note }` and `publish_preview` when the user approves. A direct upload with `manifest.trip_id` set also publishes a new version (no preview).
- The app shows "Update available". Map tiles are re-cut only if `map` changed.

## Limits (free tier)
Free accounts get 1 active trip and no offline map extract (the map needs a connection). Plans are managed at https://waypack.app/account. If a tool returns a limit message, show it to the user verbatim; don’t retry.
