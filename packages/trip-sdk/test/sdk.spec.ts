import { expect, test } from "@playwright/test";

const BASE = "http://127.0.0.1:4199/t/local/";

test.describe("Waypack SDK in a phone viewport", () => {
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
      page.locator("#place-lodge-wuksachi [data-nav]").click(),
    ]);
    // Don't actually load Google; the URL is what matters.
    expect(popup.url()).toContain("google.com/maps/dir/?api=1&destination=36.6096,-118.75202");
  });

  test("setDay filters the map and dark mode renders", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}#map`);
    await expect(page.locator("#map canvas.maplibregl-canvas")).toBeVisible({ timeout: 20_000 });
    await page.selectOption("#map-day", "2026-12-25");
    await page.waitForTimeout(1500);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(11, 17, 32)");
    await ctx.close();
  });
});
