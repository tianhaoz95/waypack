// Browser check for live previews: a viewer's page reloads itself when the agent pushes,
// keeps the reader's place, renders the map from online tiles and logs no CSP errors.
//   node scripts/e2e-preview-browser.mjs [screenshot-dir]
// Needs the local stack (supabase start + npm run dev).
import { readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { chromium, devices } from "playwright";

const BASE = process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const bundleDir = new URL("../../../examples/tahoe-winter", import.meta.url).pathname;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; return cond; };

const signin = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: { "Content-Type": "application/json", "X-Waypack": "1" }, body: JSON.stringify({ email: `preview-browser+${Date.now()}@example.com` }) });
const sess = await signin.json();
const pat = (await (await fetch(`${BASE}/api/tokens`, { method: "POST", headers: { Authorization: `Bearer ${sess.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ label: "e2e" }) })).json()).token;
let id = 0;
const call = async (name, args) => (await (await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
})).json()).result;

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(bundleDir).map((p) => ({ path: relative(bundleDir, p), content: readFileSync(p, "utf8") }));
const manifest = JSON.parse(files.find((f) => f.path === "manifest.json").content);

// The agent starts with only the first day planned.
const day1 = { ...manifest, days: manifest.days.slice(0, 1) };
const push1 = await call("push_preview", { files: files.map((f) => (f.path === "manifest.json" ? { ...f, content: JSON.stringify(day1, null, 2) } : f)) });
const { preview_id, preview_url } = push1.structuredContent;
ok(!!preview_url, `preview link: ${preview_url}`);

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ ...devices["iPhone 15"] });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${preview_url}#plan`);
await page.waitForLoadState("networkidle");
const badge = page.locator("[data-waypack-preview]");
ok(await badge.count() === 1, "the page shows the Preview badge");
const days1 = await page.locator("#tab-plan [data-day], #tab-plan .day").count();
ok(days1 >= 1, `plan shows the first day (${days1} day block(s))`);
await page.evaluate(() => window.scrollTo(0, 400));
await page.waitForTimeout(300);
if (shots) await page.screenshot({ path: join(shots, "1-phone-day1.png") });

// The agent finishes the plan and pushes only the manifest.
const nav = page.waitForNavigation({ timeout: 15000 });
const t0 = Date.now();
await call("push_preview", { preview_id, files: [{ path: "manifest.json", content: JSON.stringify(manifest, null, 2) }] });
await nav;
ok(true, `page reloaded by itself ${((Date.now() - t0) / 1000).toFixed(1)} s after the push`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(800);
const days2 = await page.locator("#tab-plan [data-day], #tab-plan .day").count();
ok(days2 > days1, `the new days appear (${days1} → ${days2})`);
ok((await page.evaluate(() => location.hash)) === "#plan", "still on the Plan tab after the reload");
const y = await page.evaluate(() => scrollY);
ok(Math.abs(y - 400) < 60, `scroll position kept (y=${y})`);
const toast = await badge.evaluate((h) => (h.shadowRoot ?? h).querySelector(".toast")?.textContent ?? "");
ok(/Updated by your agent/.test(toast), "shows “Updated by your agent”");
if (shots) await page.screenshot({ path: join(shots, "2-phone-updated.png") });

// Desktop: map pane renders from online tiles; no CSP / console errors.
const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
desk.on("console", (m) => { if (m.type() === "error") errors.push(`desktop: ${m.text()}`); });
const tileReqs = [];
desk.on("request", (r) => { if (r.url().includes("/online.pmtiles")) tileReqs.push(r.url()); });
await desk.goto(preview_url);
await desk.waitForLoadState("networkidle");
await desk.waitForTimeout(2500);
ok(tileReqs.length > 0, `map loads online tiles through the preview origin (${tileReqs.length} range requests)`);
if (shots) await desk.screenshot({ path: join(shots, "3-desktop.png") });

ok(errors.filter((e) => !/favicon/.test(e)).length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);

// Hidden tabs don't poll.
const polls = [];
page.on("request", (r) => { if (r.url().includes("/state")) polls.push(Date.now()); });
await page.waitForTimeout(3500);
ok(polls.length >= 1, `visible tab polls (${polls.length} in 3.5 s)`);

await browser.close();
await call("delete_preview", { preview_id });
console.log(failures ? `\n${failures} check(s) failed` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
