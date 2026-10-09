import type { Manifest } from "@waypack/bundle-schema";
import { mountBar, setMenu } from "./bar.js";
import { callNative, host } from "./host.js";
import { chooseApp, mapsUrl } from "./links.js";
import { createMap } from "./map.js";
import { categories, routeModes } from "./theme.js";
import { eventFromItem, eventsFromManifest, googleCalendarUrl, resolveTimes, toIcs, type CalEvent, type CalTarget } from "./calendar.js";
import type { CalendarOptions, LatLon, MapOptions, OpenInMapsOptions, WaypackSDK } from "./types.js";

declare const __SDK_VERSION__: string;

let manifestPromise: Promise<Manifest> | null = null;
function manifest(): Promise<Manifest> {
  manifestPromise ??= fetch(new URL("manifest.json", location.href).href, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
    return r.json() as Promise<Manifest>;
  });
  manifestPromise.catch(() => (manifestPromise = null));
  return manifestPromise;
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "trip";

async function resolveEvent(target: CalTarget): Promise<{ ev: CalEvent; tz: string; title: string } | null> {
  const m = await manifest();
  if ("index" in target) {
    const ev = eventFromItem(m, target.date, target.index);
    if (!ev) console.warn(`[waypack] addToCalendar: no item ${target.index} on ${target.date}`);
    return ev ? { ev, tz: m.timezone, title: m.title } : null;
  }
  return { ev: { uid: target.uid ?? `${target.date}-${slug(target.title)}@waypack.app`, ...target }, tz: m.timezone, title: m.title };
}

/** Which calendar to use when the page doesn't say. */
function defaultCalendar(): "apple" | "google" {
  const p = host().platform;
  if (p === "ios" || p === "macos") return "apple";
  if (p === "android") return "google";
  return /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? "apple" : "google";
}

/** Opens a URL in a new tab without navigating the trip page away. (window.open with
 * "noopener" always returns null, so its return value can't signal a blocked popup.) */
function openWeb(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  // Don't let page-level click handlers (e.g. "open external links via Waypack.openExternal")
  // see this synthetic click — that would loop back into openWeb.
  a.addEventListener("click", (e) => e.stopPropagation());
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function resolveTarget(target: string | LatLon): Promise<LatLon | null> {
  if (typeof target !== "string") return target;
  const m = await manifest();
  const p = m.places.find((x) => x.id === target);
  if (!p) {
    console.warn(`[waypack] openInMaps: unknown place id "${target}"`);
    return null;
  }
  return { lat: p.lat, lon: p.lon, label: p.name };
}

const Waypack: WaypackSDK = {
  version: __SDK_VERSION__,
  manifest,
  isOnline: () => navigator.onLine,
  platform: () => host().platform,

  async map(container, opts: MapOptions = {}) {
    const m = await manifest();
    return createMap(container, opts, { manifest: m, openInMaps: (id) => Waypack.openInMaps(id) });
  },

  openInMaps(target, opts: OpenInMapsOptions = {}) {
    void (async () => {
      const t = await resolveTarget(target);
      if (!t) return;
      const m = await manifest().catch(() => null);
      const app = chooseApp(opts.app, m?.nav_app, host().platform, host().navApp);
      const navigate = opts.navigate !== false;
      const url = mapsUrl(t, app, navigate);
      if (!(await callNative("openInMaps", { lat: t.lat, lon: t.lon, label: t.label ?? null, app, navigate, url }))) openWeb(url);
    })();
  },

  openExternal(url) {
    void callNative("openExternal", { url }).then((ok) => ok || openWeb(url));
  },

  addToCalendar(target, opts: CalendarOptions = {}) {
    void (async () => {
      const r = await resolveEvent(target);
      if (!r) return;
      const app = opts.app && opts.app !== "auto" ? opts.app : defaultCalendar();
      const t = resolveTimes(r.ev, r.tz);
      const gUrl = googleCalendarUrl(r.ev, r.tz);
      const payload = {
        app,
        title: r.ev.title,
        start: t.start.toISOString(),
        end: t.end.toISOString(),
        allDay: t.allDay,
        date: r.ev.date,
        timezone: r.tz,
        location: r.ev.location ?? null,
        notes: r.ev.notes ?? null,
        googleUrl: gUrl,
      };
      if (await callNative("addToCalendar", payload)) return;
      if (app === "google") return openWeb(gUrl);
      download(`${slug(r.ev.title)}.ics`, toIcs([r.ev], r.tz, r.title), "text/calendar");
    })();
  },

  async calendarEvents() {
    return eventsFromManifest(await manifest());
  },

  downloadCalendar(opts = {}) {
    void manifest().then((m) => {
      const events = eventsFromManifest(m).filter((e) => !opts.dates || opts.dates.includes(e.date));
      download(opts.filename ?? `${slug(m.title)}.ics`, toIcs(events, m.timezone, m.title), "text/calendar");
    });
  },

  share(text) {
    void callNative("share", { text }).then(async (ok) => {
      if (ok) return;
      if (navigator.share) return navigator.share({ text }).catch(() => undefined);
      await navigator.clipboard?.writeText(text).catch(() => undefined);
      alert("Copied to clipboard");
    });
  },

  onMenu: setMenu,

  categories,
  routeModes,
};

(window as unknown as { Waypack: WaypackSDK }).Waypack = Waypack;
mountBar(() => manifest().then((m) => m.title));
export default Waypack;
