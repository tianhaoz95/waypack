# Build status (2026-10-03)

## Done (M0, committed and verified)
- `packages/bundle-schema`: schema, validator, zip safety (25 tests passing)
- `packages/trip-sdk`: window.Waypack, MapLibre 6 + PMTiles, offline glyphs/sprites (checked in a headless phone browser)
- `packages/cli`: validate / zip / preview / init
- `skill/`: SKILL.md, references, base template
- `examples/sequoia-winter`: researched bundle, validates clean

## In progress (M1, written but NOT yet compiled or tested)
- `supabase/`: migration applied locally (ports 554xx, so it doesn't clash with the other local project)
- `services/mcp`: Worker with OAuth (email OTP), stateless MCP JSON-RPC, all 11 tools, upload/download, tile queue consumer
  - Next: fix tsconfig types (`wrangler types` didn't emit worker-configuration.d.ts), typecheck, add tests, run `wrangler dev`, test end to end

## Not started
- `services/tiler` (Go + pmtiles Dockerfile)
- Supabase edge function `revenuecat-webhook`
- `apps/mobile` (Flutter, M2/M3)
- M4 paywall/limits wiring in the app
- M5 site, privacy policy, store copy
- `docs/DEPLOY.md`
