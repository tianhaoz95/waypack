# Authoring rules & design guidance

## Layout
```
<slug>/
  manifest.json   # required
  index.html      # required entry point
  assets/         # css, js, images, fonts — all local
```

## Must (validator errors)
- `src`/`href` for `<script>`, `<link>`, `<img>`/`srcset`, `<source>`, `<video>`, `<audio>`, CSS `url()`/`@import`: relative path that exists in the bundle, `data:`/`blob:`, or `/__waypack/sdk/v1/…`.
- No `<iframe>`, `<base>`, `<meta http-equiv=refresh>`, external `<form action>`, or ES module imports from URLs.
- No absolute paths other than the SDK (`/assets/x.css` breaks — write `assets/x.css`).
- No `..`, absolute paths, or symlinks in the zip. ≤ 25 MB zipped, ≤ 2,000 files.

## Runtime CSP (set by the app)
```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
worker-src 'self' blob:; frame-src 'none'; object-src 'none'
```
`fetch()` only works for files inside the bundle. Embed data in `manifest.json` or a local `.json`.

## Should (validator warnings)
- Viewport meta; dark mode via `prefers-color-scheme`.
- Sections for packing, budget, emergency, backup plans; Navigate buttons via `Waypack.openInMaps`.
- `live_checks` and `emergency.numbers` present.
- Add to calendar buttons (`Waypack.addToCalendar` / `data-cal`).
- A wide-screen layout (`@media (min-width: …)`).
- A `theme` in the manifest.

## Design
- **Look like the trip.** Use `manifest.theme` (preset + scene) so a winter Tahoe plan has snow, a blue lake and pines, and a summer desert plan has mesas and warm light. You can restyle further: override CSS variables from `assets/theme.css` in your own stylesheet. Keep contrast high in both light and dark mode.
- **Responsive & screen space.** Design for phone first: use a **collapsible sidebar on the left** (slide-out drawer) opened by the ☰ button in the top bar instead of a persistent bottom navigator/tab bar. A fixed bottom bar consumes 60–80px of vertical screen real estate; collapsing navigation into a left sidebar gives the actual travel plan (itinerary, routes, map, and guide notes) maximum screen height. **The top bar is pre-built** (`<header data-waypack-bar>`, first in `<body>`): you style it and set its title; the SDK adds back and ⋯ (in the app) and ☰ (once you call `Waypack.onMenu(openDrawer)`), pins it to the top with safe-area padding, and keeps it there. **Do not add free-floating or fixed buttons/headers** of your own at the top; set `scroll-padding-top: calc(env(safe-area-inset-top) + 64px)` on `html` so anchor jumps land below the bar. Selecting a section or tapping the backdrop collapses the sidebar back. On iPad (≥ 760px), use two columns for Today/Places/Guide; on desktop (≥ 1100px), hide the top bar and keep the sidebar pinned as a persistent left navigation rail with the map pinned beside the plan. Keep line length readable (max ~75 characters). Never stretch a phone layout to full width.
- Readable at arm's length: body ≥ 16px, high contrast, generous spacing.
- Tap targets ≥ 44px, no hover-only UI. Mobile navigation tucked into a collapsible left sidebar opened from the pre-built top bar, so the full vertical screen height is devoted to the travel plan and nothing covers it.
- "What's next" is immediately accessible (Today view). Times in local 12h/24h per locale.
- Use system fonts (no font downloads); inline SVG icons or emoji.
- Long content in `<details>`; tables only for budgets.
- Checklists can persist ticks with `localStorage` (per device).
- Images: WebP/JPEG ≤ 1600px, ≤ 300 KB each; only when they add real value (e.g. a trail junction photo).
- Never present volatile conditions as fact. Say "verify" and link a live check.
- Write for someone tired, cold and offline: exact names, addresses, confirmation numbers, what to do if X is closed.
