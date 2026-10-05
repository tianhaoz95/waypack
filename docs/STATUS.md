# Build status — 2026-10-04 (updated: downloadable assistant model on Android)

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

## Assistant: downloadable model for Android phones without Gemini Nano (2026-10-04)
- Qwen3-1.7B (977 MB, int4) on LiteRT-LM: "Download model" (shows the size) on phones without Gemini Nano with ≥ 5.5 GB RAM, e.g. OnePlus Open. Resumable, SHA-256-verified, GPU with CPU fallback (DECISIONS #53).
- Verified: same 14 eval prompts through LiteRT-LM on the Mac's CPU, 10/14 correct, ~14 s per answer; arm64 debug APK builds with the runtime packaged; app unit tests 54 (engine preference + reasons, size via channel). **Not yet run on a phone.**

## Assistant: whole-plan search (2026-10-04)
- The offline assistant now searches the entire plan (every manifest key, known or not, plus the page text); on Apple it calls a `searchPlan` tool itself, on Android the search results are pre-filled.
- Verified: in-app eval against Apple's real model `tool/assistant_eval/run.sh` 14/14 with tool calling (3 runs) and 14/14 with `--no-tools` (2 runs), including questions answered only by keys the app doesn't know; macOS in-app flow 4/4; app unit tests 51.

## Revising a published trip (2026-10-04)
- Tell the agent what changed ("I booked hotel X for the Tahoe trip"); the skill's generic update procedure + `get_trip` (latest files) + `push_preview { trip_id, changed files, note }` + `publish_preview`.
- Verified: `scripts/e2e-revise.mjs` 18/18 (base files, one-file revision → full valid preview, note shown, v2 publish keeps unchanged files, re-base onto a newer version published elsewhere); browser test checks the "Updated: <note>" toast.

## Offline trip assistant (2026-10-04)
- "Ask about this trip" (trip menu, Today): an on-device model answers from the downloaded plan with no signal. Apple Foundation Models (iOS/iPadOS/macOS 26+), Gemini Nano (Android, ML Kit Prompt API); otherwise "not available on this device yet". Engine layer ready for a LiteRT-LM/Qwen engine later.
- Verified: **real answers from Apple's model in the Mac app** (integration test `assistant_flow_test.dart`: what's next, lodge phone, gas, plan B), `tool/assistant_eval/run.sh` 11/11 against the real model, app unit tests 49 (brief building, engine selection, channel protocol), Android APK builds with the Gemini Nano bridge, iOS 18 simulator shows the unsupported screen.
- Not verified: Gemini Nano on a real Android device (no supported device/emulator here); Apple's model in the iOS 26.5 simulator fails inside Apple's own model services on this host (the app now shows a plain message instead of the raw error) — needs a real iPhone with Apple Intelligence.

## Travel companions + offline handoff (2026-10-04)
- Companions: invite links from the app (trip menu → Invite travel companions) or portal (Companions); `/join/<code>` page; companions see and download the trip (owner's maps), can leave; owner can remove them or turn the link off.
- Offline handoff: trip menu → Hand off to a nearby phone (QR + typed fallback); Trips → Receive from a nearby phone (scan or type). Same Wi-Fi or Personal Hotspot; no internet needed.
- Verified: `scripts/e2e-companions.mjs` 29/29; app `test/transfer_test.dart` 9 (real sockets: copy + install, wrong code, forged offer, damaged file, lockout); **cross-device run `tool/handoff_e2e.mjs`: the Mac app sent the Sequoia trip (4.2 MB incl. offline map) to an iPhone simulator signed in as a different user, which installed and opened it**.
- Not verified: QR scanning with a real camera, and two physical phones over a Personal Hotspot (simulators share the Mac's network).

## Public, remixable trips (2026-10-04)
- MCP `share_trip` / `unshare_trip` / `get_shared_trip` (17 tools). Shared trips are frozen, redacted snapshots on the preview origin with a "Plan this trip" button → `/remix/<token>` on the site (prompt builder, "Open in Claude", copy). Portal: Share / public page / copy link / update to latest / stop sharing.
- Verified: `scripts/e2e-shares.mjs` 28/28 (ownership, redaction, isolation, public summary has no owner data, remix via another account, v2 update keeps the link, cleaned-copy sharing, stop + delete kill the link), Worker unit tests 37.

## Live previews (2026-10-04)
- MCP `push_preview` / `publish_preview` / `delete_preview` (14 tools now); drafts listed in `list_trips`; `create_upload {preview: true}` for shell agents; portal "Previews" section (Open / Publish / Delete).
- Preview origin (`PREVIEW_URL`) serves drafts with live reload, the SDK and online map tiles; nothing else.
- Verified: `scripts/e2e-preview.mjs` 44/44 (push, merge, delete, isolation, traversal, tiles proxy, publish v1→v2, zip path, portal API), `scripts/e2e-preview-browser.mjs` 11/11 (phone page reloads ~2 s after a push, new days appear, tab and scroll kept, desktop map loads online tiles, no console errors), Worker unit tests 32, original `e2e.mjs` still all green.
- Needs for production: a second domain for previews (DEPLOY.md §2).

## Mac app (2026-10-04)
- The Flutter app now builds for macOS (universal) and passes `integration_test/app_test.dart` on macOS (sign-in, download + SHA-256, local server token/CSP/Range/traversal/Host checks, WebView, Today, offline Map) and the full screenshot walkthrough on this Mac: dev sign-in, download, desktop plan layout (rail + pinned map), native Today, calendar sheet, offline map, Settings.
- `apps/mobile/tool/release_mac.sh`: release build → Developer ID signing (hardened runtime) → signed DMG → optional notarize/staple → optional GitHub release (`/download/mac` redirects to it). Verified locally up to a signed 36 MB DMG (with local config) uploaded to the dev bucket and downloaded through `/download/mac`. **Not notarized yet**: there's no production backend to point a real build at.
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
