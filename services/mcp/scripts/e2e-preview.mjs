// End-to-end checks for live previews against the local stack (supabase start + npm run dev).
//   node scripts/e2e-preview.mjs
// Uses a throwaway dev account; cleans up its previews and trips at the end.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const BASE = process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const PREVIEW = process.env.WAYPACK_PREVIEW_URL ?? "http://localhost:8787";
const bundleDir = new URL("../../../examples/tahoe-winter", import.meta.url).pathname;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; return cond; };

// ---- account + API token
const email = `preview+${Date.now()}@example.com`;
const signin = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: { "Content-Type": "application/json", "X-Waypack": "1" }, body: JSON.stringify({ email }) });
if (!signin.ok) throw new Error(`dev sign-in failed (${signin.status}); is \`npm run dev\` running?`);
const sess = await signin.json();
const cookie = signin.headers.get("set-cookie").split(";")[0];
const auth = { Authorization: `Bearer ${sess.access_token}`, "Content-Type": "application/json" };
const pat = (await (await fetch(`${BASE}/api/tokens`, { method: "POST", headers: auth, body: JSON.stringify({ label: "e2e-preview" }) })).json()).token;

let id = 0;
async function call(name, args = {}) {
  const r = await (await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  })).json();
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return { ...r.result, text: r.result.content?.map((c) => c.text).join("\n") ?? "" };
}

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const fileOf = (p) => ({ path: relative(bundleDir, p), content: readFileSync(p, "utf8"), encoding: "utf-8" });
const all = walk(bundleDir).map(fileOf);
const manifest = JSON.parse(all.find((f) => f.path === "manifest.json").content);

// ---- 1. skeleton push (manifest only, no page yet) creates a preview
const skeleton = { ...manifest, days: [], places: [], routes: [] };
let r = await call("push_preview", { files: [{ path: "manifest.json", content: JSON.stringify(skeleton) }] });
ok(!r.isError && r.structuredContent.rev === 1, "push_preview without preview_id creates a preview (rev 1)");
const pid = r.structuredContent.preview_id;
const url = r.structuredContent.preview_url;
ok(url.startsWith(`${PREVIEW}/t/`) && /\/t\/[A-Za-z0-9_-]{32}\/$/.test(url), `preview_url is on the preview origin: ${url}`);
ok(/Give the user this link/.test(r.text), "first push tells the agent to share the link");
ok(r.structuredContent.validation.ok === false, "an unfinished bundle is accepted and reported as not publishable");
const token = url.split("/t/")[1].replace(/\/$/, "");

let page = await fetch(url);
ok(page.status === 200 && /hasn't pushed the page yet/.test(await page.text()), "before index.html exists the link shows a waiting page");

// ---- 2. full push
r = await call("push_preview", { preview_id: pid, files: all });
ok(r.structuredContent.rev === 2 && r.structuredContent.files === all.length, `full push → rev 2 with ${all.length} files`);
ok(r.structuredContent.validation.ok === true, "the complete bundle validates");
page = await fetch(url);
const html = await page.text();
ok(page.status === 200 && html.includes('/__waypack/preview/live.js" data-rev="2"'), "index.html is served with the live-reload script (rev 2)");
ok((page.headers.get("content-security-policy") ?? "").includes("connect-src 'self'"), "HTML gets the app's CSP");
ok(page.headers.get("referrer-policy") === "no-referrer", "Referrer-Policy: no-referrer (the token never leaks to linked sites)");
ok(!page.headers.get("set-cookie"), "the preview origin sets no cookies");
const css = await fetch(`${url}assets/style.css`);
ok(css.status === 200 && (css.headers.get("content-type") ?? "").startsWith("text/css"), "assets are served with their content type");
const etag = css.headers.get("etag");
ok((await fetch(`${url}assets/style.css`, { headers: { "If-None-Match": etag } })).status === 304, "unchanged files answer 304 to If-None-Match");
let state = await (await fetch(`${PREVIEW}/__waypack/preview/${token}/state`)).json();
ok(state.rev === 2 && state.title === manifest.title, "state endpoint reports rev and title");

// ---- 3. incremental push: only index.html changes; everything else is kept
const index = all.find((f) => f.path === "index.html");
const edited = index.content.replace("</main>", '<p id="e2e-marker">updated by e2e</p></main>');
r = await call("push_preview", { preview_id: pid, files: [{ path: "index.html", content: edited }] });
ok(r.structuredContent.rev === 3 && r.structuredContent.files === all.length, "pushing one changed file keeps the others (rev 3)");
ok((await (await fetch(url)).text()).includes("e2e-marker"), "the change is live at the same link");
ok((await fetch(`${url}assets/style.css`)).status === 200, "untouched files are still served");

// ---- 4. delete a file
r = await call("push_preview", { preview_id: pid, delete: ["assets/scene.js"] });
ok(r.structuredContent.files === all.length - 1 && (await fetch(`${url}assets/scene.js`)).status === 404, "`delete` removes a file");
r = await call("push_preview", { preview_id: pid, files: [all.find((f) => f.path === "assets/scene.js")] });

// ---- 5. isolation and safety
ok((await fetch(`${BASE}/t/${token}/`)).status === 404, "the main origin never serves previews");
ok((await fetch(`${PREVIEW}/api/me`, { headers: { Cookie: cookie } })).status === 404, "the preview origin has no API (even with a session cookie)");
ok((await fetch(`${PREVIEW}/account`)).status === 404, "the preview origin doesn't serve the portal");
ok((await fetch(`${PREVIEW}/t/${"A".repeat(32)}/`)).status === 404, "unknown tokens are 404");
ok((await fetch(`${url}..%2f..%2fmanifest.json`)).status === 404, "encoded traversal finds nothing");
r = await call("push_preview", { preview_id: pid, files: [{ path: "../evil.html", content: "x" }] });
ok(r.isError && /\.\./.test(r.text), `unsafe paths are rejected (${r.text.slice(0, 60)})`);
r = await call("push_preview", { preview_id: "00000000-0000-4000-8000-000000000000", files: [{ path: "a.txt", content: "x" }] });
ok(r.isError && /not found/.test(r.text), "someone else's / unknown preview_id is rejected");

// ---- 6. map: online tiles through the same-origin proxy
const tiles = await (await fetch(`${PREVIEW}/__waypack/tiles/${token}/index.json`)).json();
ok(Array.isArray(tiles.extracts) && tiles.extracts.length === 0, "previews never use (or cut) offline extracts");
if (tiles.online) {
  const t = await fetch(`${PREVIEW}${tiles.online}`, { headers: { Range: "bytes=0-126" } });
  ok(t.status === 206 && (await t.arrayBuffer()).byteLength === 127, "online basemap is proxied with Range on the preview origin");
} else ok(true, "(no online basemap configured; skipped proxy check)");
ok((await fetch(`${PREVIEW}/__waypack/tiles/${"B".repeat(32)}/online.pmtiles`)).status === 404, "the tile proxy only works for live previews");

// ---- 7. list_trips shows the draft; it is not a trip yet
r = await call("list_trips");
ok(r.structuredContent.trips.length === 0 && r.structuredContent.previews.length === 1, "list_trips: no trips, one preview draft");
const appTrips = await (await fetch(`${BASE}/api/trips`, { headers: auth })).json();
ok(appTrips.trips.length === 0, "the app's trip list doesn't include drafts");

// ---- 8. publish → a real trip version; keep pushing → publish v2
r = await call("publish_preview", { preview_id: pid });
ok(!r.isError && r.structuredContent.version === 1 && r.structuredContent.trip_id, `publish_preview creates the trip (v1)`);
const tripId = r.structuredContent.trip_id;
state = await (await fetch(`${PREVIEW}/__waypack/preview/${token}/state`)).json();
ok(state.published_version === 1, "the preview remembers what it published");
r = await call("push_preview", { preview_id: pid, files: [{ path: "index.html", content: edited.replace("updated by e2e", "second round") }] });
ok(r.structuredContent.trip_id === tripId, "later pushes stay linked to the trip");
r = await call("publish_preview", { preview_id: pid });
ok(!r.isError && r.structuredContent.version === 2 && r.structuredContent.trip_id === tripId, "publishing again makes v2 of the same trip");
r = await call("push_preview", { trip_id: tripId, files: [{ path: "notes.txt", content: "hi" }] });
ok(r.structuredContent.preview_id === pid, "push_preview with trip_id reuses that trip's preview");

// ---- 9. invalid bundle can't be published
r = await call("push_preview", { files: [{ path: "manifest.json", content: "{}" }] });
const pid2 = r.structuredContent.preview_id;
r = await call("publish_preview", { preview_id: pid2 });
ok(r.isError, "publishing an invalid preview fails with its errors");

// ---- 10. CLI path: zip upload as a preview
const tmp = mkdtempSync(join(tmpdir(), "wp-prev-"));
const zipPath = join(tmp, "bundle.zip");
execFileSync("node", [new URL("../../../packages/cli/dist/cli.js", import.meta.url).pathname, "zip", bundleDir, "-o", zipPath], { stdio: "ignore" });
const size = statSync(zipPath).size;
r = await call("create_upload", { size_bytes: size, preview: true, preview_id: pid2 });
const put = await fetch(r.structuredContent.put_url, { method: "PUT", headers: { "Content-Type": "application/zip", "Content-Length": String(size) }, body: readFileSync(zipPath) });
ok(put.ok, "zip PUT for a preview upload");
r = await call("finalize_upload", { upload_id: r.structuredContent.upload_id });
ok(!r.isError && r.structuredContent.preview_id === pid2 && r.structuredContent.files === all.length && r.structuredContent.validation.ok, "finalize_upload with preview: true replaces the preview's files");
ok((await call("list_trips")).structuredContent.trips.length === 1, "a preview upload doesn't create a trip");

// ---- 11. portal API
const list = await (await fetch(`${BASE}/api/previews`, { headers: auth })).json();
ok(list.enabled && list.previews.length === 2, "portal API lists both previews");
const del = await fetch(`${BASE}/api/previews/${pid2}`, { method: "DELETE", headers: { Cookie: cookie, "X-Waypack": "1", Origin: BASE } });
ok(del.ok, "portal can delete a preview");
ok((await fetch(`${PREVIEW}/__waypack/preview/${list.previews.find((p) => p.preview_id === pid2).preview_url.split("/t/")[1].replace("/", "")}/state`)).status === 404, "a deleted preview's link stops working");

// ---- 12. the trip a draft revised was deleted → publishing makes a new trip
await call("delete_trip", { trip_id: tripId, confirm: true });
r = await call("publish_preview", { preview_id: pid });
ok(!r.isError && r.structuredContent.trip_id !== tripId && r.structuredContent.version === 1, "after its trip is deleted, a draft publishes as a new trip");
const tripId2 = r.structuredContent.trip_id;

// ---- cleanup
await call("delete_preview", { preview_id: pid });
ok((await fetch(url)).status === 404, "delete_preview → link is dead");
await call("delete_trip", { trip_id: tripId2, confirm: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nall preview checks passed");
process.exit(failures ? 1 : 0);
