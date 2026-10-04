# Build status — 2026-10-04 (updated: live previews)

Milestones from design §14, all built and verified **locally**. No cloud resources exist yet; see DEPLOY.md.

| Milestone | State | Evidence |
|---|---|---|
| **M0** Contract & skill | ✅ Done | Validator 25 tests · CLI 7 · SDK Playwright 4 (offline extract, no external requests, no CSP errors) · Sequoia example validates with 0 warnings |
| **M1** Backend + MCP | ✅ Done locally | `services/mcp/scripts/e2e.mjs`: 65/65 checks: OAuth (DCR, PKCE), Google/Apple sign-in redirects + callback validation, 11 tools, upload → validate → version → **real PMTiles extract via queue + tiler** → R2, limits, download API, RLS, API tokens, delete |
| **M2** App viewer offline | ✅ iOS verified · Android builds | iOS simulator integration test: UI sign-in, download + SHA-256, loopback server (token, CSP, Range, traversal, Host checks), WebView bridge, native Today |
| **M3** Offline maps | ✅ iOS verified | Native Map renders the trip's offline extract, offline glyphs, routes and icons in the app (screenshot checked). Blue dot: GeolocateControl wired; needs an on-device walk |
| **M4** Payments & limits | ✅ Web billing verified locally | **Stripe on the web portal** (`/account`): Checkout (annual subscription, optional lifetime), Customer Portal, signed + idempotent webhook. e2e: subscription.created → Pro and existing trips get maps; subscription.deleted → Free; lifetime payment → Lifetime; forged signatures rejected. Free-tier limit message links to `/account`. Apps are free viewers (no IAP). Needs Stripe test keys to click through real Checkout |
| **M5** Launch assets | ✅ Drafted | `site/` landing (real screenshots) + **account portal** + privacy + terms, served by the Worker (one deploy), `docs/store-listing.md`, attribution screen in app, `docs/DEPLOY.md` |

## Polish (2026-10-04)
- **Add to calendar** on every plan item: `Waypack.addToCalendar` / `calendarEvents` / `downloadCalendar` in the SDK. In the app, Apple Calendar opens the native event sheet (works offline) and Google opens Google's add-event page. In a browser, Apple downloads an `.ics`. The native Today view has the same buttons. Tests: SDK calendar unit tests (4), Playwright calendar flow, Dart calendar tests (3).
- **Destination and season themes:** `manifest.theme` (9 presets + a composable `scene`) drives the template's palette and illustrated banner; the app tints its native screens with the accent. New example `examples/tahoe-winter` (alpine-winter); Sequoia moved to `winter-forest`.
- **Responsive plans:** phone; iPad two-column (≥ 760px); desktop side rail with the map pinned beside the plan (≥ 1100px). App trips list and Settings adapt to iPad. Validator warns on missing theme, calendar buttons or wide-screen CSS.
- Verified: validator 26 · CLI 7 · SDK 4 + Playwright 6 · MCP 16 · Dart unit 17 · `flutter analyze` clean · all three bundles valid with 0 warnings · screenshot walkthrough on iPhone 16 Plus and iPad (A16) simulators.

## Live previews (2026-10-04)
- MCP `push_preview` / `publish_preview` / `delete_preview` (14 tools now); drafts listed in `list_trips`; `create_upload {preview: true}` for shell agents; portal "Previews" section (Open / Publish / Delete).
- Preview origin (`PREVIEW_URL`) serves drafts with live reload, the SDK and online map tiles; nothing else.
- Verified: `scripts/e2e-preview.mjs` 44/44 (push, merge, delete, isolation, traversal, tiles proxy, publish v1→v2, zip path, portal API), `scripts/e2e-preview-browser.mjs` 11/11 (phone page reloads ~2 s after a push, new days appear, tab and scroll kept, desktop map loads online tiles, no console errors), Worker unit tests 32, original `e2e.mjs` still all green.
- Needs for production: a second domain for previews (DEPLOY.md §2).

## Mac app (2026-10-04)
- The Flutter app now builds for macOS (universal) and passes `integration_test/app_test.dart` on macOS (sign-in, download + SHA-256, local server token/CSP/Range/traversal/Host checks, WebView, Today, offline Map) and the full screenshot walkthrough on this Mac: dev sign-in, download, desktop plan layout (rail + pinned map), native Today, calendar sheet, offline map, Settings.
- `apps/mobile/tool/release_mac.sh`: release build → Developer ID signing (hardened runtime) → signed DMG → optional notarize/staple → optional upload to R2. Verified locally up to a signed 36 MB DMG (with local config) uploaded to the dev bucket and downloaded through `/download/mac`. **Not notarized yet**: there's no production backend to point a real build at.
- Site: "Download for Mac" on the landing page and account page. Worker route tests: 3.
- Fixed along the way: the trip menu overflowed in short windows (also phones in landscape).

## Not done / needs you
0. **Google + Apple sign-in credentials** (DEPLOY.md §1). Locally the redirect chain, callback validation and PKCE exchange code are tested, plus a dev-only sign-in; a real round trip needs your Google Cloud and Apple Developer setup.
1. **Real accounts and deployment**: Cloudflare (Workers Paid), Supabase project, ORS key, Stripe, Apple/Google consoles, domain. Step-by-step in DEPLOY.md.
2. **Testing with real clients**: Claude Code and claude.ai connector against a deployed (https) server. Locally, OAuth was exercised by a scripted client that follows the MCP auth spec.
3. **Android run**: the APK builds, but the emulator image download failed because the disk filled up (I freed ~5 GB of my own build output). Running the integration test needs ~8 GB free.
4. **Stripe test-mode click-through**: real Checkout + Customer Portal with test keys (`stripe listen` forwards webhooks locally).
5. **Field test**: no-service drive and the blue dot on a walk.
6. **Mac release**: first notarized DMG once the backend is deployed (DEPLOY.md §5b). No auto-updater yet.
7. **App icon**: iOS and Android still use Flutter's default icon; the Mac uses an interim mark drawn from the site favicon. A real icon is needed before any store submission.
8. **Legal review** of privacy/terms drafts; Apple/Google sign-in provider setup (optional).

## Known limitations
- `flutter_inappwebview` is on 6.2.0-beta.3 (stable fails on AGP 9).
- Dev routing/geocoding uses public OSM demo servers when `ORS_API_KEY` is unset. Not for production.
- Multiple map areas with different `max_zoom` render each archive only up to its own zoom (overzoom is per source).
