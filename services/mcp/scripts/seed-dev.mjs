// Seeds a local dev account with a published trip (and Pro entitlement), for app testing.
//   node scripts/seed-dev.mjs [email] [--free] [--bundle ../../examples/sequoia-winter]
// Prints the trip id. Requires the local stack (supabase start, wrangler dev, tiler).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BASE = process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const SUPA = process.env.SUPABASE_URL ?? "http://127.0.0.1:55421";
const args = process.argv.slice(2);
const email = args.find((a) => a.includes("@")) ?? "dev@waypack.test";
const free = args.includes("--free");
const bundleDir = args.includes("--bundle") ? args[args.indexOf("--bundle") + 1] : new URL("../../../examples/sequoia-winter", import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const svc = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const signin = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: { "Content-Type": "application/json", "X-Waypack": "1" }, body: JSON.stringify({ email }) });
if (!signin.ok) throw new Error(`dev sign-in failed (${signin.status}) — is wrangler dev running with ENVIRONMENT=development?`);
const sess = await signin.json();
sess.user = { id: sess.userId };
const uid = sess.user.id;
await fetch(`${SUPA}/rest/v1/entitlements?user_id=eq.${uid}`, {
  method: "PATCH",
  headers: svc,
  body: JSON.stringify(free ? { tier: "free", expires_at: null } : { tier: "annual", active: true, expires_at: new Date(Date.now() + 365 * 86400000).toISOString(), source: "manual" }),
});
const pat = await (await fetch(`${BASE}/api/tokens`, { method: "POST", headers: { Authorization: `Bearer ${sess.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ label: "seed" }) })).json();
const call = async (name, a) => {
  const r = await (await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: a } }) })).json();
  return r.result;
};
// Start clean: delete this user's existing trips.
for (const t of (await call("list_trips", {})).structuredContent.trips) await call("delete_trip", { trip_id: t.trip_id, confirm: true });
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(bundleDir).map((p) => ({ path: relative(bundleDir, p), content: readFileSync(p, "utf8") }));
const up = await call("upload_bundle_inline", { files });
if (up.isError) throw new Error(up.content[0].text);
const tripId = up.structuredContent.trip_id;
for (let i = 0; i < 60; i++) {
  const s = await call("get_trip_status", { trip_id: tripId });
  if (s.structuredContent.status !== "processing") { console.error(s.content[0].text); break; }
  await sleep(3000);
}
console.log(JSON.stringify({ email, user_id: uid, trip_id: tripId }));
