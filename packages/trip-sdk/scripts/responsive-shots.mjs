// Dev helper: screenshot a bundle at phone, iPad and desktop sizes.
//   FAKE_NOW=2027-01-16T10:05:00-08:00 node scripts/responsive-shots.mjs <url> <out-prefix> [#hash] [--dark]
import { chromium } from "playwright";
const [url, out, hash = ""] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dark = process.argv.includes("--dark");
const sizes = [["phone", 390, 844, true], ["ipad", 820, 1180, true], ["desktop", 1440, 900, false]];
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const [name, width, height, mobile] of sizes) {
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: dark ? "dark" : "light" });
  if (process.env.FAKE_NOW) {
    const T = Date.parse(process.env.FAKE_NOW);
    await ctx.addInitScript(`{const T=${T},S=Date.now(),D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[T+(D.now()-S)]))}static now(){return T+(D.now()-S)}}}`);
  }
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(url + hash);
  await p.waitForTimeout(Number(process.env.WAIT || 7000));
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await p.screenshot({ path: `${out}-${name}${dark ? "-dark" : ""}.png` });
  console.log(name, overflow ? "HORIZONTAL OVERFLOW" : "ok", errors.join("; "));
  await ctx.close();
}
await b.close();
