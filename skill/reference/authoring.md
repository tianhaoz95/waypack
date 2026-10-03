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

## Design
- Readable at arm's length: body ≥ 16px, high contrast, generous spacing.
- One-handed: primary actions at the bottom, tap targets ≥ 44px, no hover-only UI.
- "What's next" is one tap away (Today tab). Times in local 12h/24h per locale.
- Use system fonts (no font downloads); inline SVG icons or emoji.
- Long content in `<details>`; tables only for budgets.
- Checklists can persist ticks with `localStorage` (per device).
- Images: WebP/JPEG ≤ 1600px, ≤ 300 KB each; only when they add real value (e.g. a trail junction photo).
- Never present volatile conditions as fact. Say "verify" and link a live check.
- Write for someone tired, cold and offline: exact names, addresses, confirmation numbers, what to do if X is closed.
