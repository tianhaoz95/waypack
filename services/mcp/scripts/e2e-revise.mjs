// End-to-end checks for revising a published trip (DECISIONS #51) against the local stack.
//   node scripts/e2e-revise.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BASE = process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const PREVIEW = process.env.WAYPACK_PREVIEW_URL ?? "http://localhost:8787";
const bundleDir = new URL("../../../examples/tahoe-winter", import.meta.url).pathname;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; return cond; };

const r0 = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: { "Content-Type": "application/json", "X-Waypack": "1" }, body: JSON.stringify({ email: `revise+${Date.now()}@example.com` }) });
if (!r0.ok) throw new Error(`dev sign-in failed (${r0.status}); is \`npm run dev\` running?`);
const sess = await r0.json();
const pat = (await (await fetch(`${BASE}/api/tokens`, { method: "POST", headers: { Authorization: `Bearer ${sess.access_token}`, "Content-Type": "application/json" }, body: "{}" })).json()).token;
let id = 0;
async function call(name, args = {}) {
  const j = await (await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  })).json();
  return { ...j.result, text: j.result.content?.map((c) => c.text).join("\n") ?? "" };
}

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(bundleDir).map((p) => ({ path: relative(bundleDir, p), content: readFileSync(p, "utf8") }));

// v1: published directly (no preview), like most trips.
let r = await call("upload_bundle_inline", { files });
const tripId = r.structuredContent.trip_id;
ok(r.structuredContent.version === 1, "trip published as v1");

// ---- get_trip returns the latest files as the base
r = await call("get_trip", { trip_id: tripId });
const got = Object.fromEntries(r.structuredContent.files.map((f) => [f.path, f.content]));
ok(got["manifest.json"] && got["index.html"]?.includes("<html"), "get_trip returns manifest.json and index.html in full");
ok(r.structuredContent.other_files.some((f) => f.path === "assets/style.css"), "other files are listed, not inlined");
ok(/push_preview \{ trip_id, files: \[changed files only\], note \}/.test(r.text), "get_trip tells the agent how to revise");
const zip = await fetch(r.structuredContent.download_url);
ok(zip.ok && (await zip.arrayBuffer()).byteLength > 1000, "download_url serves the whole bundle (CLI agents)");
r = await call("get_trip", { trip_id: tripId, paths: ["*"] });
ok(r.structuredContent.files.some((f) => f.path === "assets/app.js"), 'paths: ["*"] returns every text file');
const v1all = Object.fromEntries(r.structuredContent.files.map((f) => [f.path, f.content]));

// ---- revise: push only index.html; the preview starts from v1
const revised = got["index.html"].replace("</main>", '<p id="rev-marker">Booked: The Landing</p></main>');
r = await call("push_preview", { trip_id: tripId, files: [{ path: "index.html", content: revised }], note: "Booked The Landing; re-planned day 1" });
ok(!r.isError && r.structuredContent.based_on_version === 1, "push_preview { trip_id } starts from the published version");
ok(r.structuredContent.files === files.length && r.structuredContent.validation.ok, `the preview holds the full bundle (${r.structuredContent.files} files) and validates after a one-file push`);
ok(/Started from published version 1/.test(r.text), "the agent is told it started from v1");
const pid = r.structuredContent.preview_id;
const url = r.structuredContent.preview_url;
const token = url.split("/t/")[1].replace("/", "");
ok((await (await fetch(url)).text()).includes("rev-marker"), "the change is in the preview");
ok((await fetch(`${url}assets/style.css`)).status === 200, "untouched files come from the published version");
const state = await (await fetch(`${PREVIEW}/__waypack/preview/${token}/state`)).json();
ok(state.note === "Booked The Landing; re-planned day 1", "viewers see the agent's note");

// ---- publish → v2 with the change and everything else intact
r = await call("publish_preview", { preview_id: pid });
ok(!r.isError && r.structuredContent.version === 2 && r.structuredContent.trip_id === tripId, "publish_preview makes v2 of the same trip");
r = await call("get_trip", { trip_id: tripId, paths: ["*"] });
const v2 = Object.fromEntries(r.structuredContent.files.map((f) => [f.path, f.content]));
ok(r.structuredContent.version === 2 && v2["index.html"].includes("rev-marker") && v2["assets/app.js"] === v1all["assets/app.js"], "v2 has the edit and the unchanged files");

// ---- a newer version published elsewhere: the next revision re-bases onto it
r = await call("upload_bundle_inline", { trip_id: tripId, files: files.map((f) => (f.path === "index.html" ? { ...f, content: f.content.replace("</main>", '<p id="v3-marker">v3</p></main>') } : f)) });
ok(r.structuredContent.version === 3, "v3 published directly (e.g. from another conversation)");
r = await call("push_preview", { trip_id: tripId, files: [{ path: "notes.txt", content: "packing: chains" }], note: "Added packing note" });
ok(r.structuredContent.based_on_version === 3 && r.structuredContent.preview_id === pid, "the same preview re-bases onto v3 (no stale base)");
const html = await (await fetch(url)).text();
ok(html.includes("v3-marker") && !html.includes("rev-marker"), "the preview now shows v3 + the new change, not the old base");

// ---- a preview_id push keeps building on itself (no re-base)
r = await call("push_preview", { preview_id: pid, files: [{ path: "notes.txt", content: "packing: chains, sleds" }] });
ok(r.structuredContent.based_on_version === null && r.structuredContent.files === files.length + 1, "pushing by preview_id continues the draft");

await call("delete_preview", { preview_id: pid });
await call("delete_trip", { trip_id: tripId, confirm: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall revision checks passed");
process.exit(failures ? 1 : 0);
