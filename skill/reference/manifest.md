# manifest.json (schema v1)

Authoritative JSON Schema: `packages/bundle-schema/manifest.v1.schema.json` (also returned by the MCP `get_authoring_guide` tool).

```jsonc
{
  "schema_version": 1,               // always 1
  "sdk_version": "1",                // SDK major the bundle targets
  "trip_id": null,                   // null = new trip; existing UUID = publish a new version
  "title": "Sequoia Winter Weekend", // ≤ 120 chars
  "summary": "3 days in Sequoia with a toddler…",
  "cover_image": "assets/cover.jpg", // optional relative path to trip card cover image in bundle (JPEG/PNG/WebP)
  "timezone": "America/Los_Angeles", // IANA; all times are local to it
  "start_date": "2026-12-24",        // YYYY-MM-DD
  "end_date": "2026-12-26",
  "travelers": { "adults": 2, "children": [{ "age": 2 }] },
  "nav_app": "google",               // optional: "google" | "apple" (default by platform)
  "theme": {                         // optional but expected: how the plan looks
    "preset": "winter-forest",       // alpine-winter|winter-forest|lake-summer|coast|tropical|desert|autumn|spring-blossom|city
    "accent": "#9a3f1d",             // optional hex overrides of the preset's accent (light / dark mode)
    "accent_dark": "#e08a62",
    "mood": "Giant sequoias in fresh snow",  // ≤ 200 chars, for your own notes
    "scene": {                       // the banner illustration; every field optional
      "sun": "low-sun",              // sun|low-sun|moon|none
      "mountains": "snowy-peaks",    // none|rolling|peaks|snowy-peaks|mesas
      "water": "none",               // none|lake|frozen-lake|ocean|river
      "trees": "sequoia",            // none|pine|snowy-pine|sequoia|palm|deciduous|autumn|blossom|cactus
      "ground": "snow",              // snow|grass|sand|rock|city
      "particles": "snow",           // none|snow|leaves|petals|stars|rain
      "skyline": false               // city skyline silhouette
    }
  },
  "map": {
    "bbox": [-118.95, 36.40, -118.55, 36.80], // [minLon, minLat, maxLon, maxLat], ≤ 40,000 km²
    "max_zoom": 15,                            // 10–16 (basemap detail tops out at 15)
    "extra_areas": [ { "bbox": [...], "label": "Fresno" } ] // ≤ 3 more boxes
  },
  "places": [{
    "id": "lodge-wuksachi",          // ^[a-z0-9][a-z0-9_-]{0,63}$, unique across places
    "name": "Wuksachi Lodge",
    "category": "lodging",           // lodging|food|sight|activity|trailhead|transport|fuel|shopping|medical|other
    "lat": 36.5960, "lon": -118.7547,// from `geocode` — never guessed
    "address": "...", "phone": "+1-...", "hours": "...", "cost": "...",
    "notes": "Check-in 4pm. Confirmation #ABC123.",
    "links": [{ "label": "Reservation", "url": "https://..." }]  // http(s)/tel/mailto/sms
  }],
  "routes": [{
    "id": "r-day1-drive",
    "name": "Three Rivers → Wuksachi Lodge",
    "mode": "driving",               // driving|walking|hiking|cycling|transit|ferry|flight
    "from": "place-three-rivers", "to": "lodge-wuksachi",   // optional place ids
    "distance_m": 52000, "duration_s": 4500,
    "geometry": { "type": "LineString", "coordinates": [[lon, lat], ...] }, // from `compute_route`, ≤ 5,000 points
    "notes": "Chains may be required — verify."
  }],
  "days": [{
    "date": "2026-12-24", "title": "Drive in & Giant Forest", "notes": "optional",
    "items": [{
      "time": "09:00", "end_time": "10:30",   // 24h HH:MM; items sorted by time. end_time sets the calendar event's end
      "title": "Drive to park entrance",
      "place_id": "place-three-rivers", "route_id": "r-day1-drive",
      "kind": "travel",                        // travel|activity|meal|lodging|rest|reservation|other
      "notes": "Last gas in Three Rivers."
    }]
  }],
  "live_checks": [{ "label": "Caltrans road conditions", "url": "https://quickmap.dot.ca.gov/" }],
  "emergency": {
    "numbers": [{ "label": "Emergency", "value": "911" }],
    "notes": "Most of the park has no cell service…",
    "places": ["hospital-kaweah"]              // place ids
  },
  "offline_notes": "Download a Google Maps offline area for Visalia–Sequoia."
}
```

## Integrity rules checked by the validator
- Referenced ids (`place_id`, `route_id`, `from`, `to`, `emergency.places`) must exist.
- `start_date ≤ end_date`; every `days[].date` within range and unique; a warning for missing days.
- Items sorted by `time`; `end_time ≥ time` (split overnight items across days).
- Places outside every map area → warning with a suggested expanded bbox.
- Route geometry: valid `[lon, lat]` order, ≤ 5,000 coordinates; 2-point lines get a warning (use `compute_route`).
- Extra properties are allowed (for your own rendering) — the app ignores them.
