import { describe, expect, it } from "vitest";
import type { Manifest } from "@waypack/bundle-schema";
import { buildCard, cleanManifest, filterCards, homeFeed, matchReasons, parseQuery, resolveScene, seasonOf, slugFrom, slugify, TemplateError, type TemplateCard, type TemplateInput } from "../src/lib/templates.js";

// A small trip shaped like examples/sequoia-winter (dates, a toddler, a traveler note, route geometry).
const sequoia = {
  schema_version: 1, sdk_version: "1", trip_id: "7c31bd4b-a04f-4c94-b876-5bf298833fbf", title: "Sequoia Christmas", timezone: "America/Los_Angeles",
  start_date: "2026-12-24", end_date: "2026-12-26",
  travelers: { adults: 2, children: [{ age: 2 }], notes: "Toddler naps 1–3pm; Grandma Jo's number is 555-0100." },
  theme: { preset: "winter-forest", accent: "#9a3f1d" },
  map: { bbox: [-118.95, 36.4, -118.6, 36.75] },
  places: [
    { id: "a", name: "Sequoia Coffee Co.", category: "food", lat: 36.43856, lon: -118.90529 },
    { id: "b", name: "General Sherman Tree", category: "sight", lat: 36.58163, lon: -118.75135 },
    { id: "c", name: "Wuksachi Lodge", category: "lodging", lat: 36.59466, lon: -118.75812, notes: "Confirmation #AB12CD" },
  ],
  routes: [{ id: "r1", from: "a", to: "b", mode: "driving", geometry: { type: "LineString", coordinates: [[-118.9, 36.4], [-118.75, 36.58]] } }],
  days: [
    { date: "2026-12-24", title: "Drive in", items: [{ title: "Breakfast", place_id: "a" }, { title: "General Sherman", place_id: "b" }] },
    { date: "2026-12-25", title: "Snow day", items: [{ title: "Snowshoe walk", place_id: "b" }, { title: "Lodge dinner", place_id: "c" }] },
    { date: "2026-12-26", title: "Home", items: [{ title: "Drive home" }] },
  ],
} as unknown as Manifest;
const input: TemplateInput = {
  tagline: "Giant trees, a ranger snowshoe walk and early nights by the fire.",
  region: "California, USA",
  notes: { kept: ["The ranger snowshoe walk was the highlight."], cut: ["Moro Rock: the stairs were iced over."], surprise: ["Chains were required from Hospital Rock up. Confirmation #AB12CD"] },
  recheck: ["Road and chain controls on Generals Hwy"],
  tags: ["Snow", "Big trees", "Kids"],
  pace: "easy",
  getting_around: "car",
  author_name: "Mia",
};
const AFTER = "2030-01-01";
const card = (over: Partial<TemplateCard>): TemplateCard => ({ ...buildCard(sequoia, input, { slug: "x-abcd", today: AFTER }), ...over });

describe("buildCard", () => {
  it("keeps the month, never the dates, and turns travelers into a crew shape", () => {
    const c = buildCard(sequoia, input, { slug: "sequoia-in-the-snow-abcd", today: AFTER });
    expect(c.traveled).toBe(sequoia.start_date.slice(0, 7));
    expect(JSON.stringify(c)).not.toContain(sequoia.start_date);
    expect(JSON.stringify(c)).not.toContain(sequoia.end_date);
    expect(JSON.stringify(c)).not.toContain(String(sequoia.travelers?.notes ?? "§"));
    expect(c.crew).toEqual({ adults: 2, kids: [2], pets: 0 });
    expect(c.days).toBe(sequoia.days.length);
    expect(c.plan[0].stops.length).toBeGreaterThan(0);
    expect(c.plan[0].stops.some((s) => typeof s.lat === "number")).toBe(true);
    expect(c.season).toBe("Winter");
    expect(c.months).toEqual(expect.arrayContaining([12]));
    expect(c.status).toBe("draft");
    expect(c.author).toBe("Mia");
  });
  it("masks booking codes in the agent's notes", () => {
    const c = buildCard(sequoia, input, { slug: "x-abcd", today: AFTER });
    expect(c.notes.surprise[0]).toContain("Confirmation #••••");
  });
  it("refuses trips that haven't happened yet", () => {
    expect(() => buildCard(sequoia, input, { slug: "x-abcd", today: "2020-01-01" })).toThrow(TemplateError);
  });
  it("needs at least one note from the trip and valid enums", () => {
    expect(() => buildCard(sequoia, { ...input, notes: {} }, { slug: "x", today: AFTER })).toThrow(/at least one note/);
    expect(() => buildCard(sequoia, { ...input, pace: "fast" as never }, { slug: "x", today: AFTER })).toThrow(/pace/);
    expect(() => buildCard(sequoia, { ...input, good_months: [13] }, { slug: "x", today: AFTER })).toThrow(/good_months/);
  });
  it("adds good months to the traveled ones", () => {
    const c = buildCard(sequoia, { ...input, good_months: [1, 2] }, { slug: "x", today: AFTER });
    expect(c.months).toEqual(expect.arrayContaining([1, 2, 12]));
  });
  it("resolves the cover scene from the theme preset", () => {
    expect(resolveScene(sequoia.theme)).toMatchObject({ trees: "sequoia", ground: "snow" });
    expect(resolveScene(undefined)).toMatchObject({ ground: "grass" });
  });
});

describe("cleanManifest", () => {
  it("drops dates, trip id, traveler notes and route geometry; masks booking codes", () => {
    const m = { ...sequoia, places: [...sequoia.places, { ...sequoia.places[0], id: "x", notes: "Reservation no. 55-1234" }] } as Manifest;
    const c = cleanManifest(m);
    const text = JSON.stringify(c);
    expect(c.trip_id).toBeNull();
    expect(c.start_date).toBeUndefined();
    expect(text).not.toContain(sequoia.start_date);
    expect((c.days as { day: number; date?: string }[])[0]).toMatchObject({ day: 1 });
    expect((c.days as { date?: string }[])[0].date).toBeUndefined();
    expect((c.travelers as Record<string, unknown>).notes).toBeUndefined();
    expect((c.routes as Record<string, unknown>[]).every((r) => r.geometry === undefined)).toBe(true);
    expect(text).toContain("Reservation no. ••••");
  });
});

describe("search", () => {
  const cards = [
    card({ slug: "sequoia-a", title: "Sequoia in the snow", remix_count: 5 }),
    card({ slug: "kyoto-b", title: "Kyoto in autumn", region: "Kyoto, Japan", days: 6, months: [10, 11], season: "Autumn", getting_around: "transit", crew: { adults: 2, kids: [], pets: 0 }, tags: ["Temples"], remix_count: 9 }),
    card({ slug: "olympic-c", title: "Olympic loop", region: "Washington, USA", days: 5, months: [7, 8], season: "Summer", crew: { adults: 2, kids: [10], pets: 1 }, remix_count: 1 }),
  ];
  it("parses only known parameters", () => {
    expect(parseQuery(new URLSearchParams("q=snow&month=1&length=weekend&who=kids&move=car&sort=new&evil=1"))).toEqual({ q: "snow", month: 1, length: "weekend", who: "kids", move: "car", sort: "new" });
    expect(parseQuery(new URLSearchParams("month=13&length=forever"))).toEqual({});
  });
  it("filters by text, month, length, crew and getting around; sorts by planned", () => {
    expect(filterCards(cards, {}).map((c) => c.slug)).toEqual(["kyoto-b", "sequoia-a", "olympic-c"]);
    expect(filterCards(cards, { q: "japan" }).map((c) => c.slug)).toEqual(["kyoto-b"]);
    expect(filterCards(cards, { month: 12 }).map((c) => c.slug)).toEqual(["sequoia-a"]);
    expect(filterCards(cards, { who: "dog" }).map((c) => c.slug)).toEqual(["olympic-c"]);
    expect(filterCards(cards, { move: "nocar" }).map((c) => c.slug)).toEqual(["kyoto-b"]);
    expect(filterCards(cards, { length: "mid" }).map((c) => c.slug)).toEqual(["kyoto-b", "olympic-c"]);
    expect(filterCards(cards, { who: "couple" }).map((c) => c.slug)).toEqual(["kyoto-b"]);
  });
  it("explains why a card fits", () => {
    expect(matchReasons(cards[2], { who: "kids", q: "olympic" })).toEqual(["tested with kids 10", "“olympic”"]);
  });
  it("builds the magazine home", () => {
    const h = homeFeed(cards, new Date("2026-12-10T00:00:00Z"));
    expect(h.total).toBe(3);
    expect(h.featured).not.toBeNull();
    expect(h.most_planned[0].slug).toBe("kyoto-b");
    expect(h.in_season.map((c) => c.slug)).toEqual(["sequoia-a"]);
    expect(h.collections.map((c) => c.id)).toEqual(expect.arrayContaining(["kids", "nocar", "dog"]));
    expect(h.collections.every((c) => c.items.length > 0)).toBe(true);
    expect(homeFeed([]).featured).toBeNull();
  });
});

describe("slugs", () => {
  it("makes url-safe slugs and reads them back from links", () => {
    const s = slugify("Kyoto in autumn, kid pace!");
    expect(s).toMatch(/^kyoto-in-autumn-kid-pace-[a-z0-9x]{6}$/);
    expect(slugFrom(`https://waypack.app/trips/${s}`)).toBe(s);
    expect(slugFrom(s)).toBe(s);
    expect(slugFrom("https://evil.example/../x")).toBeNull();
  });
  it("names seasons", () => {
    expect([1, 4, 7, 10, 12].map(seasonOf)).toEqual(["Winter", "Spring", "Summer", "Autumn", "Winter"]);
  });
});
