import type { BundleFile, Manifest } from "../src/index.js";

const te = new TextEncoder();
export const f = (path: string, text: string): BundleFile => ({ path, data: te.encode(text) });

export function baseManifest(): Manifest {
  return {
    schema_version: 1,
    sdk_version: "1",
    trip_id: null,
    title: "Test Trip",
    summary: "A test.",
    timezone: "America/Los_Angeles",
    start_date: "2026-12-24",
    end_date: "2026-12-25",
    map: { bbox: [-118.95, 36.4, -118.55, 36.8], max_zoom: 15, extra_areas: [] },
    places: [
      { id: "lodge", name: "Lodge", category: "lodging", lat: 36.596, lon: -118.7547 },
      { id: "town", name: "Town", category: "fuel", lat: 36.45, lon: -118.9 },
    ],
    routes: [
      { id: "r1", name: "Drive", mode: "driving", from: "town", to: "lodge", geometry: { type: "LineString", coordinates: [[-118.9, 36.45], [-118.8, 36.5], [-118.7547, 36.596]] } },
    ],
    days: [
      { date: "2026-12-24", items: [{ time: "09:00", title: "Drive", place_id: "town", route_id: "r1", kind: "travel" }] },
      { date: "2026-12-25", items: [{ time: "10:00", title: "Rest", kind: "rest" }] },
    ],
    live_checks: [{ label: "Roads", url: "https://quickmap.dot.ca.gov/" }],
    emergency: { numbers: [{ label: "Emergency", value: "911" }], places: [] },
    theme: { preset: "alpine-winter", accent: "#1d6fe0" },
  };
}

export const goodHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="assets/style.css"><script src="/__waypack/sdk/v1/waypack.js"></script></head>
<body><header data-waypack-bar><h1>Trip</h1></header><h2>Packing</h2><h2>Budget</h2><h2>Emergency</h2><h2>Backup plan</h2>
<button onclick="Waypack.openInMaps('lodge')">Navigate</button><button onclick="Waypack.addToCalendar({date:'2026-12-24',index:0})">Add to calendar</button>
<a href="https://nps.gov">NPS</a><img src="data:image/png;base64,AAAA"><script src="assets/app.js"></script></body></html>`;

export function goodBundle(m: Manifest = baseManifest(), html = goodHtml): BundleFile[] {
  return [
    f("manifest.json", JSON.stringify(m)),
    f("index.html", html),
    f("assets/style.css", "@media (prefers-color-scheme: dark){body{background:#000}} @media (min-width: 900px){body{margin:0 auto}} .x{background:url(img/a.svg)}"),
    f("assets/img/a.svg", "<svg/>"),
    f("assets/app.js", "console.log(1)"),
  ];
}
