// End-to-end test against a running stack:
//   supabase start · docker run -p 8090:8080 waypack-tiler · npm run dev (services/mcp)
// Exercises MCP OAuth (DCR + PKCE, email + password sign-in), every tool, the upload
// pipeline, tile extraction, entitlement limits and the app download API.
//
//   node scripts/e2e.mjs [--bundle ../../examples/sequoia-winter]
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const BASE = process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const SUPA = process.env.SUPABASE_URL ?? "http://127.0.0.1:55421";
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

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:55424";
const PASSWORD = "correct horse battery";
const JH = { "Content-Type": "application/json", "X-Waypack": "1" };
const portal = (path, body, headers = JH) => fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

async function latestCode(to) {
  for (let i = 0; i < 30; i++) {
    const l = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json();
    if (l.messages?.[0]) {
      const m = await (await fetch(`${MAILPIT}/api/v1/message/${l.messages[0].ID}`)).json();
      const c = (m.Text || m.HTML).match(/\b(\d{6})\b/)?.[1];
      if (c) return c;
    }
    await sleep(500);
  }
  throw new Error("no reset email arrived");
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

// --- 3. authorize: email + password ---
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(8));
const authUrl = new URL(as.authorization_endpoint);
Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope: "mcp", resource: `${BASE}/mcp` }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
let res = keep(await fetch(authUrl, { headers: { Cookie: cookieHeader() } }));
let html = await res.text();
ok(res.status === 200 && html.includes("Waypack E2E"), "authorize page shows the client name");
ok(html.includes('type="password"') && html.includes("Forgot password?"), "authorize page asks for email + password");
ok(!/Continue with (Google|Apple)|Email me a code/.test(html), "no social or email-code sign-in");
const post = async (form) => keep(await fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader() }, body: new URLSearchParams(form) }));
const handle = field(html, "handle"), details = field(html, "details");
const email = `e2e+${Date.now()}@example.com`;

res = await post({ handle, details, step: "show_signup" });
ok((await res.text()).includes("Create account and allow"), "create-account mode");
res = await post({ handle, details, step: "signup", email, password: "short" });
ok((await res.text()).includes("at least 8 characters"), "short passwords are rejected");
res = await post({ handle, details, step: "signin", email, password: PASSWORD });
ok((await res.text()).includes("Wrong email or password"), "unknown account → wrong email or password");
await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
res = await post({ handle, details, step: "signup", email, password: PASSWORD });
const loc = res.headers.get("Location") ?? "";
ok(res.status === 302 && loc.startsWith(redirect), `sign up on the authorize page → redirected to client (${res.status})`);
const cb = new URL(loc);
ok(cb.searchParams.get("state") === state, "state round-trips");
const mails = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
ok((mails.messages ?? []).length === 0, "sign-up sends no email");

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

// Upgrade through a signed Stripe webhook (what Checkout triggers in production).
const uid = (await (await fetch(`${SUPA}/rest/v1/trips?select=user_id&id=eq.${tripId}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } })).json())[0].user_id;
async function stripeEvent(type, object) {
  const payload = JSON.stringify({ id: `evt_${randomBytes(6).toString("hex")}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  return fetch(`${BASE}/stripe/webhook`, { method: "POST", headers: { "Stripe-Signature": `t=${t},v1=${sig}`, "Content-Type": "application/json" }, body: payload });
}
const forged = await fetch(`${BASE}/stripe/webhook`, { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00" }, body: "{}" });
ok(forged.status === 400, "Stripe webhook rejects bad signatures");
const subObj = { id: "sub_e2e", status: "active", customer: `cus_e2e_${Date.now()}`, metadata: { user_id: uid }, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400 }] } };
const wh = await (await stripeEvent("customer.subscription.created", subObj)).json();
ok(wh.tier === "annual", `Stripe subscription.created → ${wh.tier}`);
const afterUpgrade = await call("get_trip_status", { trip_id: tripId });
ok(["processing", "ready"].includes(afterUpgrade.structuredContent.tiles_status), `trip published on free plan gets an offline map after upgrade (${afterUpgrade.structuredContent.tiles_status})`);

const v2 = await call("upload_bundle_inline", { trip_id: tripId, files });
ok(!v2.isError && v2.structuredContent.version === 2 && ["processing", "ready"].includes(v2.structuredContent.tiles_status), `inline update → v2, tiles ${v2.structuredContent.tiles_status}`);

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
// The app signs in with Supabase's password grant directly.
const sess = await (await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) })).json();
ok(!!sess.access_token, "app sign-in with email + password");
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

// --- 7. web portal (same origin: site + API) ---
const acct = await fetch(`${BASE}/account`);
ok(acct.status === 200 && (await acct.text()).includes("Your account"), "/account portal page is served by the Worker");
const home = await fetch(`${BASE}/`);
ok(home.status === 200 && (await home.text()).includes("Waypack keeps it working offline"), "landing page is served by the Worker");
ok((await portal("/api/auth/signin", { email, password: PASSWORD }, { "Content-Type": "application/json" })).status === 403, "portal auth requires the X-Waypack header (CSRF)");
ok((await portal("/api/auth/send-code", { email })).status === 404, "email-code sign-in endpoint does not exist");
ok((await portal("/api/auth/signin", { email, password: "wrong password" })).status === 401, "portal: wrong password → 401");
ok((await portal("/api/auth/signup", { email, password: PASSWORD })).status === 409, "portal: signing up twice → 409");
let pr = await portal("/api/auth/signin", { email, password: PASSWORD });
let cookieHdr = cookieOf(pr);
ok(pr.ok && cookieHdr.includes("wp_session="), "portal sign-in sets a session cookie");

// Forgot password: one email with a 6-digit code (never a sign-in link).
await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
const rq = await (await portal("/api/auth/reset/request", { email })).json();
ok(/If an account exists/.test(rq.message), "reset request doesn't reveal whether an account exists");
const resetCode = await latestCode(email);
ok((await portal("/api/auth/reset/confirm", { email, code: "000000", password: "brand new password" })).status === 400, "wrong reset code is rejected");
const NEWPW = "brand new password 2";
pr = await portal("/api/auth/reset/confirm", { email, code: resetCode, password: NEWPW });
ok(pr.ok, "reset with the emailed code sets a new password and signs in");
ok((await portal("/api/auth/signin", { email, password: PASSWORD })).status === 401, "old password no longer works");
pr = await portal("/api/auth/signin", { email, password: NEWPW });
ok(pr.ok, "new password works");
cookieHdr = cookieOf(pr);

// Lockout after repeated failures (separate account so the rest of the run isn't affected).
const victim = `lock+${Date.now()}@example.com`;
await portal("/api/auth/signup", { email: victim, password: PASSWORD });
let last;
for (let i = 0; i < 11; i++) last = await portal("/api/auth/signin", { email: victim, password: "nope nope nope" });
ok(last.status === 429, "10 failed sign-ins lock the account for 15 minutes");
const pme = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookieHdr } })).json();
ok(pme.plan?.tier === "annual" && pme.billing?.has_subscription === true, `portal /api/me → ${pme.plan?.tier}, subscription linked`);
const csrf = await fetch(`${BASE}/api/tokens`, { method: "POST", headers: { Cookie: cookieHdr, "Content-Type": "application/json" }, body: "{}" });
ok(csrf.status === 401, "cookie-authenticated POST without X-Waypack is refused");
const co = await fetch(`${BASE}/api/billing/checkout`, { method: "POST", headers: { Cookie: cookieHdr, "X-Waypack": "1", "Content-Type": "application/json" }, body: JSON.stringify({ plan: "annual" }) });
ok(co.status === 503 || co.ok, `checkout without Stripe keys → ${co.status} (billing not configured)`);
const cancel = await (await stripeEvent("customer.subscription.deleted", { ...subObj, status: "canceled" })).json();
ok(cancel.tier === "free", "Stripe subscription.deleted → free");
const life = await (await stripeEvent("checkout.session.completed", { mode: "payment", payment_status: "paid", customer: subObj.customer, client_reference_id: uid, metadata: { user_id: uid, plan: "lifetime" } })).json();
ok(life.tier === "lifetime", "Stripe lifetime payment → lifetime");

// --- 8. delete ---
const delNo = await call("delete_trip", { trip_id: tripId, confirm: false });
ok(delNo.isError, "delete_trip requires confirm: true");
const del = await call("delete_trip", { trip_id: tripId, confirm: true });
ok(!del.isError, "delete_trip");
const gone = await fetch(dl.bundle.url);
ok(gone.status === 404, "deleted bundle is gone from storage");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
