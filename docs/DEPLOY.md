# Deploying Waypack

Everything runs locally today (see the root README). This is the checklist to go to production. Nothing here has been run against real accounts yet.

## 0. Accounts you need
| Service | Used for | Plan |
|---|---|---|
| Cloudflare | Worker (site + portal + API + MCP), R2, KV, Queues, Containers | **Workers Paid** (Containers + Queues) |
| Supabase | Auth + Postgres + Edge Function | Free → Pro at launch |
| OpenRouteService | `geocode` / `compute_route` | Free key for dogfooding |
| Stripe | Pro subscriptions on the web portal | Standard |
| Apple Developer / Google Play Console | App distribution | — |
| Domain | `waypack.app` (site, portal, API and MCP on one origin; `planet.` for the basemap mirror) | — |

## 1. Supabase
```sh
supabase link --project-ref <ref>
supabase db push                                   # supabase/migrations
```
Dashboard → Authentication:
- **Email**: enable, OTP length 6. Paste `supabase/templates/magic_link.html` into the *Magic link* and *Confirm signup* templates (they must contain `{{ .Token }}`). Configure custom SMTP (Resend/Postmark); the built-in sender is rate-limited.
- **URL config**: Site URL `https://waypack.app`; redirect URLs `com.hejitech.waypack://login-callback`.
- **Apple / Google providers** (optional, app only): add credentials, then build the app with `--dart-define=ENABLE_OAUTH_PROVIDERS=true`.

## 2. Cloudflare
```sh
cd services/mcp
npx wrangler login
npx wrangler kv namespace create OAUTH_KV           # put ids into wrangler.jsonc
npx wrangler kv namespace create CACHE_KV
npx wrangler r2 bucket create waypack
npx wrangler r2 bucket create waypack-basemap      # then connect custom domain planet.waypack.app (public)
npx wrangler queues create waypack-tiles
npx wrangler queues create waypack-tiles-dlq
```
Edit `wrangler.jsonc`:
- `vars.PUBLIC_URL = "https://waypack.app"`, `vars.SUPABASE_URL = "https://<ref>.supabase.co"`
- `vars.TILER_URL = ""` (use the container binding), `vars.PLANET_URL = "mirror"`, `vars.BASEMAP_PUBLIC_URL = "https://planet.waypack.app"`, `vars.ENVIRONMENT = "production"`
- uncomment `routes` for `waypack.app` (serves the site, `/account`, `/api`, OAuth and `/mcp`)

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
WAYPACK_URL=https://waypack.app SUPABASE_URL=https://<ref>.supabase.co node scripts/e2e.mjs   # needs a Mailpit-equivalent: run steps manually or use a test inbox
```
Then connect for real: `claude mcp add --transport http waypack https://waypack.app/mcp`, and add it as a claude.ai custom connector (design §6.1 says to test real clients early; MCP Inspector works too).

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
- iOS: team signing in Xcode, bundle id `com.hejitech.waypack`, capabilities: none beyond defaults. The `local-testflight-setup` skill can script uploads.
- Android: create an upload keystore and a `signingConfigs.release` (currently signs with debug keys).
- The apps are **free with no in-app purchases** (App Store 3.1.3(f) companion app: no purchase buttons or links in the app). Listing copy, privacy labels and review notes: `docs/store-listing.md`. Privacy policy: `https://waypack.app/privacy.html`.

## 6. Before launch
- [ ] Field test (design §15): drive into a no-service area with only downloaded data; check the blue dot on a walk.
- [ ] Android emulator/device run of `integration_test/app_test.dart` (iOS passes; Android was only build-verified).
- [ ] Rate limits in `lib/geo.ts` tuned to the ORS quota.
- [ ] Legal review of `site/privacy.html` and `site/terms.html` (drafts).
