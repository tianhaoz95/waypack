// End-to-end checks for travel companions against the local stack (supabase start + npm run dev).
//   node scripts/e2e-companions.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BASE = process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const bundleDir = new URL("../../../examples/sequoia-winter", import.meta.url).pathname;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; return cond; };

async function account(label, { pro = true } = {}) {
  const email = `${label}+${Date.now()}@example.com`;
  const r = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: { "Content-Type": "application/json", "X-Waypack": "1" }, body: JSON.stringify({ email }) });
  if (!r.ok) throw new Error(`dev sign-in failed (${r.status}); is \`npm run dev\` running?`);
  const s = await r.json();
  const auth = { Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" };
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const api = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  return { email, userId: s.userId, auth, cookie, api, pro };
}

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(bundleDir).map((p) => ({ path: relative(bundleDir, p), content: readFileSync(p, "utf8") }));

const owner = await account("owner");
const friend = await account("friend");
const stranger = await account("stranger");

// Owner publishes via MCP (API token) so the trip exists.
const pat = (await owner.api("POST", "/api/tokens", { label: "e2e" })).json.token;
const pub = await (await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upload_bundle_inline", arguments: { files } } }),
})).json();
const tripId = pub.result.structuredContent.trip_id;
ok(!!tripId, "owner publishes a trip");

// ---- invites
let r = await friend.api("POST", `/api/trips/${tripId}/invite`);
ok(r.status === 403 || r.status === 404, "a stranger can't create an invite for someone else's trip");
r = await owner.api("POST", `/api/trips/${tripId}/invite`);
ok(r.status === 200 && r.json.invite_url.startsWith(`${BASE}/join/`), `owner gets an invite link: ${r.json.invite_url}`);
const inviteUrl = r.json.invite_url;
const code = inviteUrl.split("/join/")[1];
ok((await owner.api("POST", `/api/trips/${tripId}/invite`)).json.invite_url === inviteUrl, "asking again returns the same link");

const summary = await (await fetch(`${BASE}/api/public/invites/${code}`)).json();
ok(summary.title === "Sequoia Winter Weekend" && summary.invited_by === owner.email && !("members" in summary), "public invite summary: trip + who invited, nothing else");
ok((await fetch(inviteUrl)).status === 200, "join page is served");

// ---- joining
ok((await friend.api("GET", `/api/trips/${tripId}/download`)).status === 404, "before joining, the friend can't download it");
r = await friend.api("POST", `/api/invites/${code}/accept`);
ok(r.status === 200 && r.json.trip_id === tripId && !r.json.already, "friend joins with the link");
ok((await friend.api("POST", `/api/invites/${code}/accept`)).json.already === true, "joining twice is harmless");
ok((await owner.api("POST", `/api/invites/${code}/accept`)).json.owner === true, "the owner opening their own link is a no-op");

const trips = (await friend.api("GET", "/api/trips")).json.trips;
const t = trips.find((x) => x.id === tripId);
ok(t && t.role === "member" && t.owner_email === owner.email, "the trip shows up in the friend's list, marked as shared by the owner");
const dl = await friend.api("GET", `/api/trips/${tripId}/download`);
ok(dl.status === 200 && dl.json.bundle?.url && dl.json.version === 1, "the friend can download it");
ok(dl.json.tiles_status === (await owner.api("GET", `/api/trips/${tripId}/download`)).json.tiles_status, "the friend gets the owner's map status (owner's plan)");
const zip = await fetch(dl.json.bundle.url);
ok(zip.ok, "the signed bundle URL works for the friend");

// ---- what companions can't do
ok((await friend.api("DELETE", `/api/trips/${tripId}`)).status === 404, "a companion can't delete the trip");
ok((await friend.api("POST", `/api/trips/${tripId}/share`)).status >= 400, "a companion can't share it publicly");
ok((await friend.api("GET", `/api/trips/${tripId}/members`)).status === 403, "a companion can't list other companions");
ok((await stranger.api("GET", `/api/trips/${tripId}/download`)).status === 404, "people without the link still can't download");

// ---- owner view, removal, leaving
const members = (await owner.api("GET", `/api/trips/${tripId}/members`)).json;
ok(members.members.length === 1 && members.members[0].email === friend.email && members.invite?.invite_url === inviteUrl, "owner sees companions and the active link");
r = await stranger.api("POST", `/api/invites/${code}/accept`);
ok(r.status === 200, "a second person joins");
ok((await friend.api("DELETE", `/api/trips/${tripId}/members/${stranger.userId}`)).status === 403, "a companion can't remove another companion");
ok((await owner.api("DELETE", `/api/trips/${tripId}/members/${stranger.userId}`)).status === 200, "the owner removes a companion");
ok((await stranger.api("GET", `/api/trips/${tripId}/download`)).status === 404, "a removed companion loses access");
ok((await friend.api("DELETE", `/api/trips/${tripId}/members/${friend.userId}`)).status === 200, "a companion can leave");
ok(!(await friend.api("GET", "/api/trips")).json.trips.some((x) => x.id === tripId), "after leaving, it's gone from their list");

// ---- turning off the link
ok((await owner.api("DELETE", `/api/trips/${tripId}/invite`)).status === 200, "owner turns off the link");
ok((await fetch(`${BASE}/api/public/invites/${code}`)).status === 404, "the old link stops working");
ok((await friend.api("POST", `/api/invites/${code}/accept`)).status === 404, "and can't be used to join");

// ---- deleting the trip
const again = await owner.api("POST", `/api/trips/${tripId}/invite`);
await friend.api("POST", `/api/invites/${again.json.invite_url.split("/join/")[1]}/accept`);
await owner.api("DELETE", `/api/trips/${tripId}`);
ok(!(await friend.api("GET", "/api/trips")).json.trips.some((x) => x.id === tripId), "a deleted trip disappears for companions too");

console.log(failures ? `\n${failures} check(s) failed` : "\nall companion checks passed");
process.exit(failures ? 1 : 0);
