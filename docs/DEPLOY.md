# Deploying Waypack

Everything runs locally today (see the root README). This is the checklist to go to production. Nothing here has been run against real accounts yet.

## 0. Accounts you need
| Service | Used for | Plan |
|---|---|---|
| Cloudflare | Worker (site + portal + API + MCP), KV, Queues, Containers | **Workers Paid** (Containers + Queues); not needed with device maps (§2a) |
| Supabase | Auth + Postgres + **Storage** (all files: bundles, uploads, previews, shares) | Free (50 MB per file, 1 GB total) → Pro at launch |
| OpenRouteService | `geocode` / `compute_route` | Free key for dogfooding |
| Stripe | Pro subscriptions on the web portal | Standard |
| Apple Developer / Google Play Console | App distribution | — |
| Domain | `waypack.app` (site, portal, API and MCP on one origin; `planet.` for the basemap mirror) | — |

## 1. Supabase
```sh
supabase link --project-ref <ref>
supabase db push                                   # supabase/migrations
```
Dashboard → Authentication → **Sign In / Providers**:
- **Email: turn it off.** Waypack signs in only with Google and Apple.
- **Google** (≈15 min): Google Cloud Console → APIs & Services → OAuth consent screen (External; app name, support email, logo, `waypack.app` as authorized domain; scopes `email`, `profile`, `openid`) → Publish. Credentials → Create OAuth client ID → *Web application* → authorized redirect URI `https://<ref>.supabase.co/auth/v1/callback`. Paste the client ID and secret into Supabase's Google provider. Basic scopes don't need Google's verification review.
- **Apple** (≈30 min, needs the Apple Developer account):
  1. Identifiers → your App ID `com.hejitech.waypack` → enable *Sign in with Apple*.
  2. Identifiers → new **Services ID** (e.g. `com.hejitech.waypack.web`) → enable Sign in with Apple → domain `<ref>.supabase.co`, return URL `https://<ref>.supabase.co/auth/v1/callback`.
  3. Keys → new key with Sign in with Apple → download the `.p8` (Key ID + Team ID).
  4. Supabase Apple provider: **Client IDs** = `com.hejitech.waypack.web,com.hejitech.waypack` (web Services ID + app bundle id for the native iOS sheet); **Secret Key** = a client-secret JWT generated from the `.p8` (Supabase's Apple docs include a generator). **It expires after at most 6 months**: put a calendar reminder to regenerate it. Only web/Android Apple sign-in needs it; the native iPhone sheet doesn't.
- **URL configuration**: Site URL `https://waypack.app`; redirect URLs `https://waypack.app/auth/callback` and `com.hejitech.waypack://login-callback`.

## 2. Cloudflare
**Live setup (2026-10-05):** `env.production` in `services/mcp/wrangler.jsonc` → Worker `waypack` at https://waypack.hejitech.workers.dev (free plan, device maps, no container/queue/R2, previews off; KV auto-provisioned). Cloudflare Workers Builds deploys every push to `main`:
- Build: `npm run build -w @waypack/bundle-schema -w @waypack/trip-sdk`
- Deploy: `cd services/mcp && npm run deploy -- --env production`
- Other branches: `cd services/mcp && npm run upload-version -- --env production` (preview URLs share production data)
- Secrets (`wrangler secret put <name> --env production`): `SUPABASE_SERVICE_ROLE_KEY` (the project's secret key), `SUPABASE_ANON_KEY` (publishable key), `SIGNING_SECRET`.

The original paid-plan checklist (container, R2 mirror, custom domain) follows for when it's needed.

```sh
cd services/mcp
npx wrangler login
npx wrangler kv namespace create OAUTH_KV           # put ids into wrangler.jsonc
npx wrangler kv namespace create CACHE_KV
# Files live in Supabase Storage (bucket "waypack", created by the migrations); no R2 bucket for them.
npx wrangler r2 bucket create waypack-basemap      # container mode's planet mirror only; connect planet.waypack.app (public)
npx wrangler queues create waypack-tiles
npx wrangler queues create waypack-tiles-dlq
```
Edit `wrangler.jsonc`:
- `vars.PUBLIC_URL = "https://waypack.app"`, `vars.SUPABASE_URL = "https://<ref>.supabase.co"`
- `vars.TILER_URL = ""` (use the container binding), `vars.PLANET_URL = "mirror"`, `vars.BASEMAP_PUBLIC_URL = "https://planet.waypack.app"`, `vars.ENVIRONMENT = "production"`
- uncomment `routes` for `waypack.app` (serves the site, `/account`, `/api`, OAuth and `/mcp`)
- **Live previews need a second domain.** Previews are agent-written HTML, so they're served from their own origin with no cookies, API or portal. Register a separate domain (e.g. `waypackpreview.com`, like GitHub's `githubusercontent.com`), add it to `routes`, and set `vars.PREVIEW_URL = "https://waypackpreview.com"`. A subdomain such as `preview.waypack.app` also works (the session cookie is host-only and API writes check `Origin`), but a separate domain keeps previews out of `waypack.app`'s same-site context. Leave `PREVIEW_URL` empty to turn previews off; the Worker refuses a `PREVIEW_URL` on the same host as `PUBLIC_URL`.

Secrets:
```sh
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SIGNING_SECRET          # openssl rand -base64 48
npx wrangler secret put ORS_API_KEY
npx wrangler secret put MIRROR_TOKEN            # openssl rand -hex 32
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID        # R2 API token with write access to waypack-basemap
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put STRIPE_SECRET_KEY       # sk_live_… (sk_test_… for staging)
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_… from the webhook endpoint below
npx wrangler secret put STRIPE_PRICE_ANNUAL     # price_… (recurring, yearly)
npx wrangler secret put STRIPE_PRICE_LIFETIME   # optional price_… (one-time); omit to hide lifetime
npm run deploy                                   # builds the tiler image from services/tiler/Dockerfile too
```
First planet mirror: trigger the monthly cron once (`npx wrangler triggers` / dashboard → "Trigger cron" for `0 4 2 * *`). Until it lands (~1–3 h for ~130 GB), extracts read the public Protomaps build directly. **Check Protomaps' terms before relying on direct reads in production** (design open question 5).

Smoke test against production:
```sh
WAYPACK_URL=https://waypack.app WAYPACK_PREVIEW_URL=https://waypackpreview.com node scripts/e2e-preview.mjs   # dev sign-in only; run against staging
WAYPACK_URL=https://waypack.app SUPABASE_URL=https://<ref>.supabase.co node scripts/e2e.mjs   # dev sign-in is disabled in production: sign in with a real Google/Apple test account and run the agent steps manually
```
Then connect for real: `claude mcp add --transport http waypack https://waypack.app/mcp`, and add it as a claude.ai custom connector (design §6.1 says to test real clients early; MCP Inspector works too).

## 2a. Device maps (no tiler container)
Until there are paying users, run without the container (DECISIONS #54): set `vars.MAP_EXTRACTS = "device"` and remove the `containers` block from `wrangler.jsonc`. Publishing then cuts nothing on the server: `/api/trips/{id}/download` returns `tiles_status: "device"` and `device_tiles: { source, build, areas: [{ area_hash, bbox, max_zoom }] }`, and the app reads just those tiles from the planet with range requests and writes the `.pmtiles` itself (`apps/mobile/lib/services/pmtiles.dart`). Same plan gating as before (Pro gets maps), no map storage in R2, no queue traffic.
- Planet: `PLANET_URL = "latest"` reads build.protomaps.com directly. The Worker pins one build for 30 days (so unchanged areas keep their `area_hash` and aren't re-downloaded) and checks daily that it still answers, moving to the newest build when Protomaps drops it. **Check Protomaps' terms** for direct reads by many devices; the R2 mirror (`PLANET_URL = "mirror"`, needs the container's `/mirror`) is the fix if it becomes a problem.
- Dev: `npx wrangler dev --var MAP_EXTRACTS:device`, then `MAP_EXTRACTS=device node scripts/e2e.mjs` (needs `dart`, runs the app's extractor on the first area).
- Back to the container later: set `MAP_EXTRACTS = "server"`, restore `containers`. Trips get server extracts on their next download (`ensureTripExtracts`).
- Compare against the reference: `dart run tool/pmtiles_extract.dart <planet> <bbox> <z> out.pmtiles` (apps/mobile), then `pmtiles verify out.pmtiles`. Verified tile-for-tile against `pmtiles extract` (go-pmtiles 1.31.2).

## 3. Site + account portal
`site/` is deployed with the Worker (Workers static assets), so `npm run deploy` publishes the landing page and `https://waypack.app/account` too. Replace the beta `mailto:` links with TestFlight / Play links when ready.

## 4. Stripe
- Dashboard → Products: **Waypack Pro** with a yearly recurring price ($14.99) → `STRIPE_PRICE_ANNUAL`; optionally a one-time "Lifetime" price ($39.99) → `STRIPE_PRICE_LIFETIME`.
- Webhook endpoint `https://waypack.app/stripe/webhook`, events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded` → signing secret → `STRIPE_WEBHOOK_SECRET`.
- Customer Portal: enable cancel, update payment method and invoice history; set the return URL to `https://waypack.app/account`.
- Branding, receipts and tax (Stripe Tax) as needed.
- Test (milestone M4): with test keys, subscribe from `/account` using card `4242 4242 4242 4242` → plan shows Pro and existing trips get offline maps; cancel in the portal → back to Free at period end; as a free user, upload a 2nd trip and confirm the agent shows the upgrade link.
- Local: `stripe listen --forward-to 127.0.0.1:8787/stripe/webhook` and put its `whsec_…` in `services/mcp/.dev.vars`.

## 5. Mobile app
```sh
npm run build -w @waypack/trip-sdk && node apps/mobile/tool/bundle_sdk.mjs
cd apps/mobile
flutter build ipa --dart-define=SUPABASE_URL=https://<ref>.supabase.co --dart-define=SUPABASE_ANON_KEY=<publishable> \
  --dart-define=API_URL=https://waypack.app
flutter build appbundle  …same defines…
```
- iOS: team signing in Xcode, bundle id `com.hejitech.waypack`, capability **Sign in with Apple** (already in `Runner.entitlements`). The `local-testflight-setup` skill can script uploads.
- Android: create an upload keystore and a `signingConfigs.release` (currently signs with debug keys).
- The apps are **free with no in-app purchases** (App Store 3.1.3(f) companion app: no purchase buttons or links in the app). Listing copy, privacy labels and review notes: `docs/store-listing.md`. Privacy policy: `https://waypack.app/privacy.html`.

## 5b. Mac app (DMG on the site)
Needs the **Developer ID Application** certificate (in this Mac's keychain) and notary credentials (`FA_ASC_KEY_ID` + `FA_ASC_ISSUER_ID`, already set in `~/.zshrc`, or a `notarytool store-credentials` profile in `WAYPACK_NOTARY_PROFILE`).
```sh
cd apps/mobile
tool/release_mac.sh --check
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<publishable> API_URL=https://waypack.app \
  tool/release_mac.sh --notarize --upload      # → GitHub release mac-v<version> (asset Waypack.dmg); /download/mac redirects to it
```
Needs `gh` logged in with write access to the repo. Bump `version:` in `pubspec.yaml` for each release (the script refuses an existing tag); `/download/mac` always redirects to `releases/latest/download/Waypack.dmg`. There's no auto-updater yet: users re-download from the site.

## 6. Before launch
- [ ] Field test (design §15): drive into a no-service area with only downloaded data; check the blue dot on a walk.
- [ ] Android emulator/device run of `integration_test/app_test.dart` (iOS passes; Android was only build-verified).
- [ ] Rate limits in `lib/geo.ts` tuned to the ORS quota.
- [ ] Legal review of `site/privacy.html` and `site/terms.html` (drafts).
- [ ] Try real Google and Apple sign-in on a device, the portal and the agent sign-in page (locally only the redirects and dev sign-in are tested).
- [ ] Calendar reminder: regenerate the Apple client secret every 6 months.
