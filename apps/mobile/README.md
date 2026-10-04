# Waypack mobile app (Flutter)

Free iOS + Android viewer for offline trip bundles: sign-in, trips list, resumable download with SHA-256 verification, loopback server + WebView, native Today and Map, reminders. No in-app purchases. Plans are bought on the web (waypack.app/account) and the app only shows the current plan (App Store 3.1.3(f)).

## Run locally
```sh
# from the repo root
npm run build -w @waypack/trip-sdk && node apps/mobile/tool/bundle_sdk.mjs   # packs the SDK into assets/sdk.zip
supabase start                                   # 554xx ports
docker run -d -p 8090:8080 waypack-tiler         # docker build -t waypack-tiler services/tiler
(cd services/mcp && npm run dev)                 # http://127.0.0.1:8787
node services/mcp/scripts/seed-dev.mjs dev@waypack.test   # optional: account with a published trip
cd apps/mobile && flutter run
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
The integration test checks the sign-in screen offers only Apple/Google, signs in with the dev path, downloads the seeded trip, and checks the local server (token gate, CSP, Range, traversal, DNS-rebinding guard), the WebView, native Today and the offline Map.
