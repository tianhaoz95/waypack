# Waypack — Product & Technical Design

> Formerly working name: **Tripfold**, renamed to **Waypack** (see ADR #1).
> Audience: a coding agent (e.g. Claude Code) building this from scratch, plus the human owner.
> Status: v1 design, October 2026. Target: dogfood-ready for winter trips (Sequoia NP, Lake Tahoe) by mid-December 2026.

---

## 1. Summary

Waypack turns any AI agent into a travel planner whose output works **fully offline on your phone**.

1. The user installs the **Waypack Skill** and connects the **Waypack MCP server** in their agent of choice (Claude Code, Claude Desktop/claude.ai, Cursor, etc.).
2. The agent interviews the user, researches, and generates a **trip bundle**: a self-contained mobile web app (HTML/CSS/JS + `manifest.json`) tailored to the trip.
3. The agent uploads the bundle through the MCP server. The backend validates it and cuts an **offline vector map extract** (PMTiles) covering the trip area.
4. The user signs into the **Waypack mobile app** (iOS + Android) with the same account, downloads the trip, and uses it with no connectivity: itinerary, lodging, routes drawn on an offline map, GPS blue dot, and hand-off to Google/Apple Maps for navigation.

### Goals
- Plans as detailed and personalized as the agent can make them, not constrained to a fixed schema.
- Everything a traveler needs works in airplane mode, including a real map with trails and the user's live location.
- Agent-agnostic: any MCP-capable agent + the skill produces consistent, high-quality bundles.
- Cheap to run; simple enough for one developer to maintain.

### Non-goals (v1)
- In-app trip editing or planning (planning happens in the agent).
- On-device routing / turn-by-turn navigation (hand off to Google/Apple Maps).
- Bookings, price tracking, flight alerts.
- Real-time collaboration. (Read-only sharing is v2.)
- A web app for planning. (A read-only web viewer is optional, see §9.)

---

## 2. Users & key flows

**Primary user:** technical-ish traveler who already uses an AI agent and travels to places with poor connectivity (national parks, mountains, abroad).

### Flow A — Create a trip (in the agent)
1. User: "Plan a 3-day Sequoia trip over Christmas with a toddler, using Waypack."
2. Skill instructs the agent to run the **intake interview** (§5.2), then research.
3. Agent calls MCP `geocode` / `compute_route` as needed for coordinates and route geometry.
4. Agent writes the bundle to a local folder (CLI agents) or assembles it in memory (chat agents).
5. Agent calls MCP `validate_bundle`, fixes issues, then uploads (§6.4).
6. MCP returns a trip ID, a status, and a short message: "Open Waypack on your phone and tap Download."

### Flow B — Download before travel (in the app)
1. Sign in (same account). Trips list shows the new trip with size estimate.
2. Tap **Download** → bundle + map extract download with progress; marked **Available offline**.
3. App warns if a trip starting within 72 hours isn't downloaded (local notification).

### Flow C — Use on the trip (offline)
1. Open trip → bundle renders in a WebView, served from local storage.
2. Map views show offline tiles, places, precomputed routes, and the GPS blue dot.
3. "Navigate" on any place → opens Google Maps / Apple Maps with coordinates.
4. Native "Today" quick view (from `manifest.json`) shows the next item even if the bundle's own UI is unusual.

### Flow D — Update a trip
Agent re-uploads with the same `trip_id` → new version. App shows "Update available"; downloads the diff-free full bundle again (bundles are small; tiles are re-cut only if the bbox changed).

---

## 3. Architecture

```
┌──────────────────────────┐        ┌───────────────────────────────────────────┐
│  User's AI agent         │  MCP   │  MCP Server (Cloudflare Worker)            │
│  + Waypack Skill         │◄──────►│  - Streamable HTTP transport               │
│  (Claude Code, etc.)     │ OAuth  │  - OAuth 2.1 (workers-oauth-provider),     │
└──────────┬───────────────┘        │    Supabase Auth as upstream identity      │
           │ presigned PUT          │  - tools: trips, upload, validate, route…  │
           ▼                        └──────┬───────────────┬────────────────────┘
┌──────────────────────────┐               │               │ enqueue
│ Cloudflare R2            │◄──────────────┘               ▼
│  bundles/, tiles/        │◄───────────── ┌────────────────────────────────────┐
└──────────┬───────────────┘   writes .pmtiles │ Tiler job (container)          │
           │ signed GET                    │  pmtiles extract from planet     │
           ▼                               │  mirror in R2 → tiles/{trip}.pmtiles│
┌──────────────────────────┐               └────────────────────────────────────┘
│ Mobile app (Flutter)     │   REST/JWT   ┌────────────────────────────────────┐
│  - local HTTP server     │◄────────────►│ Supabase: Auth + Postgres (+RLS)   │
│  - WebView (bundle)      │              │  + Edge Function: RevenueCat hook  │
│  - Trip SDK + MapLibre   │              └────────────────────────────────────┘
│  - RevenueCat            │
└──────────────────────────┘
```

### Technology choices
| Concern | Choice | Why |
|---|---|---|
| Identity, DB | **Supabase** (Auth + Postgres with RLS) | Fast to set up; Apple/Google/email sign-in; RLS for per-user data |
| MCP server | **Cloudflare Worker** using `agents` (McpAgent) + `@cloudflare/workers-oauth-provider` | Mature remote-MCP + OAuth 2.1 implementation (protected resource metadata, dynamic client registration) |
| Blob storage | **Cloudflare R2** | No egress fees — tiles are the bulk of bytes |
| Tile extraction | **`pmtiles` CLI** in a small container (Fly.io Machine or Cloud Run Job) | `pmtiles extract` with `--bbox` and `--maxzoom`; can read the planet over HTTP range requests |
| Basemap data | **Protomaps** OpenStreetMap basemap build (PMTiles), mirrored to R2 | Single-file vector tiles; includes trails/paths; ODbL |
| Map renderer | **MapLibre GL JS** in the WebView + `pmtiles` JS protocol | Open source; same code works in browser preview and app |
| Mobile app | **Flutter** (`flutter_inappwebview`, `shelf` local server) | One codebase; owner already ships Flutter apps |
| Routing / geocoding | **OpenRouteService** API (server-side key) behind MCP tools | Driving + hiking profiles; free tier is enough for dogfooding |
| Payments | **RevenueCat** (App Store + Play) → webhook → Supabase | Handles subscription + lifetime non-consumable; entitlements in one place |

> If the coding agent finds a choice above outdated or broken at build time, prefer the closest equivalent and record the deviation in `docs/DECISIONS.md`.

---

## 4. Trip bundle format (the core contract)

A bundle is a directory (uploaded as a `.zip`) that renders as a single-page mobile web app **with zero network access**.

### 4.1 Layout
```
my-trip/
  manifest.json          # REQUIRED — structured trip data + metadata (§4.2)
  index.html             # REQUIRED — entry point
  assets/                # optional — css, js, images, fonts (all local)
    style.css
    app.js
    img/...
```

### 4.2 `manifest.json` schema (v1)
Authoritative JSON Schema lives in `packages/bundle-schema/manifest.v1.schema.json`. Shape:

```json
{
  "schema_version": 1,
  "sdk_version": "1",
  "trip_id": null,
  "title": "Sequoia Winter Weekend",
  "summary": "3 days in Sequoia & Kings Canyon with a toddler; snow play, Giant Forest, easy trails.",
  "timezone": "America/Los_Angeles",
  "start_date": "2026-12-24",
  "end_date": "2026-12-26",
  "travelers": { "adults": 2, "children": [{ "age": 2 }] },
  "map": {
    "bbox": [-118.95, 36.40, -118.55, 36.80],
    "max_zoom": 15,
    "extra_areas": []
  },
  "places": [
    {
      "id": "lodge-wuksachi",
      "name": "Wuksachi Lodge",
      "category": "lodging",
      "lat": 36.5960, "lon": -118.7547,
      "address": "64740 Wuksachi Way, Sequoia National Park, CA",
      "phone": "+1-...",
      "notes": "Check-in 4pm. Confirmation #ABC123.",
      "links": [{ "label": "Reservation", "url": "https://..." }]
    }
  ],
  "routes": [
    {
      "id": "r-day1-drive",
      "name": "Three Rivers → Wuksachi Lodge",
      "mode": "driving",
      "from": "place-three-rivers", "to": "lodge-wuksachi",
      "distance_m": 52000, "duration_s": 4500,
      "geometry": { "type": "LineString", "coordinates": [[-118.9, 36.45], [-118.75, 36.59]] },
      "notes": "Generals Highway; chains may be required — check before leaving."
    }
  ],
  "days": [
    {
      "date": "2026-12-24",
      "title": "Drive in & Giant Forest",
      "items": [
        {
          "time": "09:00", "end_time": "10:30",
          "title": "Drive to park entrance",
          "place_id": "place-three-rivers", "route_id": "r-day1-drive",
          "kind": "travel", "notes": "Last gas in Three Rivers."
        }
      ]
    }
  ],
  "live_checks": [
    { "label": "Caltrans road conditions", "url": "https://quickmap.dot.ca.gov/" },
    { "label": "NPS Sequoia alerts", "url": "https://www.nps.gov/seki/planyourvisit/conditions.htm" }
  ],
  "emergency": {
    "numbers": [{ "label": "Emergency", "value": "911" }],
    "notes": "Most of the park has no cell service. Nearest hospital: ...",
    "places": ["hospital-kaweah"]
  },
  "offline_notes": "Download Google Maps offline area for Visalia–Sequoia before leaving."
}
```

**Rules**
- `places[].category` enum: `lodging | food | sight | activity | trailhead | transport | fuel | shopping | medical | other`.
- `routes[].mode` enum: `driving | walking | hiking | cycling | transit | ferry | flight`.
- `routes[].geometry` must be a GeoJSON `LineString` or `MultiLineString`, ≤ 5,000 coordinates per route (simplify server-side output if needed).
- `map.bbox` = `[minLon, minLat, maxLon, maxLat]`; area ≤ 40,000 km² per box (v1 limit), up to 4 boxes total via `extra_areas`. `max_zoom` 10–16, default 15.
- All dates ISO 8601; times are local to `timezone`.
- `trip_id`: `null` for new trips; set to an existing ID to publish a new version.

The manifest is the **source of truth for native features** (Today view, notifications, trip list, map extract). The HTML is the source of truth for the rich experience. The skill must keep them consistent.

### 4.3 HTML/JS constraints (enforced by validator + CSP)
- No network: all `src`/`href` must be relative paths inside the bundle, `data:` URIs, or the SDK path `/__waypack/sdk/v1/...`. External links (`<a href="https://...">`) are allowed and open in the system browser.
- No `fetch`/XHR to external origins (blocked by CSP at runtime).
- Max bundle size: **25 MB** zipped, **2,000 files**. Images should be compressed (WebP/JPEG, ≤ 1600px).
- Must load and be usable within 2s on a mid-range phone; mobile-first; support dark mode via `prefers-color-scheme`.
- Use the Trip SDK for maps (§7). Do not bundle another copy of MapLibre.

### 4.4 Runtime CSP (set by the app's local server)
```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
worker-src 'self' blob:; frame-src 'none'; object-src 'none'
```

---

## 5. Waypack Skill

Lives in `skill/` as an Agent Skill: `skill/SKILL.md` plus `skill/templates/` and `skill/reference/`.

### 5.1 Skill responsibilities
1. Run the intake interview.
2. Enforce the coverage checklist.
3. Teach bundle authoring rules, manifest schema, and Trip SDK usage.
4. Teach the upload procedure (CLI vs chat agents).
5. Require self-validation before upload.

### 5.2 Intake interview (ask only what's missing; batch questions)
Destination(s) and dates; who's traveling (ages, mobility, kids, pets); pace (relaxed/packed); interests; must-dos and must-avoids; lodging status (booked → collect confirmation details; not booked → recommend); transport (own car, rental, transit; EV?); budget level; dietary needs; season-specific gear (chains, snow gear); connectivity expectations; preferred navigation app.

### 5.3 Coverage checklist (every plan must address each, or explicitly say N/A)
- **Overview:** one-screen summary, dates, travelers, key reservations.
- **Today view:** the HTML must make "what's next today" reachable in one tap.
- **Day-by-day itinerary** with times, durations, and buffer time; realistic drive times from `compute_route`.
- **Lodging:** address, coordinates, check-in/out, confirmation numbers, contact, parking.
- **Routes:** every non-trivial move has a route with geometry and notes (closures, chains, tolls, last fuel).
- **Places:** hours (with "verify" caveat), cost, reservation needs, kid/accessibility notes.
- **Food:** options near each day's area, including fallback for closures.
- **Conditions & live checks:** seasonal risks; links in `live_checks`; never present volatile conditions as fact.
- **Safety:** no-service zones, emergency numbers, nearest hospital/urgent care, ranger stations.
- **Packing list** tailored to season, activities, and travelers.
- **Budget** estimate by category.
- **Backup plans** for weather and closures per day.
- **Offline prep checklist:** download this trip, download Google/Apple offline map area, charge power banks, print key confirmations.

### 5.4 Authoring guidance
- Start from `skill/templates/base/` (a polished, accessible starter bundle using the SDK). Customize freely; keep the manifest accurate.
- Large tap targets (≥ 44px), readable at arm's length, works one-handed.
- Each place/item gets a "Navigate" button using `Waypack.openInMaps(placeId)`.
- Tell the agent to compute coordinates with `geocode` (don't guess coordinates) and routes with `compute_route`.

### 5.5 Upload procedure
- **CLI agents (filesystem + shell):** write bundle to `./waypack/<slug>/` → `npx @waypack/cli validate ./waypack/<slug>` (or MCP `validate_bundle`) → MCP `create_upload` → `curl -T bundle.zip "<presigned_url>"` → MCP `finalize_upload`.
- **Chat agents (no shell):** MCP `upload_bundle_inline` with files as `{path, content, encoding}` entries (text as utf-8, binary as base64); limit 4 MB total. Prefer inline SVG and few images.

---

## 6. MCP server

### 6.1 Transport & auth
- Remote MCP over **Streamable HTTP** at `https://mcp.waypack.app/mcp`.
- OAuth 2.1 per the MCP authorization spec: Protected Resource Metadata (RFC 9728), Authorization Server Metadata, PKCE, Dynamic Client Registration (RFC 7591). Use `@cloudflare/workers-oauth-provider`; its authorize step redirects to a Supabase-hosted sign-in page, then maps the Supabase user ID into the MCP token's props.
- **Test against real clients early** (Claude Code, claude.ai custom connector, MCP Inspector). This is the most likely integration snag.
- Fallback for headless use: personal API tokens generated in the app's Settings, sent as `Authorization: Bearer`.

### 6.2 Tools
| Tool | Input | Output | Notes |
|---|---|---|---|
| `get_authoring_guide` | `{}` | markdown | Returns the condensed skill guide + current schema/SDK versions, for agents without the skill installed |
| `list_trips` | `{}` | `[{trip_id, title, start_date, version, status}]` | |
| `get_trip` | `{trip_id}` | manifest + status | Lets the agent revise an existing trip |
| `geocode` | `{query, near?: {lat, lon}}` | `[{name, lat, lon, address, confidence}]` | ORS geocoding; cache results |
| `compute_route` | `{from: {lat, lon}, to: {lat, lon}, via?: [...], mode}` | `{distance_m, duration_s, geometry}` | ORS directions; geometry simplified to ≤ 5k points |
| `validate_bundle` | `{files: [...]}` or `{upload_id}` | `{ok, errors[], warnings[]}` | Same validator as CLI (§6.5) |
| `create_upload` | `{trip_id?, size_bytes}` | `{upload_id, put_url, expires_at}` | Presigned R2 PUT for a zip |
| `upload_bundle_inline` | `{trip_id?, files: [{path, content, encoding}]}` | same as finalize | ≤ 4 MB total |
| `finalize_upload` | `{upload_id}` | `{trip_id, version, status, app_hint}` | Validates, stores, enqueues tile job if bbox changed |
| `get_trip_status` | `{trip_id}` | `{status, tiles_status, sizes}` | `processing | ready | failed` |
| `delete_trip` | `{trip_id}` | `{ok}` | Requires `confirm: true` |

All tools return concise text plus structured content. Errors are actionable ("`places[3].lat` missing — call `geocode`").

### 6.3 Entitlement checks
Enforced in `finalize_upload` / `upload_bundle_inline` (§11): free tier limits on active trips and offline maps. Return a clear upgrade message rather than failing silently.

### 6.4 Processing pipeline
1. Unzip to a temp prefix; run validator.
2. Write to `r2://bundles/{user_id}/{trip_id}/v{n}/bundle.zip` plus extracted `manifest.json` → DB row in `trip_versions`.
3. If `map` changed from the previous version (or first version): insert `map_extracts` row (`pending`) and enqueue a tile job (Cloudflare Queue → HTTP trigger to the tiler).
4. Tiler runs `pmtiles extract <planet_url> out.pmtiles --bbox=<...> --maxzoom=<z>` for each area, uploads to `r2://tiles/{user_id}/{trip_id}/{hash}.pmtiles`, marks `ready` with size. Multiple areas → multiple files listed in the DB.
5. Trip status = `ready` when bundle stored and all extracts ready.

### 6.5 Validator (`packages/bundle-schema`, TypeScript, shared by CLI + Worker)
- JSON Schema validation of `manifest.json` (Ajv).
- Referential integrity: `place_id`, `route_id`, `from`/`to`, `emergency.places` all resolve.
- Dates within range; items sorted; bbox contains all places (warning if not, auto-suggest expanded bbox).
- HTML scan: no external `src`/`href` on scripts, styles, images, iframes; no `<base>`; size/file-count limits; `index.html` exists.
- Warnings for coverage gaps (no `live_checks`, no emergency info, no packing list section detected).

### 6.6 Basemap planet mirror
- Monthly job copies the latest Protomaps planet build to `r2://basemap/planet-YYYYMMDD.pmtiles`; config points the tiler at the current one. Extract via range requests from R2 (same-cloud, fast).

---

## 7. Trip SDK (JavaScript)

Package `packages/trip-sdk` (TypeScript → single UMD/ESM file). Shipped **inside the app** and served at `/__waypack/sdk/v1/waypack.js`; also served from a CDN for browser preview.

Bundles include:
```html
<script src="/__waypack/sdk/v1/waypack.js"></script>
```

### 7.1 API (v1 — never make breaking changes within a major version)
```ts
interface WaypackSDK {
  version: string;
  manifest(): Promise<Manifest>;            // parsed manifest.json
  isOnline(): boolean;
  platform(): "ios" | "android" | "web";

  map(container: HTMLElement | string, opts?: {
    places?: string[] | "all";              // place ids to show
    routes?: string[] | "all";
    day?: string;                           // ISO date → that day's places/routes
    fit?: "places" | "routes" | "bbox";
    showUserLocation?: boolean;             // default true
    interactive?: boolean;                  // default true
    style?: "light" | "dark" | "auto";      // default auto
    onPlaceClick?: (placeId: string) => void;
  }): Promise<TripMap>;

  openInMaps(target: string | { lat: number; lon: number; label?: string },
             opts?: { app?: "google" | "apple" | "auto"; navigate?: boolean }): void;
  openExternal(url: string): void;          // system browser
  share(text: string): void;                // native share sheet
}

interface TripMap {
  flyTo(placeId: string, zoom?: number): void;
  highlightRoute(routeId: string): void;
  setDay(date: string): void;
  destroy(): void;
  raw: unknown;                              // underlying maplibregl.Map (escape hatch)
}
```
Exposed as `window.Waypack`.

### 7.2 Implementation notes
- Bundles MapLibre GL JS + `pmtiles` + Protomaps basemap layer definitions.
- Registers the `pmtiles://` protocol. Tile URL comes from the host: in-app, the local server exposes `/__waypack/tiles/index.json` listing available extracts; in browser preview, the SDK uses an online Protomaps endpoint or the user's uploaded extract via signed URL.
- **Glyphs (fonts) and sprites ship with the SDK** under `/__waypack/sdk/v1/assets/` so labels render offline.
- Category → icon/color mapping built in; routes styled by mode (hiking dashed, driving solid).
- User location: MapLibre `GeolocateControl` (GPS works offline). App must grant WebView geolocation permission.
- Attribution control always visible: "© OpenStreetMap contributors, Protomaps" (ODbL requirement).
- Native bridge (in-app): `openInMaps`, `openExternal`, `share` call Flutter via `flutter_inappwebview` JavaScript handlers; on web, fall back to standard URLs (`https://www.google.com/maps/dir/?api=1&destination=lat,lon`, `https://maps.apple.com/?daddr=lat,lon`).

---

## 8. Mobile app (Flutter)

### 8.1 Screens
1. **Sign in** — Sign in with Apple, Google, email magic link (Supabase).
2. **Trips** — upcoming/past; per trip: dates, download state (Not downloaded / Downloading x% / Offline ✓ / Update available), size.
3. **Trip** — opens the bundle full-screen in a WebView; a small native overlay button reveals: Today, Map, Info (download status, version, last synced), Re-download, Delete local copy.
4. **Today (native)** — rendered from `manifest.json`: current/next items, tap → navigate. Guaranteed to work even if the bundle UI is buggy.
5. **Settings** — account, subscription (RevenueCat paywall), storage used, API tokens, "How to connect your agent" (MCP URL + skill install instructions), attribution/licenses.

### 8.2 Offline serving
- Storage: `<app_docs>/trips/{trip_id}/v{n}/` (unzipped bundle) and `<app_docs>/tiles/{trip_id}/*.pmtiles`.
- On app start, launch a **`shelf` HTTP server bound to 127.0.0.1 on a random port**, requiring a per-launch random token (path prefix or cookie) so other apps can't read data.
  - `/t/{trip_id}/...` → bundle files
  - `/__waypack/sdk/v1/...` → SDK from app assets
  - `/__waypack/tiles/...` → PMTiles files with **HTTP Range support** (required by pmtiles JS)
  - Adds CSP header (§4.4) to HTML responses.
- iOS: allow loopback HTTP via ATS `NSAllowsLocalNetworking`. Android: `usesCleartextTraffic` scoped to localhost via network security config.
- WebView: intercept navigations — non-loopback URLs open in the system browser; block `window.open` popups to external origins.
- Geolocation: request location permission natively; grant WebView geolocation requests from the loopback origin only.

### 8.3 Sync & downloads
- Trips list via Supabase (RLS) on launch / pull-to-refresh.
- Download: request signed R2 GET URLs from an Edge Function (`/download-urls?trip_id=`) → resumable download (background on Android via WorkManager; iOS background `URLSession` via a plugin such as `background_downloader`) → verify SHA-256 → unzip → atomically swap into place.
- Keep previous version until the new one is complete.
- Local notification 72h before `start_date` if not downloaded.

### 8.4 Native affordances (also help with App Store "minimum functionality" review)
Offline download manager, native Today view, GPS map, trip reminders, share sheet. Position the app as a **document/trip viewer for the user's own plans**; bundles never change native app functionality.

---

## 9. Optional: web viewer & local preview
- `@waypack/cli preview ./bundle` — serves the bundle locally with the SDK in web mode and online tiles, so agents/users can iterate before uploading. Also runs `validate`.
- `https://waypack.app/t/{trip_id}` (v2) — authenticated read-only viewer. Serve each trip from a **separate sandboxed origin** (e.g. `{trip_hash}.view.waypack.app`) because bundles contain arbitrary JS.

---

## 10. Data model (Supabase Postgres)

```sql
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  created_at timestamptz default now()
);

create table trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  title text not null,
  start_date date, end_date date,
  current_version int not null default 0,
  status text not null default 'processing',   -- processing | ready | failed
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

create table trip_versions (
  trip_id uuid references trips on delete cascade,
  version int,
  bundle_key text not null,          -- R2 key
  bundle_sha256 text not null,
  bundle_bytes bigint not null,
  manifest jsonb not null,
  sdk_version text not null,
  created_at timestamptz default now(),
  primary key (trip_id, version)
);

create table map_extracts (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips on delete cascade,
  area_hash text not null,           -- hash(bbox, max_zoom, basemap_build)
  bbox double precision[4] not null,
  max_zoom int not null,
  tiles_key text,
  tiles_bytes bigint,
  status text not null default 'pending',  -- pending | ready | failed | expired
  error text,
  created_at timestamptz default now(),
  expires_at timestamptz             -- end_date + 30 days
);

create table entitlements (
  user_id uuid primary key references auth.users on delete cascade,
  tier text not null default 'free', -- free | annual | lifetime
  active boolean not null default true,
  expires_at timestamptz,
  updated_at timestamptz default now()
);

create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  token_hash text not null,
  label text, created_at timestamptz default now(), last_used_at timestamptz
);
```
RLS: users can `select` their own rows in `trips`, `trip_versions`, `map_extracts`, `entitlements`. All writes happen server-side (MCP Worker / Edge Functions with the service role).

---

## 11. Monetization & limits

| | Free | Annual ($14.99/yr) | Lifetime ($39.99, "Founding member", limited) |
|---|---|---|---|
| Active trips (end_date ≥ today) | 1 | 10 | 10 |
| Offline map extracts | ✗ (bundle offline only; map needs network) | ✓ | ✓ |
| Max total extract area / trip | — | 4 boxes | 4 boxes |
| Past trips kept | ✓ (bundle) | ✓ | ✓ |

- Map extracts **expire 30 days after `end_date`** (deleted from R2); bundle kept. Re-downloading an old trip re-cuts tiles on demand (entitled users).
- RevenueCat entitlement `pro`; products: `waypack_annual` (auto-renew subscription), `waypack_lifetime` (non-consumable). Webhook → Supabase Edge Function `revenuecat-webhook` → upsert `entitlements`.
- Prices are starting points; configure in stores/RevenueCat, not hard-coded.

---

## 12. Security & privacy
- Bundles are private to the owner; R2 objects only reachable through short-lived signed URLs.
- Local server: loopback only, random port, per-launch token, CSP, no file access outside the trip directory (path traversal checks).
- Validator rejects zips with absolute paths, `..` segments, symlinks.
- Rate limits on MCP tools (per user) — especially `compute_route`/`geocode` to protect the ORS quota.
- No analytics in the WebView. App analytics minimal and opt-out.
- Account deletion deletes DB rows and R2 objects.

---

## 13. Repository layout (monorepo)
```
waypack/
  apps/mobile/                 # Flutter app
  services/mcp/                # Cloudflare Worker: MCP + OAuth + upload pipeline
  services/tiler/              # Dockerfile + small HTTP handler wrapping `pmtiles extract`
  supabase/                    # migrations, edge functions (download-urls, revenuecat-webhook)
  packages/bundle-schema/      # JSON Schema + TS validator (used by CLI + Worker)
  packages/trip-sdk/           # window.Waypack SDK (MapLibre + pmtiles + assets)
  packages/cli/                # @waypack/cli: validate, preview, zip
  skill/                       # SKILL.md, templates/base/, reference/
  examples/sequoia-winter/     # real dogfood bundle
  docs/DECISIONS.md
```

---

## 14. Milestones & acceptance criteria

**M0 — Contract & skill (first)**
- `manifest.v1.schema.json`, validator, CLI `validate` + `preview`.
- Trip SDK v1 working in browser preview with online tiles.
- SKILL.md + base template.
- ✅ An agent using only the skill + CLI produces `examples/sequoia-winter` that validates and looks good on a phone browser.

**M1 — Backend + MCP**
- Supabase schema, auth providers; Worker with OAuth; tools in §6.2; R2 storage; tiler job.
- ✅ From Claude Code: connect MCP, sign in, upload Sequoia example, `get_trip_status` reaches `ready` with a `.pmtiles` in R2. ✅ Same via claude.ai connector using `upload_bundle_inline`.

**M2 — App viewer offline**
- Sign-in, trips list, download/verify/unzip, local server, WebView, CSP, external-link handling, native Today view.
- ✅ Airplane mode: trip opens, all pages work, "Navigate" opens maps app.

**M3 — Offline maps**
- SDK served from app, pmtiles via Range, glyphs/sprites bundled, GPS blue dot, routes drawn.
- ✅ Airplane mode: map renders with trail labels at z15 inside bbox; blue dot updates on a walk.

**M4 — Payments & limits**
- RevenueCat paywall, webhook, entitlement enforcement in MCP, extract expiry job.
- ✅ Sandbox purchase of annual and lifetime flips entitlement; free user hitting a limit gets a clear message in the agent.

**M5 — Launch**
- Store listings, privacy policy, attribution screen, landing page with skill install + MCP URL, dogfood report from real trips.

---

## 15. Testing
- Validator: unit tests with fixture bundles (valid, missing fields, external scripts, path traversal, oversize).
- SDK: Playwright tests in a mobile viewport against preview server; offline mode emulation.
- MCP: integration tests with MCP Inspector / SDK client, including the OAuth flow.
- App: widget tests for lists/state; integration test that downloads a fixture trip and loads it offline (iOS simulator + Android emulator).
- Manual field test: drive into a no-service area with only downloaded data.

---

## 16. Open questions
1. Include hillshade/terrain (e.g. a raster DEM extract) for mountain trips in v1.1? Adds size but big value for parks.
2. Should free tier include a low-zoom (≤ z12) map extract so the free experience shows the core magic?
3. Read-only sharing with travel companions (v2): link + app sign-in, or account-less share codes?
4. Support uploading bundles generated without the skill (any HTML) with a minimal manifest?
5. Mirror the planet monthly vs. extracting directly from Protomaps' public builds (check their usage terms before relying on them).
