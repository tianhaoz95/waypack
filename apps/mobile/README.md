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
Sign-in codes for local accounts land in Mailpit: http://127.0.0.1:55424

## Build-time config (`--dart-define`)
| Key | Default | |
|---|---|---|
| `SUPABASE_URL` | `http://127.0.0.1:55421` | Android emulator rewrites 127.0.0.1 → 10.0.2.2 automatically |
| `SUPABASE_ANON_KEY` | local demo key | publishable key in production |
| `API_URL` | `http://127.0.0.1:8787` | the Worker (`https://waypack.app`) |
| `ENABLE_OAUTH_PROVIDERS` | `false` | shows Apple/Google sign-in once configured in Supabase |

## Tests
```sh
flutter test test/unit_test.dart                                         # pure logic
flutter test integration_test/app_test.dart -d <device> --dart-define=NO_LOCATION_PROMPT=true
```
The integration test signs in via the real UI (code read from Mailpit), downloads the seeded trip, and checks the local server (token gate, CSP, Range, traversal, DNS-rebinding guard), the WebView, native Today and the offline Map.
