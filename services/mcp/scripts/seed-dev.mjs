// Seeds a local dev account with a published trip (and Pro entitlement), for app testing.
//   node scripts/seed-dev.mjs [email] [--free] [--bundle ../../examples/sequoia-winter]
// Prints the trip id. Requires the local stack (supabase start, wrangler dev, tiler).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BASE = process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const SUPA = process.env.SUPABASE_URL ?? "http://127.0.0.1:55421";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:55424";
const args = process.argv.slice(2);
const email = args.find((a) => a.includes("@")) ?? "dev@waypack.test";
const free = args.includes("--free");
const bundleDir = args.includes("--bundle") ? args[args.indexOf("--bundle") + 1] : new URL("../../../examples/sequoia-winter", import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const svc = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function code() {
  for (let i = 0; i < 30; i++) {
    const l = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    if (l.messages?.[0]) {
      const m = await (await fetch(`${MAILPIT}/api/v1/message/${l.messages[0].ID}`)).json();
      const c = (m.Text || m.HTML).match(/\b(\d{6})\b/)?.[1];
      if (c) return c;
    }
    await sleep(500);
  }
  throw new Error("no OTP email");
}

await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
await fetch(`${SUPA}/auth/v1/otp`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email, create_user: true }) });
const sess = await (await fetch(`${SUPA}/auth/v1/verify`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ type: "email", email, token: await code() }) })).json();
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
await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
console.log(JSON.stringify({ email, user_id: uid, trip_id: tripId }));
