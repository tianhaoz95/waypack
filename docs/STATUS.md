# Build status — 2026-10-03

Milestones from design §14, all built and verified **locally**. No cloud resources exist yet; see DEPLOY.md.

| Milestone | State | Evidence |
|---|---|---|
| **M0** Contract & skill | ✅ Done | Validator 25 tests · CLI 7 · SDK Playwright 4 (offline extract, no external requests, no CSP errors) · Sequoia example validates with 0 warnings |
| **M1** Backend + MCP | ✅ Done locally | `services/mcp/scripts/e2e.mjs`: 44/44 checks: OAuth (DCR, PKCE, email OTP), 11 tools, upload → validate → version → **real PMTiles extract via queue + tiler** → R2, limits, download API, RLS, API tokens, delete |
| **M2** App viewer offline | ✅ iOS verified · Android builds | iOS simulator integration test: UI sign-in, download + SHA-256, loopback server (token, CSP, Range, traversal, Host checks), WebView bridge, native Today |
| **M3** Offline maps | ✅ iOS verified | Native Map renders the trip's offline extract, offline glyphs, routes and icons in the app (screenshot checked). Blue dot: GeolocateControl wired; needs an on-device walk |
| **M4** Payments & limits | ✅ Backend verified · app paywall built | Webhook: annual → expiry → free → lifetime, idempotent (run against local DB). Free-tier limits return a clear upgrade message (e2e). Extract expiry + on-demand re-cut. Store purchase flow needs RevenueCat + store sandbox accounts |
| **M5** Launch assets | ✅ Drafted | `site/` landing (real screenshots) + privacy + terms, `docs/store-listing.md`, attribution screen in app, `docs/DEPLOY.md` |

## Not done / needs you
1. **Real accounts and deployment**: Cloudflare (Workers Paid), Supabase project, ORS key, RevenueCat, Apple/Google consoles, domain. Step-by-step in DEPLOY.md.
2. **Testing with real clients**: Claude Code and claude.ai connector against a deployed (https) server. Locally, OAuth was exercised by a scripted client that follows the MCP auth spec.
3. **Android run**: the APK builds, but the emulator image download failed because the disk filled up (I freed ~5 GB of my own build output). Running the integration test needs ~8 GB free.
4. **Store purchases**: sandbox annual + lifetime via RevenueCat.
5. **Field test**: no-service drive and the blue dot on a walk.
6. **Legal review** of privacy/terms drafts; Apple/Google sign-in provider setup (optional).

## Known limitations
- `flutter_inappwebview` is on 6.2.0-beta.3 (stable fails on AGP 9).
- Dev routing/geocoding uses public OSM demo servers when `ORS_API_KEY` is unset. Not for production.
- Multiple map areas with different `max_zoom` render each archive only up to its own zoom (overzoom is per source).
