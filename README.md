# Waypack

Turn any AI agent into a travel planner whose output works **fully offline on your phone**.

An agent (Claude Code, claude.ai, Cursor, …) with the Waypack skill and MCP server interviews you, researches, and publishes a **trip bundle**: a self-contained mobile web app plus `manifest.json`. The backend cuts an **offline vector map** of the trip area. The Waypack app downloads both, so the itinerary, a real map with trails, your GPS dot, and Navigate hand-offs all work in airplane mode.

Design: [`docs/design.md`](docs/design.md) · Deviations: [`docs/DECISIONS.md`](docs/DECISIONS.md) · Deploy: [`docs/DEPLOY.md`](docs/DEPLOY.md) · Status: [`docs/STATUS.md`](docs/STATUS.md)

## Repository
```
apps/mobile/               Flutter app (iOS + Android): downloads, loopback server, WebView, Today, Map, paywall
services/mcp/              Cloudflare Worker: MCP (11 tools) + OAuth 2.1 + uploads/downloads + tile queue + crons
services/tiler/            Go + pmtiles container: extract trip areas; mirror the planet monthly
supabase/                  Schema + RLS, OTP email template, revenuecat-webhook edge function
packages/bundle-schema/    manifest v1 JSON Schema + validator (CLI, Worker, browser)
packages/trip-sdk/         window.Waypack: MapLibre + PMTiles + offline glyphs, native bridge
packages/cli/              @waypack/cli: validate · zip · preview · init · skill install
skill/                     SKILL.md, references, base template
examples/sequoia-winter/   researched dogfood bundle (real places, routes, NPS info)
site/                      landing page, privacy, terms
```

## Run everything locally
Prereqs: Node 20+, Docker, Supabase CLI, Flutter 3.4x, Xcode / Android SDK.
```sh
npm install
npm run build                                        # schema, SDK (fetches fonts/sprites once), CLI
supabase start                                       # ports 554xx; emails → Mailpit http://127.0.0.1:55424
docker build -t waypack-tiler services/tiler && docker run -d --name waypack-tiler -p 8090:8080 waypack-tiler
cp services/mcp/.dev.vars.example services/mcp/.dev.vars   # fill keys from `supabase status`
(cd services/mcp && npm run dev)                     # http://127.0.0.1:8787  (MCP at /mcp)
```
Connect Claude Code to your local server:
```sh
claude mcp add --transport http waypack-dev http://127.0.0.1:8787/mcp
npx waypack skill install            # or: node packages/cli/dist/cli.js skill install
```
Sign in with any email; the code shows up in Mailpit. New accounts are on the free plan. To test offline maps, upgrade one with `node services/mcp/scripts/seed-dev.mjs you@example.com`, which also publishes the Sequoia example.

The app: see [`apps/mobile/README.md`](apps/mobile/README.md).

## Work on bundles without the backend
```sh
node packages/cli/dist/cli.js init ./waypack/my-trip
node packages/cli/dist/cli.js preview ./waypack/my-trip     # phone-sized preview with real CSP + map tiles
node packages/cli/dist/cli.js validate ./waypack/my-trip
```

## Tests
| What | Command | Result |
|---|---|---|
| Validator (25) | `npm test -w @waypack/bundle-schema` | ✅ |
| CLI + preview server (7) | `npm test -w @waypack/cli` | ✅ |
| SDK in a phone browser, offline extract only (4, Playwright) | `npm test -w @waypack/trip-sdk` | ✅ |
| Worker protocol + signing (6) | `npm test -w @waypack/mcp` | ✅ |
| RevenueCat logic (6) | `npx vitest run supabase/functions` | ✅ |
| **End-to-end backend (44 checks)**: OAuth DCR+PKCE+OTP, all tools, real tile extraction, limits, downloads, RLS, tokens | `node services/mcp/scripts/e2e.mjs` (stack running) | ✅ |
| App unit (14) | `cd apps/mobile && flutter test test/unit_test.dart` | ✅ |
| **App integration on iOS simulator**: UI sign-in, download, local server security, WebView, Today, offline Map | `flutter test integration_test/app_test.dart -d <sim> --dart-define=NO_LOCATION_PROMPT=true` | ✅ |

Map data © OpenStreetMap contributors (ODbL) · Basemap © Protomaps · MapLibre GL JS (BSD-3-Clause).
