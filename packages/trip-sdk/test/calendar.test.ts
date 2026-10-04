import { describe, expect, it } from "vitest";
import { eventFromItem, googleCalendarUrl, toIcs, zonedToUtc } from "../src/calendar.js";
import type { Manifest } from "@waypack/bundle-schema";

const m = {
  title: "Tahoe, Winter", timezone: "America/Los_Angeles", trip_id: "t1",
  places: [{ id: "lodge", name: "Lodge; Main", category: "lodging", lat: 38.9, lon: -119.9, address: "1 Lake St, South Lake Tahoe, CA" }],
  routes: [],
  days: [
    { date: "2027-01-16", items: [
      { time: "09:00", title: "Ski", place_id: "lodge" },
      { time: "15:30", end_time: "16:00", title: "Check in", place_id: "lodge", notes: "Conf #A1, park in back" },
      { title: "Free evening" },
    ] },
    { date: "2026-03-08", items: [{ time: "10:00", title: "DST day" }] },
  ],
} as unknown as Manifest;

describe("calendar", () => {
  it("converts wall-clock times in a zone to UTC (incl. DST)", () => {
    expect(zonedToUtc("2027-01-16", "09:00", "America/Los_Angeles").toISOString()).toBe("2027-01-16T17:00:00.000Z");
    expect(zonedToUtc("2026-07-01", "09:00", "America/Los_Angeles").toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(zonedToUtc("2026-03-08", "10:00", "America/Los_Angeles").toISOString()).toBe("2026-03-08T17:00:00.000Z");
    expect(zonedToUtc("2026-12-25", "10:00", "Asia/Tokyo").toISOString()).toBe("2026-12-25T01:00:00.000Z");
  });
  it("derives events: end from next item (max 3h), location, notes, all-day", () => {
    const ski = eventFromItem(m, "2027-01-16", 0)!;
    expect(ski.endTime).toBe("12:00"); // next item 15:30 is > 3h away → capped
    expect(ski.location).toBe("Lodge; Main, 1 Lake St, South Lake Tahoe, CA");
    expect(eventFromItem(m, "2027-01-16", 1)!.endTime).toBe("16:00");
    expect(eventFromItem(m, "2027-01-16", 2)!.time).toBeUndefined();
    expect(eventFromItem(m, "2027-01-16", 9)).toBeNull();
  });
  it("writes valid iCalendar with UTC times, all-day dates and escaping", () => {
    const ics = toIcs([eventFromItem(m, "2027-01-16", 1)!, eventFromItem(m, "2027-01-16", 2)!], m.timezone, m.title);
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toContain("DTSTART:20270116T233000Z");
    expect(ics).toContain("DTEND:20270117T000000Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20270116");
    expect(ics).toContain("DTEND;VALUE=DATE:20270117");
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(String.raw`LOCATION:Lodge\; Main\, 1 Lake St\, South Lake Tahoe\, CA`);
    expect(ics).toContain("X-WR-CALNAME:Tahoe\\, Winter");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
  it("builds Google Calendar links with local times + ctz", () => {
    const u = new URL(googleCalendarUrl(eventFromItem(m, "2027-01-16", 1)!, m.timezone));
    expect(u.searchParams.get("dates")).toBe("20270116T153000/20270116T160000");
    expect(u.searchParams.get("ctz")).toBe("America/Los_Angeles");
    expect(u.searchParams.get("text")).toBe("Check in");
    const allDay = new URL(googleCalendarUrl(eventFromItem(m, "2027-01-16", 2)!, m.timezone));
    expect(allDay.searchParams.get("dates")).toBe("20270116/20270117");
    expect(allDay.searchParams.get("ctz")).toBeNull();
  });
});
