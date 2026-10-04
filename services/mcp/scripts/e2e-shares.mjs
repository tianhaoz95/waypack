// End-to-end checks for public, remixable trips against the local stack (supabase start + npm run dev).
//   node scripts/e2e-shares.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BASE = process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const PREVIEW = process.env.WAYPACK_PREVIEW_URL ?? "http://localhost:8787";
const bundleDir = new URL("../../../examples/tahoe-winter", import.meta.url).pathname;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; return cond; };

async function account(label) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: { "Content-Type": "application/json", "X-Waypack": "1" }, body: JSON.stringify({ email: `${label}+${Date.now()}@example.com` }) });
  if (!r.ok) throw new Error(`dev sign-in failed (${r.status}); is \`npm run dev\` running?`);
  const s = await r.json();
  const auth = { Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" };
  const pat = (await (await fetch(`${BASE}/api/tokens`, { method: "POST", headers: auth, body: JSON.stringify({ label: "e2e" }) })).json()).token;
  let id = 0;
  const call = async (name, args = {}) => {
    const j = await (await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    })).json();
    return { ...j.result, text: j.result.content?.map((c) => c.text).join("\n") ?? "" };
  };
  return { auth, call, userId: s.userId };
}

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(bundleDir).map((p) => ({ path: relative(bundleDir, p), content: readFileSync(p, "utf8") }));
const manifest = JSON.parse(files.find((f) => f.path === "manifest.json").content);
// Give the lodging a real-looking confirmation number to check redaction.
manifest.places = manifest.places.map((p) => (p.category === "lodging" ? { ...p, notes: `${p.notes ?? ""} Confirmation #WP84217.` } : p));
const withConf = files.map((f) => (f.path === "manifest.json" ? { ...f, content: JSON.stringify(manifest) } : f));

const owner = await account("owner");
const stranger = await account("stranger");

let r = await owner.call("upload_bundle_inline", { files: withConf });
ok(!r.isError, "owner publishes a trip");
const tripId = r.structuredContent.trip_id;

// ---- share
r = await stranger.call("share_trip", { trip_id: tripId });
ok(r.isError, "someone else can't share your trip");
r = await owner.call("share_trip", { trip_id: tripId });
ok(!r.isError && r.structuredContent.share_url.startsWith(`${PREVIEW}/t/`) && r.structuredContent.remix_url.startsWith(`${BASE}/remix/`), "share_trip returns a public page (preview origin) and a remix page (main site)");
ok(r.structuredContent.redactions >= 1, `booking numbers masked (${r.structuredContent.redactions})`);
const { share_url, remix_url } = r.structuredContent;
const token = share_url.split("/t/")[1].replace("/", "");

const page = await fetch(share_url);
const html = await page.text();
ok(page.status === 200 && html.includes(`/__waypack/share.js" data-remix="${remix_url}"`), "shared page carries the Plan-this-trip banner");
ok(!html.includes("/__waypack/preview/live.js"), "shared pages don't live-reload");
ok((page.headers.get("content-security-policy") ?? "").includes("connect-src 'self'") && page.headers.get("referrer-policy") === "no-referrer", "same CSP + no-referrer as previews");
const sharedManifest = await (await fetch(`${share_url}manifest.json`)).json();
ok(sharedManifest.trip_id === null, "the shared manifest has no trip_id");
ok(!JSON.stringify(sharedManifest).includes("WP84217") && JSON.stringify(sharedManifest).includes("Confirmation #••••"), "the confirmation number is masked in what strangers see");
ok((await (await fetch(`${PREVIEW}/__waypack/tiles/${token}/index.json`)).json()).online !== undefined, "shared pages get the online map");
ok((await fetch(`${BASE}/t/${token}/`)).status === 404, "the main origin never serves shared pages");

// ---- remix page + public data
const pub = await (await fetch(`${BASE}/api/public/shares/${token}`)).json();
ok(pub.title === manifest.title && pub.share_url === share_url && !("files" in pub) && !("user_id" in pub) && !("trip_id" in pub), "public summary: title and links only (no owner, files or trip id)");
const remixPage = await fetch(remix_url);
ok(remixPage.status === 200 && (await remixPage.text()).includes("Plan this trip for yourself"), "remix page is served on the main site");
ok((await fetch(`${BASE}/api/public/shares/${"Z".repeat(32)}`)).status === 404, "unknown share → 404");

// ---- a stranger's agent reads it
r = await stranger.call("get_shared_trip", { url: remix_url });
ok(!r.isError && r.structuredContent.manifest.title === manifest.title, "get_shared_trip works from the remix link");
ok(r.structuredContent.manifest.routes.every((x) => typeof x.geometry === "string"), "route geometry is omitted (agent recomputes)");
ok(r.structuredContent.guide_text.length > 500 && !/<[a-z]/i.test(r.structuredContent.guide_text.slice(0, 2000)), "guide text is plain text");
ok(/Adapt it; don't copy it/.test(r.text), "the tool tells the agent to adapt, not copy");
ok((await (await fetch(`${BASE}/api/public/shares/${token}`)).json()).remix_count === 1, "remix count goes up");

// ---- update: publish v2, share again → same link, new version
r = await owner.call("upload_bundle_inline", { trip_id: tripId, files: withConf.map((f) => (f.path === "index.html" ? { ...f, content: f.content.replace("</main>", "<p>v2 marker</p></main>") } : f)) });
ok(r.structuredContent.version === 2, "owner publishes v2");
r = await owner.call("share_trip", { trip_id: tripId });
ok(r.structuredContent.share_url === share_url && r.structuredContent.version === 2, "sharing again keeps the link and moves it to v2");
ok((await (await fetch(share_url)).text()).includes("v2 marker"), "the public page shows v2");

// ---- agent-cleaned copy instead of the published files
r = await owner.call("share_trip", { trip_id: tripId, files: files.map((f) => (f.path === "index.html" ? { ...f, content: f.content.replace("</main>", "<p>cleaned copy</p></main>") } : f)) });
ok(!r.isError && (await (await fetch(share_url)).text()).includes("cleaned copy"), "share_trip with `files` shares the agent's cleaned copy");

// ---- portal
const list = await (await fetch(`${BASE}/api/shares`, { headers: owner.auth })).json();
ok(list.enabled && list.shares.length === 1 && list.shares[0].trip_id === tripId, "portal lists the share");
const stop = await fetch(`${BASE}/api/trips/${tripId}/share`, { method: "DELETE", headers: owner.auth });
ok(stop.ok && (await fetch(share_url)).status === 404, "stop sharing → the public page is gone");
r = await stranger.call("get_shared_trip", { url: share_url });
ok(r.isError && /no longer shared/.test(r.text), "get_shared_trip on a stopped share explains it");
ok((await fetch(remix_url)).status === 200, "remix page still loads (and says the trip isn't shared anymore)");

// ---- deleting a trip kills its share
r = await owner.call("share_trip", { trip_id: tripId });
const url2 = r.structuredContent.share_url;
await owner.call("delete_trip", { trip_id: tripId, confirm: true });
ok((await fetch(url2)).status === 404, "deleting the trip stops sharing it");

console.log(failures ? `\n${failures} check(s) failed` : "\nall share checks passed");
process.exit(failures ? 1 : 0);
