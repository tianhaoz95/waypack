// Dev helper: screenshots of the landing page, account portal, MCP sign-in and trip bundle.
//   node scripts/web-shots.mjs <out-dir>   (needs wrangler dev on :8787, preview on :4182, Mailpit)
import { chromium } from "playwright";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:8787", MAILPIT = "http://127.0.0.1:55424", PREVIEW = "http://127.0.0.1:4182/t/local/";
const H = { "Content-Type": "application/json", "X-Waypack": "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sessionCookie(email) {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  await fetch(`${BASE}/api/auth/send-code`, { method: "POST", headers: H, body: JSON.stringify({ email }) });
  let code;
  for (let i = 0; i < 30 && !code; i++) {
    await sleep(400);
    const l = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    if (l.messages?.[0]) code = ((await (await fetch(`${MAILPIT}/api/v1/message/${l.messages[0].ID}`)).json()).Text.match(/\b(\d{6})\b/) || [])[1];
  }
  const v = await fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: H, body: JSON.stringify({ email, code }) });
  const [name, ...rest] = v.headers.getSetCookie()[0].split(";")[0].split("=");
  return { name, value: rest.join("="), url: BASE };
}

const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// Landing page — desktop sections
{
  const p = await b.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  await p.goto(`${BASE}/`);
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/web-01-landing-desktop.png` });
  for (const [id, name] of [["how", "web-02-landing-how-it-works"], ["connect", "web-03-landing-connect"], ["pricing", "web-04-landing-pricing"]]) {
    await p.evaluate((i) => document.getElementById(i).scrollIntoView(), id);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${OUT}/${name}.png` });
  }
  await p.close();
}
// Landing page — phone
{
  const p = await b.newPage(phone);
  await p.goto(`${BASE}/`);
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/web-05-landing-phone.png` });
  await p.close();
}
// Account portal — signed out, Pro account, free account with offers
{
  const p = await b.newPage(phone);
  await p.goto(`${BASE}/account`);
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/web-06-portal-sign-in.png` });
  await p.close();
  for (const [email, name] of [["dev@waypack.test", "web-07-portal-pro"], [`free-${Date.now()}@waypack.test`, "web-08-portal-free-subscribe"]]) {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 1200 }, deviceScaleFactor: 2 });
    await ctx.addCookies([await sessionCookie(email)]);
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/account`);
    await pg.waitForTimeout(1500);
    await pg.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    await ctx.close();
  }
}
// MCP sign-in page an agent opens (OAuth authorize)
{
  const reg = await (await fetch(`${BASE}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:33418/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) })).json();
  const verifier = randomBytes(32).toString("base64url");
  const u = new URL(`${BASE}/authorize`);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:33418/callback", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "x", scope: "mcp", resource: `${BASE}/mcp` }).forEach(([k, v]) => u.searchParams.set(k, v));
  const p = await b.newPage(phone);
  await p.goto(u.href);
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${OUT}/web-09-agent-sign-in.png` });
  await p.close();
}
// Trip bundle tabs (browser preview) at a mid-trip moment
{
  const T = Date.parse("2026-12-25T10:05:00-08:00");
  for (const [hash, name, dark] of [["#places", "web-10-bundle-places", false], ["#g-packing", "web-11-bundle-guide", false], ["#plan", "web-12-bundle-plan-dark", true], ["#map", "web-13-bundle-map-dark", true]]) {
    const ctx = await b.newContext({ ...phone, colorScheme: dark ? "dark" : "light" });
    await ctx.addInitScript(`{const T=${T},S=Date.now(),D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[T+(D.now()-S)]))}static now(){return T+(D.now()-S)}}}`);
    const p = await ctx.newPage();
    await p.goto(PREVIEW + hash);
    await p.waitForTimeout(hash === "#map" ? 9000 : 1200);
    await p.screenshot({ path: `${OUT}/${name}.png` });
    await ctx.close();
  }
}
await b.close();
console.log("done");
