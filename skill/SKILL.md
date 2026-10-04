---
name: waypack
description: Plan a trip and publish it to the Waypack phone app as an offline trip bundle (itinerary, lodging, routes on an offline map with GPS, Navigate hand-off). Use when the user asks to plan a trip, itinerary, road trip, park visit or vacation "with Waypack", wants a trip that works offline / without signal, or asks to update a Waypack trip.
---

# Waypack — offline trip bundles

You are building a **trip bundle**: a small mobile web app (`index.html` + `manifest.json` + `assets/`) that the Waypack app downloads and runs **with zero network access**. The Waypack MCP server gives you `geocode`, `compute_route`, `validate_bundle`, and upload tools. The backend adds an offline vector map of the trip area automatically.

Work through the phases below in order. Do not skip validation.

## Phase 1 — Intake interview

Ask **only what you don't already know**, in **one batched message** (numbered, short). Cover:

1. Destination(s) and exact dates (and arrival/departure times if known)
2. Travelers: adults, children's ages, mobility limits, pets
3. Pace: relaxed / balanced / packed
4. Interests, must-dos, must-avoids
5. Lodging: booked? → collect name, address, confirmation #, check-in/out, phone. Not booked? → you recommend
6. Transport: own car / rental / transit; EV? 4WD/AWD? chains?
7. Budget level; dietary needs
8. Season-specific gear (snow, heat, rain); connectivity expectations
9. Preferred navigation app (Google Maps or Apple Maps)

If the user says "just plan it", make sensible assumptions and **list them** at the top of the Overview.

**Starting from a shared trip?** If the user gives a Waypack link (`…/t/<token>/` or `…/remix/<token>`), call MCP `get_shared_trip { url }` first and ask only about what's different: their dates, group, pace and changes. Treat it as a starting point: a new season changes hours, closures, daylight, gear and sometimes whole activities. Re-research, geocode any new places, recompute every route, and credit it in the Overview ("Based on a shared Waypack trip").

## Phase 2 — Research

- Research real places, current-season hours, fees, reservations, closures and seasonal risks. Prefer official sources (NPS, state DOT, operator sites).
- **Coordinates:** call `geocode` for every place. Never guess or recall coordinates. If geocoding fails, try a more specific query (with town/state) or use `near`.
- **Routes:** call `compute_route` for every non-trivial move (driving > ~1 km, every hike). Use `mode: "hiking"` for trails. Paste the returned `geometry`, `distance_m`, `duration_s` into the manifest.
- Volatile facts (road conditions, chain controls, weather, closures) are **never** stated as fact: say "verify before leaving" and add a `live_checks` link.

## Phase 3 — Author the bundle (with a live preview)

**Show your work as you go.** The user can watch the plan take shape on any phone or computer, and redirect you early:
1. As soon as you have a skeleton (template files + `manifest.json` with title, dates, theme and an outline), call MCP `push_preview` with all files. **Give the user the `preview_url` right away**: "Here's a live preview; it updates as I work."
2. Push again at **milestones**: each finished day, the Guide section, the final pass. Usually 4–6 pushes. Send **only the files that changed** (pass the `preview_id`); unchanged files are kept. Don't push after every small edit.
3. Unfinished is fine: `push_preview` reports validation issues but never blocks. Previews don't reach the app and don't cut offline maps.
4. CLI agents can also run `npx @waypack/cli preview ./waypack/<slug>` locally, and push a zip as a preview (`create_upload { preview: true, preview_id }` → PUT → `finalize_upload`); see `reference/upload.md`.

Start from the template: CLI agents run `npx @waypack/cli init ./waypack/<slug>` (or copy `templates/base/` from this skill). Chat agents call `get_authoring_guide` and reproduce the template files.

1. **`manifest.json`** — structured data, the source of truth for the app's native Today view, notifications and the offline map. Schema: `reference/manifest.md`. Key rules:
   - `places[].id` / `routes[].id`: lowercase slugs (`lodge-wuksachi`, `r-day1-drive`)
   - `map.bbox` = `[minLon, minLat, maxLon, maxLat]` covering every place + a few km. ≤ 40,000 km² per box; use `extra_areas` (≤ 3 more) for far-apart bases instead of one giant box.
   - Every day between `start_date` and `end_date` gets a `days[]` entry; items sorted by `time` (24h `HH:MM`, local to `timezone`).
   - Set `nav_app` to `"google"` or `"apple"` from the interview.
   - Set `theme` so the plan looks like **the destination in that season** (see "Theme" below).
2. **`index.html`** — the rich experience. Keep the template's tabs (Today / Plan / Map / Places / Guide); rewrite the **Guide** section content with your research. Add per-day rich notes via `<div data-day-notes="YYYY-MM-DD">`. You may restyle or restructure freely, as long as the rules in `reference/authoring.md` hold.
3. **Theme**: pick the `theme.preset` closest to the place and season, then compose `theme.scene` from what the traveler will actually see. The template paints the banner from it, and the app tints its native screens with `theme.accent`.
   - Presets: `alpine-winter`, `winter-forest`, `lake-summer`, `coast`, `tropical`, `desert`, `autumn`, `spring-blossom`, `city`.
   - Examples: Lake Tahoe in January → `alpine-winter` with `snowy-peaks`, `lake`, `snowy-pine`, snow ground and falling snow. Sequoia in December → `winter-forest` with `sequoia` trees. Zion in October → `desert` with `mesas`, `river`, `autumn`. Kyoto in April → `spring-blossom` with `blossom`, `city` ground, `petals`.
   - Be accurate: Lake Tahoe never freezes, so use `lake`, not `frozen-lake`. Set `accent` (and `accent_dark`) only when the preset's color doesn't fit. Full field list: `reference/manifest.md`.
4. **Coverage checklist** — every plan must address each item (or say "N/A — reason"):
   - [ ] **Overview**: one-screen summary, dates, travelers, key reservations, assumptions
   - [ ] **Today view** reachable in one tap (template's Today tab)
   - [ ] **Day-by-day itinerary** with times, durations, buffers; drive times from `compute_route`. Give items an `end_time` where you know it
   - [ ] **Add to calendar** button on every timed item (template's `data-cal` buttons → `Waypack.addToCalendar`)
   - [ ] **Lodging**: address, coordinates, check-in/out, confirmation #, phone, parking
   - [ ] **Routes**: every non-trivial move, with notes (closures, chains, tolls, last fuel)
   - [ ] **Places**: hours ("verify"), cost, reservation needs, kid/accessibility notes
   - [ ] **Food** near each day's area, plus a fallback if closed
   - [ ] **Conditions & live checks**: seasonal risks + `live_checks` links
   - [ ] **Safety**: no-service zones, emergency numbers, nearest hospital/urgent care, ranger stations (as `medical`/`other` places referenced from `emergency.places`)
   - [ ] **Packing list** for season, activities, travelers
   - [ ] **Budget** estimate by category
   - [ ] **Backup plans** per day for weather/closures
   - [ ] **Offline prep**: download trip in Waypack, download Google/Apple offline area, charge power banks, print confirmations

### Hard rules (the validator enforces them)
- **No network.** Every `src`/`href` for scripts, styles, images, fonts must be a relative path in the bundle, a `data:` URI, or `/__waypack/sdk/v1/…`. No CDNs, no Google Fonts, no remote images, no iframes, no `<base>`. External `<a href="https://…">` links are fine (they open the browser when online).
- Include the SDK: `<script src="/__waypack/sdk/v1/waypack.js"></script>`. Use `Waypack.map()` for maps — never bundle MapLibre/Leaflet or tile URLs.
- Every place/item gets a **Navigate** button → `Waypack.openInMaps(placeId)`.
- Mobile-first: tap targets ≥ 44px, body text ≥ 16px, works one-handed, supports dark mode (`prefers-color-scheme`).
- **Responsive:** the plan also opens on iPad and desktop. Keep the template's wide layouts (two columns from 760px; side rail and pinned map from 1100px), or write your own `@media (min-width: …)` rules. No stretched single column on a wide screen.
- ≤ 25 MB zipped, ≤ 2,000 files; images WebP/JPEG ≤ 1600px. Prefer inline SVG.

SDK reference: `reference/sdk.md`.

## Phase 4 — Validate (required)

- CLI: `npx @waypack/cli validate ./waypack/<slug>` — fix **all errors**; fix warnings unless you have a reason (state it to the user).
- Or MCP `validate_bundle` with the files.
- Optional: `npx @waypack/cli preview ./waypack/<slug>` and check it at phone, iPad and desktop widths.

## Phase 5 — Publish

**If you used a preview** (recommended): when the user is happy with it, push the final files, then call MCP `publish_preview { preview_id }`. It publishes exactly what the preview shows as a trip version (or a new version of the trip it revises). Ask before publishing. The preview link keeps working for later revisions; to revise a published trip later, `push_preview { trip_id }`.

**Without a preview,** upload directly. See `reference/upload.md`. Summary:
- **CLI agents:** `npx @waypack/cli zip ./waypack/<slug> -o bundle.zip` → MCP `create_upload {size_bytes}` → `curl -fsS -X PUT -T bundle.zip "<put_url>"` → MCP `finalize_upload {upload_id}`.
- **Chat agents (no shell):** MCP `upload_bundle_inline` with `files: [{path, content, encoding}]` (utf-8 text, base64 binary; ≤ 4 MB total).
- **Updating** a trip: set `manifest.trip_id` to the existing id (from `list_trips` / the first upload) and upload again → new version. Use `get_trip` to fetch the current manifest first.

Then call `get_trip_status` until `status` is `ready` (map extraction takes ~1–3 min) and tell the user:
> "Open Waypack on your phone and tap **Download** on *<title>* before you lose signal."

If the server returns an entitlement/limit message, relay it verbatim — don't retry in a loop.

## Updating an existing trip

Plans change: "we booked hotel X", "grandma is coming", "the road is closed", "make day 2 lazier", "add a day". Treat every update the same way. Use judgment about what it implies; don't follow a fixed recipe.

1. **Find the trip.** `list_trips` and match the user's words ("our Tahoe trip"). If two could match, ask which.
2. **Start from the latest version.** `get_trip { trip_id }` returns `manifest.json` and `index.html` in full (ask for other files with `paths`; CLI agents can download the whole bundle from `download_url`). Edit these files. Never rebuild the plan from memory or from scratch: the user's earlier choices, notes and research live in them.
3. **Work out everything the change affects**, not just the line it names. For example, a booked hotel becomes the base: the other candidate hotels go (or move to a short "considered" note if useful); routes to and from lodging, drive times, the day's order, meals near the base, check-in/out times, parking, the budget, packing and the emergency section (nearest hospital from the new base) may all change. Research and `geocode`/`compute_route` again where facts changed; keep the theme, tone and everything still true.
4. **Record what the user told you** (confirmation numbers, times, who's coming) in the manifest and page where the plan used to say "to be booked".
5. **Show it.** `push_preview { trip_id, files: [only the changed files], note: "what changed, in one line" }`. The preview starts as a copy of the published version. Give the user the link and a short summary of what changed and anything you couldn't verify.
6. **Publish when they approve:** `publish_preview { preview_id }`. The app shows "Update available"; the offline map is re-cut only if the map area changed.

If the update contradicts the plan (e.g. a hotel far outside the map area), say so and adjust the plan, map area included; don't silently keep both.

## Sharing (only when the user asks)
`share_trip { trip_id }` makes a public, read-only page with a "Plan this trip" button that lets others have their own agent adapt it. Booking/confirmation numbers are masked automatically, but **names, private phone numbers and personal notes are not**. If the plan has any, pass `files` with a cleaned copy (same bundle with those removed). Give the user the `remix_url` to share. `unshare_trip` turns the link off.
