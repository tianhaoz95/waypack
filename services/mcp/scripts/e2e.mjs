// End-to-end test against a running stack:
//   supabase start · docker run -p 8090:8080 waypack-tiler · npm run dev (services/mcp)
// Exercises MCP OAuth (DCR + PKCE + email OTP via Mailpit), every tool, the upload
// pipeline, tile extraction, entitlement limits and the app download API.
//
//   node scripts/e2e.mjs [--bundle ../../examples/sequoia-winter]
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const BASE = process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const SUPA = process.env.SUPABASE_URL ?? "http://127.0.0.1:55421";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:55424";
const bundleDir = process.argv.includes("--bundle") ? process.argv[process.argv.indexOf("--bundle") + 1] : new URL("../../../examples/sequoia-winter", import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; return cond; };
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- tiny cookie jar ---
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function keep(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return res;
}
const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function latestCode(email) {
  for (let i = 0; i < 20; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    const msg = list.messages?.[0];
    if (msg) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
      const code = (full.Text || full.HTML).match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await sleep(500);
  }
  throw new Error("no OTP email arrived");
}

// --- 1. discovery ---
const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
ok(unauth.status === 401, `unauthenticated /mcp → 401 (${unauth.status})`);
ok(/resource_metadata=/.test(unauth.headers.get("WWW-Authenticate") ?? ""), "WWW-Authenticate points at resource metadata");
const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
ok(prm.resource === `${BASE}/mcp`, `protected resource metadata (${prm.resource})`);
const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
ok(!!as.registration_endpoint && as.code_challenge_methods_supported?.includes("S256"), "AS metadata with DCR + S256");

// --- 2. dynamic client registration ---
const redirect = "http://127.0.0.1:9999/callback";
const reg = await (await fetch(as.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "Waypack E2E", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
})).json();
ok(!!reg.client_id, `registered client ${reg.client_id}`);

// --- 3. authorize with email OTP ---
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(8));
const authUrl = new URL(as.authorization_endpoint);
Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope: "mcp", resource: `${BASE}/mcp` }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
let res = keep(await fetch(authUrl, { headers: { Cookie: cookieHeader() } }));
let html = await res.text();
ok(res.status === 200 && html.includes("Waypack E2E"), "authorize page shows the client name");
const email = `e2e+${Date.now()}@example.com`;
const post = async (form) => keep(await fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader() }, body: new URLSearchParams(form) }));
const handle = field(html, "handle"), details = field(html, "details");
res = await post({ handle, details, email, step: "send_code" });
html = await res.text();
ok(html.includes("Enter your code"), "code page after sending OTP");
const code = await latestCode(email);
ok(/^\d{6}$/.test(code), `received OTP via Mailpit`);
res = await post({ handle, details, email, code: "000000", step: "verify" });
{ const t = await res.text(); ok(t.includes("didn&#39;t work") || t.includes("didn.t work"), "wrong code is rejected"); }
res = await post({ handle, details, email, code, step: "verify" });
const loc = res.headers.get("Location") ?? "";
ok(res.status === 302 && loc.startsWith(redirect), `redirected to client (${res.status})`);
const cb = new URL(loc);
ok(cb.searchParams.get("state") === state, "state round-trips");

// --- 4. token exchange ---
const tok = await (await fetch(as.token_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: cb.searchParams.get("code"), redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
})).json();
ok(!!tok.access_token, "access token issued");
ok(!!tok.refresh_token, "refresh token issued");

// --- 5. MCP ---
let rpcId = 0;
async function rpc(method, params, token = tok.access_token) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const call = async (name, args = {}, token) => {
  const r = await rpc("tools/call", { name, arguments: args }, token);
  return { ...r, text: r.content?.[0]?.text ?? "" };
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
ok(init.serverInfo?.name === "waypack" && init.protocolVersion === "2025-06-18", `initialize (${init.protocolVersion})`);
const list = await rpc("tools/list", {});
const names = list.tools.map((t) => t.name);
ok(names.length === 11, `tools/list → ${names.join(", ")}`);

const guide = await call("get_authoring_guide", {});
ok(guide.text.includes("Coverage checklist") || guide.text.includes("coverage checklist"), "get_authoring_guide returns the guide");
const tmpl = await call("get_authoring_guide", { section: "template" });
ok(tmpl.text.includes("### index.html"), "template section includes starter files");

const geo = await call("geocode", { query: "Wuksachi Lodge, Sequoia National Park" });
ok(!geo.isError && geo.structuredContent.results.length > 0, `geocode → ${geo.structuredContent?.results?.[0]?.lat}, ${geo.structuredContent?.results?.[0]?.lon}`);
const route = await call("compute_route", { from: { lat: 36.6096, lon: -118.75202 }, to: { lat: 36.5964, lon: -118.733 }, mode: "driving" });
ok(!route.isError && route.structuredContent.geometry.coordinates.length > 10, `compute_route → ${route.structuredContent?.distance_m} m`);
const badRoute = await call("compute_route", { from: { lat: 200, lon: 0 }, to: { lat: 0, lon: 0 } });
ok(badRoute.isError && /must be \{lat, lon\}/.test(badRoute.text), "compute_route rejects bad coordinates with a hint");

// Bundle files
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(bundleDir).map((p) => ({ path: relative(bundleDir, p), content: readFileSync(p, "utf8"), encoding: "utf-8" }));
const val = await call("validate_bundle", { files });
ok(val.structuredContent.ok, `validate_bundle ok (${val.structuredContent.warnings.length} warnings)`);

// New accounts start on the free plan: no offline map, 1 active trip.
// CLI-style upload: zip → create_upload → PUT → finalize_upload
const zipPath = "/tmp/waypack-e2e.zip";
execSync(`node ${new URL("../../../packages/cli/dist/cli.js", import.meta.url).pathname} zip ${bundleDir} -o ${zipPath}`, { stdio: "ignore" });
const zip = readFileSync(zipPath);
const cu = await call("create_upload", { size_bytes: zip.byteLength });
if (cu.isError) console.log(cu.text);
ok(!!cu.structuredContent.put_url, "create_upload → put_url");
const put = await fetch(cu.structuredContent.put_url, { method: "PUT", headers: { "Content-Type": "application/zip", "Content-Length": String(zip.byteLength) }, body: zip });
ok(put.ok, `PUT bundle (${put.status})`);
const tampered = await fetch(cu.structuredContent.put_url.replace(/sig=[^&]+/, "sig=AAAA"), { method: "PUT", body: zip });
ok(tampered.status === 403, "tampered upload signature → 403");
const fin = await call("finalize_upload", { upload_id: cu.structuredContent.upload_id });
ok(!fin.isError && fin.structuredContent.version === 1, `finalize_upload → trip ${fin.structuredContent.trip_id} v1`);
ok(fin.structuredContent.tiles_status === "not_included", `free plan: tiles not included (${fin.structuredContent.tiles_status})`);
const tripId = fin.structuredContent.trip_id;
const again = await call("finalize_upload", { upload_id: cu.structuredContent.upload_id });
ok(again.isError, "upload ids are single-use");

// Free limit: a second active trip is refused with an upgrade message.
const second = await call("upload_bundle_inline", { files });
ok(second.isError && second.structuredContent.upgrade_required && /Upgrade/.test(second.text), "free plan: 2nd active trip → clear upgrade message");

// Upgrade (as RevenueCat would) → new version gets an offline map.
const uid = (await (await fetch(`${SUPA}/rest/v1/trips?select=user_id&id=eq.${tripId}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } })).json())[0].user_id;
await fetch(`${SUPA}/rest/v1/entitlements?user_id=eq.${uid}`, {
  method: "PATCH",
  headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ tier: "annual", active: true, expires_at: new Date(Date.now() + 365 * 86400000).toISOString() }),
});
const v2 = await call("upload_bundle_inline", { trip_id: tripId, files });
ok(!v2.isError && v2.structuredContent.version === 2 && v2.structuredContent.tiles_status === "processing", `inline update → v2, tiles ${v2.structuredContent.tiles_status}`);

let st;
for (let i = 0; i < 60; i++) {
  st = await call("get_trip_status", { trip_id: tripId });
  if (st.structuredContent.status !== "processing") break;
  await sleep(3000);
}
ok(st.structuredContent.status === "ready" && st.structuredContent.tiles_status === "ready", `get_trip_status → ${st.text}`);
ok(st.structuredContent.extracts.length === 2, `2 map areas extracted (${st.structuredContent.extracts.map((e) => e.bytes).join(", ")} bytes)`);

// Same map → no re-cut on v3.
const v3 = await call("upload_bundle_inline", { trip_id: tripId, files });
ok(!v3.isError && v3.structuredContent.tiles_status === "ready", `unchanged map is not re-cut (v3 tiles ${v3.structuredContent.tiles_status})`);

const lt = await call("list_trips");
ok(lt.structuredContent.trips.some((t) => t.trip_id === tripId && t.version === 3), "list_trips shows v3");
const gt = await call("get_trip", { trip_id: tripId });
ok(gt.structuredContent.manifest.trip_id === tripId, "get_trip manifest carries trip_id");

// --- 6. app API with a Supabase session (the mobile app's path) ---
await fetch(`${SUPA}/auth/v1/otp`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
await sleep(1200);
const code2 = await latestCode(email);
const sess = await (await fetch(`${SUPA}/auth/v1/verify`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ type: "email", email, token: code2 }) })).json();
ok(!!sess.access_token, "app sign-in via Supabase OTP");
const H = { Authorization: `Bearer ${sess.access_token}` };
const me = await (await fetch(`${BASE}/api/me`, { headers: H })).json();
ok(me.plan?.tier === "annual", `/api/me → ${me.plan?.tier}`);
const dl = await (await fetch(`${BASE}/api/trips/${tripId}/download`, { headers: H })).json();
ok(dl.version === 3 && dl.tiles.length === 2, `/download → v${dl.version}, ${dl.tiles.length} tile files`);
const bz = Buffer.from(await (await fetch(dl.bundle.url)).arrayBuffer());
ok(createHash("sha256").update(bz).digest("hex") === dl.bundle.sha256, "bundle download matches sha256");
const rng = await fetch(dl.tiles[0].url, { headers: { Range: "bytes=0-6" } });
ok(rng.status === 206 && Buffer.from(await rng.arrayBuffer()).toString() === "PMTiles", "tiles support HTTP Range (PMTiles magic)");
const full = Buffer.from(await (await fetch(dl.tiles[0].url)).arrayBuffer());
ok(createHash("sha256").update(full).digest("hex") === dl.tiles[0].sha256, "tile download matches sha256");

// RLS: the app can read its own trip summary straight from Supabase.
const rls = await (await fetch(`${SUPA}/rest/v1/trip_summaries?select=id,title,current_version`, { headers: { apikey: env.SUPABASE_ANON_KEY, ...H } })).json();
ok(rls.length === 1 && rls[0].id === tripId, "RLS: trip_summaries shows only the user's trip");

// Personal API token (headless MCP)
const pat = await (await fetch(`${BASE}/api/tokens`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ label: "e2e" }) })).json();
const viaPat = await call("list_trips", {}, pat.token);
ok(viaPat.structuredContent.trips.length === 1, "personal API token works for MCP");

// --- 7. delete ---
const delNo = await call("delete_trip", { trip_id: tripId, confirm: false });
ok(delNo.isError, "delete_trip requires confirm: true");
const del = await call("delete_trip", { trip_id: tripId, confirm: true });
ok(!del.isError, "delete_trip");
const gone = await fetch(dl.bundle.url);
ok(gone.status === 404, "deleted bundle is gone from storage");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
