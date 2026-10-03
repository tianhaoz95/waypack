// Dev helper: screenshots of the landing page at a phone width (scroll positions).
import { chromium } from "playwright";
const [url, outPrefix] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await p.goto(url);
await p.waitForTimeout(500);
const h = await p.evaluate(() => document.body.scrollHeight);
let i = 0;
for (let y = 0; y < h && i < 8; y += 820, i++) {
  await p.evaluate((yy) => window.scrollTo(0, yy), y);
  await p.waitForTimeout(150);
  await p.screenshot({ path: `${outPrefix}-${i}.png` });
}
const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log(`height ${h}, shots ${i}, horizontal overflow: ${overflow}`);
await b.close();
