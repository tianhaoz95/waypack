import type { Manifest } from "@waypack/bundle-schema";

/** A calendar event derived from a manifest day item (times are local to the trip's time zone). */
export interface CalEvent {
  uid: string;
  title: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM (absent → all-day)
  endTime?: string;
  location?: string;
  lat?: number;
  lon?: number;
  notes?: string;
}

/** Target accepted by Waypack.addToCalendar: a day item reference or a full event. */
export type CalTarget = { date: string; index: number } | (Omit<CalEvent, "uid"> & { uid?: string });

const pad = (n: number) => String(n).padStart(2, "0");

export function eventFromItem(m: Manifest, date: string, index: number): CalEvent | null {
  const day = m.days.find((d) => d.date === date);
  const it = day?.items[index];
  if (!day || !it) return null;
  const route = it.route_id ? m.routes.find((r) => r.id === it.route_id) : undefined;
  const placeId = it.place_id ?? route?.to;
  const p = placeId ? m.places.find((x) => x.id === placeId) : undefined;
  // Without an explicit end, the item runs until the next timed item (max 3 h), else 1 h.
  let endTime = it.end_time;
  if (it.time && !endTime) {
    const next = day.items.slice(index + 1).find((x) => x.time && x.time > it.time!);
    const start = toMinutes(it.time);
    const end = next?.time ? Math.min(toMinutes(next.time), start + 180) : start + 60;
    endTime = fromMinutes(Math.min(end, 23 * 60 + 59));
  }
  const notes = [it.notes, route?.notes, p?.address, p?.phone ? `Phone: ${p.phone}` : undefined, `From your Waypack trip "${m.title}"`]
    .filter(Boolean)
    .join("\n");
  return {
    uid: `${m.trip_id ?? "trip"}-${date}-${index}@waypack.app`,
    title: it.title,
    date,
    time: it.time,
    endTime,
    location: p ? [p.name, p.address].filter(Boolean).join(", ") : undefined,
    lat: p?.lat,
    lon: p?.lon,
    notes,
  };
}

export function eventsFromManifest(m: Manifest): CalEvent[] {
  const out: CalEvent[] = [];
  for (const d of m.days) d.items.forEach((_, i) => {
    const e = eventFromItem(m, d.date, i);
    if (e) out.push(e);
  });
  return out;
}

const toMinutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const fromMinutes = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** Offset (ms) of `tz` from UTC at instant `utcMs`. */
function tzOffset(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - utcMs;
}

/** Converts a wall-clock time in `tz` to a UTC Date (handles DST transitions). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffset(tz, guess);
  utc = guess - tzOffset(tz, utc); // second pass settles DST edges
  return new Date(utc);
}

const icsUtc = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const icsDate = (date: string) => date.replace(/-/g, "");
const nextDate = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545 line folding at 75 octets. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      len = 0;
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export interface ResolvedTimes { allDay: boolean; start: Date; end: Date }

export function resolveTimes(e: CalEvent, tz: string): ResolvedTimes {
  if (!e.time) {
    const start = new Date(`${e.date}T00:00:00Z`);
    return { allDay: true, start, end: new Date(`${nextDate(e.date)}T00:00:00Z`) };
  }
  const start = zonedToUtc(e.date, e.time, tz);
  let end = zonedToUtc(e.date, e.endTime ?? e.time, tz);
  if (end <= start) end = new Date(start.getTime() + 3600_000);
  return { allDay: false, start, end };
}

/** Builds an iCalendar file with one or more events. Times are written in UTC. */
export function toIcs(events: CalEvent[], tz: string, calName = "Waypack trip"): string {
  const now = icsUtc(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Waypack//Trip//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsText(calName)}`, `X-WR-TIMEZONE:${tz}`];
  for (const e of events) {
    const t = resolveTimes(e, tz);
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${now}`);
    if (t.allDay) lines.push(`DTSTART;VALUE=DATE:${icsDate(e.date)}`, `DTEND;VALUE=DATE:${icsDate(nextDate(e.date))}`);
    else lines.push(`DTSTART:${icsUtc(t.start)}`, `DTEND:${icsUtc(t.end)}`);
    lines.push(`SUMMARY:${icsText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.lat != null && e.lon != null) lines.push(`GEO:${e.lat};${e.lon}`);
    if (e.notes) lines.push(`DESCRIPTION:${icsText(e.notes)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Google Calendar "create event" link (local times + ctz, so no conversion needed). */
export function googleCalendarUrl(e: CalEvent, tz: string): string {
  const u = new URL("https://calendar.google.com/calendar/render");
  u.searchParams.set("action", "TEMPLATE");
  u.searchParams.set("text", e.title);
  const t = resolveTimes(e, tz);
  const local = (date: string, time: string) => `${icsDate(date)}T${time.replace(":", "")}00`;
  u.searchParams.set(
    "dates",
    t.allDay ? `${icsDate(e.date)}/${icsDate(nextDate(e.date))}` : `${local(e.date, e.time!)}/${local(e.date, e.endTime ?? e.time!)}`,
  );
  if (!t.allDay) u.searchParams.set("ctz", tz);
  if (e.notes) u.searchParams.set("details", e.notes);
  if (e.location) u.searchParams.set("location", e.location);
  return u.toString();
}
