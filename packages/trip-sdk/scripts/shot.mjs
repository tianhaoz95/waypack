// Dev helper: screenshot a bundle in a phone viewport. Usage: node scripts/shot.mjs <url> <out.png> [#hash]
import { chromium, devices } from "playwright";
const url = process.argv[2], out = process.argv[3], hash = process.argv[4] || "";
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ...devices["iPhone 13"], colorScheme: process.env.DARK ? "dark" : "light", timezoneId: "America/Los_Angeles" });
if (process.env.FAKE_NOW) await ctx.addInitScript(`{const T=${Date.parse(process.env.FAKE_NOW)};const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[T+(D.now()-${Date.now()})]))}static now(){return T+(D.now()-${Date.now()})}}}`);
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => logs.push(`failed: ${r.url()} ${r.failure()?.errorText}`));
await page.goto(url + hash);
await page.waitForTimeout(Number(process.env.WAIT || 6000));
await page.screenshot({ path: out, fullPage: !!process.env.FULL });
console.log(logs.join("\n"));
await browser.close();
