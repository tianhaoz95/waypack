# Uploading a bundle

All tools are on the Waypack MCP server (`https://waypack.app/mcp`). Sign-in happens via OAuth the first time a tool is used.

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
- `list_trips` → find the trip; `get_trip { trip_id }` → current manifest.
- Set `manifest.trip_id` to that id, change what's needed, upload again. The app shows "Update available".
- Map tiles are re-cut only if `map` changed.

## Limits (free tier)
Free accounts get 1 active trip and no offline map extract (the map needs a connection). Plans are managed at https://waypack.app/account. If a tool returns a limit message, show it to the user verbatim; don’t retry.
