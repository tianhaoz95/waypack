# Waypack

Turn any AI agent into a travel planner whose output works **fully offline on your phone**.

An agent (Claude Code, claude.ai, Cursor, …) with the Waypack skill and MCP server interviews you, researches, and publishes a **trip bundle**: a self-contained mobile web app plus `manifest.json`. The backend cuts an **offline vector map** of the trip area. The Waypack app downloads both, so the itinerary, a real map with trails, your GPS dot, and Navigate hand-offs all work in airplane mode.

Design: [`docs/design.md`](docs/design.md) · Deviations: [`docs/DECISIONS.md`](docs/DECISIONS.md) · Deploy: [`docs/DEPLOY.md`](docs/DEPLOY.md) · Status: [`docs/STATUS.md`](docs/STATUS.md)

## Repository
```
apps/mobile/               Flutter app (iOS, Android, macOS), a free viewer: downloads, loopback server, WebView, Today, Map
services/mcp/              Cloudflare Worker: MCP (17 tools, incl. live previews and shared trips) + OAuth 2.1 + uploads/downloads + Stripe billing + tile queue + crons; also serves site/
services/tiler/            Go + pmtiles container: extract trip areas; mirror the planet monthly
supabase/                  Schema + RLS, Google/Apple auth config
packages/bundle-schema/    manifest v1 JSON Schema + validator (CLI, Worker, browser)
packages/trip-sdk/         window.Waypack: MapLibre + PMTiles + offline glyphs, native bridge
packages/cli/              @waypack/cli: validate · zip · preview · init · skill install
skill/                     SKILL.md, references, base template
examples/sequoia-winter/   researched dogfood bundle (real places, routes, NPS info)
site/                      landing page, account portal (Stripe subscribe/manage, trips, tokens), privacy, terms
```

## Run everything locally
Prereqs: Node 20+, Docker, Supabase CLI, Flutter 3.4x, Xcode / Android SDK.
```sh
npm install
npm run build                                        # schema, SDK (fetches fonts/sprites once), CLI
cp supabase/.env.example supabase/.env               # placeholder Google/Apple provider config
supabase start                                       # ports 554xx
docker build -t waypack-tiler services/tiler && docker run -d --name waypack-tiler -p 8090:8080 waypack-tiler
cp services/mcp/.dev.vars.example services/mcp/.dev.vars   # fill keys from `supabase status`
(cd services/mcp && npm run dev)                     # http://127.0.0.1:8787  site · /account portal · /mcp
```
Connect Claude Code to your local server:
```sh
claude mcp add --transport http waypack-dev http://127.0.0.1:8787/mcp
npx waypack skill install            # or: node packages/cli/dist/cli.js skill install
```
Sign-in is Google or Apple only. Locally, use the **dev sign-in** (any email) on the portal or the agent sign-in page; it's only available on a local development server. New accounts are on the free plan. To test offline maps, upgrade one with `node services/mcp/scripts/seed-dev.mjs you@example.com`, which also publishes the Sequoia example. The account portal is at http://127.0.0.1:8787/account. To test Stripe locally, set test keys in `.dev.vars` and run `stripe listen --forward-to 127.0.0.1:8787/stripe/webhook`.

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
| Validator (26) | `npm test -w @waypack/bundle-schema` | ✅ |
| CLI + preview server (7) | `npm test -w @waypack/cli` | ✅ |
| SDK: calendar + maps choice (6) and in a phone browser, offline extract only (6, Playwright) | `npm test -w @waypack/trip-sdk` | ✅ |
| Worker protocol, signing, Stripe, OAuth, Mac downloads, previews, shares (37) | `npm test -w @waypack/mcp` | ✅ |
| **End-to-end backend (65 checks)**: OAuth DCR+PKCE, Google/Apple sign-in redirects + callback checks, all tools, real tile extraction, limits, Stripe webhooks, portal session + CSRF, downloads, RLS, tokens | `node services/mcp/scripts/e2e.mjs` (stack running) | ✅ |
| **Live previews (44 checks)**: push/merge/delete, origin isolation, traversal, tile proxy, publish v1→v2, zip path, portal | `node services/mcp/scripts/e2e-preview.mjs` (stack running) | ✅ |
| **Trip revisions (18 checks)**: latest files as base, one-file revisions, notes, re-base onto newer versions | `node services/mcp/scripts/e2e-revise.mjs` (stack running) | ✅ |
| **Shared trips (28 checks)**: share/redact/remix/update/stop, isolation, no owner data in public views | `node services/mcp/scripts/e2e-shares.mjs` (stack running) | ✅ |
| **Travel companions (29 checks)**: invites, join, download with owner's maps, permissions, leave/remove, link off, trip deleted | `node services/mcp/scripts/e2e-companions.mjs` (stack running) | ✅ |
| **Live preview in a browser (11)**: page reloads itself after a push, keeps tab + scroll, map tiles, no console errors | `node services/mcp/scripts/e2e-preview-browser.mjs` (stack running) | ✅ |
| App unit (49, incl. offline handoff over real sockets and the assistant's trip brief) | `cd apps/mobile && flutter test test/` | ✅ |
| **Offline assistant vs Apple's on-device model** (14 questions incl. unknown plan keys; tool calling and pre-filled modes) | `apps/mobile/tool/assistant_eval/run.sh [--no-tools]` (macOS with Apple Intelligence) | ✅ |
| **Offline handoff, Mac app → iPhone simulator** (different accounts, no server involved) | `node apps/mobile/tool/handoff_e2e.mjs <sim-udid> <out>` | ✅ |
| **App integration on iOS simulator**: sign-in screen (Apple/Google only), dev sign-in, download, local server security, WebView, Today, offline Map | `flutter test integration_test/app_test.dart -d <sim> --dart-define=DEV_SIGN_IN=true --dart-define=NO_PERMISSION_PROMPTS=true` | ✅ |

Map data © OpenStreetMap contributors (ODbL) · Basemap © Protomaps · MapLibre GL JS (BSD-3-Clause).

## License

Source available under the [PolyForm Perimeter License 1.0.1](LICENSE).

- **Permitted**: self-hosting, personal and internal use, contributing back, making changes, and building larger works on top of the software.
- **Prohibited**: using the software to offer a product or service that competes with Waypack as a substitute for it.
