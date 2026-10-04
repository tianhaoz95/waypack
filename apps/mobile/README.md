# Waypack mobile app (Flutter)

Free iOS, Android and macOS viewer for offline trip bundles: sign-in, trips list, resumable download with SHA-256 verification, loopback server + WebView, native Today and Map, reminders. No in-app purchases. Plans are bought on the web (waypack.app/account) and the app only shows the current plan (App Store 3.1.3(f)).

## Run locally
```sh
# from the repo root
npm run build -w @waypack/trip-sdk && node apps/mobile/tool/bundle_sdk.mjs   # packs the SDK into assets/sdk.zip
supabase start                                   # 554xx ports
docker run -d -p 8090:8080 waypack-tiler         # docker build -t waypack-tiler services/tiler
(cd services/mcp && npm run dev)                 # http://127.0.0.1:8787
node services/mcp/scripts/seed-dev.mjs dev@waypack.test   # optional: account with a published trip
cd apps/mobile && flutter run          # or: flutter run -d macos
```
Sign-in is Apple or Google. For local development build with `--dart-define=DEV_SIGN_IN=true` to get a dev sign-in (any email; only works against a local development server).

## Build-time config (`--dart-define`)
| Key | Default | |
|---|---|---|
| `SUPABASE_URL` | `http://127.0.0.1:55421` | Android emulator rewrites 127.0.0.1 → 10.0.2.2 automatically |
| `SUPABASE_ANON_KEY` | local demo key | publishable key in production |
| `API_URL` | `http://127.0.0.1:8787` | the Worker (`https://waypack.app`) |
| `DEV_SIGN_IN` | `false` | dev-only sign-in for local servers and tests |

## Tests
```sh
flutter test test/unit_test.dart                                         # pure logic
flutter test integration_test/app_test.dart -d <device> --dart-define=DEV_SIGN_IN=true --dart-define=NO_PERMISSION_PROMPTS=true
```
Screenshot walkthrough (also a smoke test): `node tool/screenshots.mjs <simulator-udid | macos> <out-dir> [--fake-now …]`. On the Mac it captures only the Waypack window and starts from no downloads.

The integration test checks the sign-in screen offers only Apple/Google, signs in with the dev path, downloads the seeded trip, and checks the local server (token gate, CSP, Range, traversal, DNS-rebinding guard), the WebView, native Today and the offline Map.

## Mac app
Same code, built for macOS 12+ (universal: Apple silicon + Intel). Distributed as a notarized DMG from the site (`/download/mac`), not the Mac App Store. Like the phone apps it's a free viewer with no purchases.

- Differences: Add to calendar → Apple Calendar opens Calendar with an `.ics` (no system "new event" sheet on the Mac), Google opens in the browser. Navigate → Apple Maps (`maps://`) or Google Maps on the web. Apple sign-in uses the web flow (the native sheet is iPhone/iPad only).
- Sandbox entitlements (`macos/Runner/*.entitlements`): network client (API, downloads), network server (the 127.0.0.1 bundle server), location (offline-map blue dot).
- Window: opens at 1280×832 so plans get their desktop layout; remembers its size and position.
- Release: `tool/release_mac.sh --check`, then `SUPABASE_URL=… SUPABASE_ANON_KEY=… API_URL=… tool/release_mac.sh --notarize --upload`. It builds, signs (Developer ID, hardened runtime, frameworks first), makes `build/release/Waypack-<version>.dmg`, notarizes and staples it, and puts it in R2 so `/download/mac` serves it. `--dev --upload-local` makes a local-config build for testing the route with `npm run dev`.
- Don't open a Developer-ID release build on your development Mac casually: macOS ties the sandbox container to the signature, so switching between debug and release builds shows "Waypack differs from previously opened versions… Open Anyway / Don't Open", and the app (or a running `flutter test`) waits until someone answers. Users installing from the DMG never see this.

## Offline assistant
"Ask about this trip" answers questions from the downloaded plan with an on-device model: Apple Foundation Models (iOS/iPadOS/macOS 26+ with Apple Intelligence) or Gemini Nano (Android 8+ with AICore). Elsewhere it explains that it isn't available yet.
- `lib/assistant/engine.dart`: engines + picker (add a LiteRT-LM/Qwen engine to `AssistantEngines.candidates()` later). Native sides: `ios/Runner/WaypackAssistant.swift` (also linked into the macOS target), `android/app/src/main/kotlin/.../WaypackAssistant.kt`.
- `lib/assistant/plan_index.dart`: the whole plan (every manifest key, known or not, plus the page's passages) as a searchable index.
- `lib/assistant/context.dart`: the per-question brief (computed now/next, schedule, GPS distances + search results) that fits a ~4k-token model; Apple's model also gets a `searchPlan` tool.
- Quality check against the real model, inside the app: `tool/assistant_eval/run.sh [--no-tools]` (cases in `cases.json`, which can add keys the app doesn't know; macOS with Apple Intelligence). Run it after changing the brief, the index or the instructions.
- In-app walkthrough: `node tool/screenshots.mjs macos <out> --test integration_test/assistant_flow_test.dart --fake-now 2026-12-24T11:05:00-08:00`.

