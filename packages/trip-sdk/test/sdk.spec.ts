import { readFileSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";

/** Playwright scrolls targets flush to the viewport edge, under our fixed tab bar; center them first. */
async function tap(l: Locator) {
  await l.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await l.click();
}

const BASE = "http://127.0.0.1:4199/t/local/";

test.describe("Waypack SDK in a phone viewport", () => {
  test("top bar on the web: pinned first, no app-only buttons", async ({ page }) => {
    await page.goto(BASE);
    const bar = page.locator("[data-waypack-bar]");
    await expect(bar).toBeVisible();
    expect(await page.evaluate(() => document.body.firstElementChild?.hasAttribute("data-waypack-bar"))).toBe(true);
    await expect(bar.locator(".wp-bar-back")).toHaveCount(0);
    await expect(bar.locator(".wp-bar-more")).toHaveCount(0);
    // This example has a bottom tab bar and no section drawer, so no ☰ either.
    await expect(bar.locator(".wp-bar-menu")).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, 800));
    expect(await bar.evaluate((e) => Math.round(e.getBoundingClientRect().top))).toBe(0);
  });

  test("top bar in the app: back, sections menu and trip menu call the shell", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __WAYPACK_HOST__: unknown; __calls: string[]; flutter_inappwebview: unknown };
      w.__WAYPACK_HOST__ = { platform: "ios" };
      w.__calls = [];
      w.flutter_inappwebview = { callHandler: (n: string) => (w.__calls.push(n), Promise.resolve(true)) };
    });
    await page.goto(BASE);
    const bar = page.locator("[data-waypack-bar]");
    await expect(bar.locator(".wp-bar-back")).toBeVisible();
    await expect(bar.locator(".wp-bar-more")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-waypack-app", "");
    let opened = 0;
    await page.exposeFunction("__menuOpened", () => opened++);
    await page.evaluate(() => (window as unknown as { Waypack: { onMenu(f: () => void): void } }).Waypack.onMenu(() => (window as unknown as { __menuOpened(): void }).__menuOpened()));
    await bar.locator(".wp-bar-menu").click();
    await bar.locator(".wp-bar-back").click();
    await bar.locator(".wp-bar-more").click();
    await expect.poll(() => opened).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toEqual(["waypackBar", "waypackBack", "waypackMenu"]);
  });

  test("renders the offline map with no external requests or CSP violations", async ({ page }) => {
    const external: string[] = [];
    const problems: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (!["127.0.0.1", "localhost"].includes(u.hostname) && !["data:", "blob:"].includes(u.protocol)) external.push(r.url());
    });
    page.on("console", (m) => {
      if (m.type() === "error" || /Content Security Policy/i.test(m.text())) problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(e.message));
    const tileResponses: number[] = [];
    page.on("response", (r) => {
      if (r.url().includes("extract.pmtiles")) tileResponses.push(r.status());
    });

    await page.goto(`${BASE}#map`);
    const canvas = page.locator("#map canvas.maplibregl-canvas");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    // Wait until MapLibre reports the style and tiles loaded.
    await page.waitForFunction(() => {
      const el = document.querySelector("#map canvas");
      return !!el && (el as HTMLCanvasElement).width > 0;
    });
    await page.waitForTimeout(3000);
    await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("OpenStreetMap");
    await expect(page.locator(".maplibregl-ctrl-geolocate")).toBeVisible();

    expect(tileResponses.length).toBeGreaterThan(0);
    expect(tileResponses.every((s) => s === 206)).toBe(true);
    expect(external).toEqual([]);
    expect(problems.filter((p) => !/GPU stall|WebGL/i.test(p))).toEqual([]);
  });

  test("Today, Plan, Places and Guide tabs work", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#trip-title")).toHaveText("Sequoia Winter Weekend");
    await page.getByRole("link", { name: /Plan/ }).click();
    await expect(page.locator("#day-2026-12-25")).toContainText("Christmas in the snow");
    await page.getByRole("link", { name: /Places/ }).click();
    await expect(page.locator("#place-lodge-wuksachi")).toContainText("Wuksachi Lodge");
    await page.getByRole("link", { name: /Guide/ }).click();
    await expect(page.locator("#g-packing")).toBeVisible();
    await expect(page.locator("#live-checks a")).toHaveCount(7);
  });

  test("Navigate hands off to Google Maps on the web", async ({ page, context }) => {
    await page.goto(BASE);
    await page.getByRole("link", { name: /Places/ }).click();
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      tap(page.locator("#place-lodge-wuksachi [data-nav]")),
    ]);
    // Don't actually load Google; the URL is what matters.
    expect(popup.url()).toContain("google.com/maps/dir/?api=1&destination=36.6096,-118.75202");
    // …and the trip page itself must stay put.
    await page.waitForTimeout(500);
    expect(page.url()).toContain("/t/local/");
  });

  test("Add to calendar: Google link in a new tab, Apple as .ics, trip stays open", async ({ page, context }) => {
    await page.goto(`${BASE}#plan`);
    await tap(page.locator("#tab-plan [data-cal]").first());
    await expect(page.locator(".sheet")).toBeVisible();
    // Capture the Google Calendar request instead of loading Google (which redirects signed-out users).
    let googleUrl = "";
    await context.route("https://calendar.google.com/**", (r) => { googleUrl = r.request().url(); return r.fulfill({ body: "ok" }); });
    await Promise.all([context.waitForEvent("page"), page.locator("[data-cal-app=google]").click()]);
    await expect.poll(() => googleUrl).toContain("calendar.google.com/calendar/render?action=TEMPLATE");
    const g = new URL(googleUrl);
    expect(g.searchParams.get("text")).toBe("Breakfast & coffee");
    expect(g.searchParams.get("dates")).toBe("20261224T083000/20261224T091000");
    expect(g.searchParams.get("ctz")).toBe("America/Los_Angeles");
    await page.waitForTimeout(300);
    expect(page.url()).toContain("/t/local/");
    await expect(page.locator(".sheet")).toBeHidden();
    await tap(page.locator("#tab-plan [data-cal]").nth(1));
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("[data-cal-app=apple]").click()]);
    expect(dl.suggestedFilename()).toMatch(/\.ics$/);
    const ics = readFileSync((await dl.path())!, "utf8");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
  });

  test("responsive: rail + pinned map on desktop, bottom tabs on phone", async ({ browser }) => {
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await desk.newPage();
    await p.goto(BASE);
    await expect(p.locator("#map-pane canvas.maplibregl-canvas")).toBeVisible({ timeout: 20_000 });
    await expect(p.locator(".rail-head")).toBeVisible();
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await desk.close();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const q = await phone.newPage();
    await q.goto(BASE);
    await expect(q.locator("#map-pane")).toBeHidden();
    await expect(q.locator(".tabbar a[data-go=map]")).toBeVisible();
    expect(await q.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await phone.close();
  });

  test("setDay filters the map and dark mode renders", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}#map`);
    await expect(page.locator("#map canvas.maplibregl-canvas")).toBeVisible({ timeout: 20_000 });
    await page.selectOption("#map-day", "2026-12-25");
    await page.waitForTimeout(1500);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    expect(r + g + b).toBeLessThan(120); // a dark palette, whatever the trip's theme
    // the illustrated header follows the theme (winter-forest → sequoias in snow)
    await expect(page.locator("#scene svg")).toBeVisible();
    expect(await page.locator("#scene").getAttribute("data-scene")).toContain("sequoia");
    await ctx.close();
  });
});
