// Dev helper: screenshot the account portal signed in as a local dev account.
import { chromium } from "playwright";
const BASE = "http://127.0.0.1:8787", MAILPIT = "http://127.0.0.1:55424";
const [email, out] = process.argv.slice(2);
const H = { "Content-Type": "application/json", "X-Waypack": "1" };
await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
await fetch(`${BASE}/api/auth/send-code`, { method: "POST", headers: H, body: JSON.stringify({ email }) });
let code;
for (let i = 0; i < 20 && !code; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const l = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
  if (l.messages?.[0]) code = ((await (await fetch(`${MAILPIT}/api/v1/message/${l.messages[0].ID}`)).json()).Text.match(/\b(\d{6})\b/) || [])[1];
}
const v = await fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: H, body: JSON.stringify({ email, code }) });
const cookie = v.headers.getSetCookie()[0].split(";")[0].split("=");
const b = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
  await ctx.addCookies([{ name: cookie[0], value: cookie.slice(1).join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/account`);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}-${scheme}.png`, fullPage: true });
  await ctx.close();
}
const anon = await b.newPage({ viewport: { width: 390, height: 844 } });
await anon.goto(`${BASE}/account`);
await anon.waitForTimeout(800);
await anon.screenshot({ path: `${out}-signedout.png` });
await b.close();
console.log("ok");
