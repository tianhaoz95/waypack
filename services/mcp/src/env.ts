import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  // bindings
  OAUTH_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  BUCKET: R2Bucket;
  /** Public bucket holding the monthly basemap planet mirror (design §6.6). Optional in dev. */
  BASEMAP?: R2Bucket;
  TILE_QUEUE: Queue<TileJob>;
  TILER?: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Static site + portal (site/), served by this Worker (Workers static assets). */
  ASSETS?: Fetcher;
  // vars
  PUBLIC_URL: string;
  SUPABASE_URL: string;
  PLANET_URL: string;
  BASEMAP_MAX_ZOOM: string;
  TILER_URL?: string;
  ONLINE_TILES_URL?: string;
  ENVIRONMENT: string;
  /** Public base URL of the BASEMAP bucket (custom domain), e.g. https://planet.waypack.app */
  BASEMAP_PUBLIC_URL?: string;
  // secrets
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  SIGNING_SECRET: string;
  ORS_API_KEY?: string;
  /** Stripe (web portal billing). Unset → billing endpoints answer 503. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ANNUAL?: string;
  STRIPE_PRICE_LIFETIME?: string;
  /** Shared with the tiler container for POST /mirror, plus R2 S3 credentials for rclone. */
  MIRROR_TOKEN?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export interface TileJob { extract_id: string }

/** Props stored on the OAuth grant (and synthesized for API tokens). */
export interface AuthProps { userId: string; email?: string; via: "oauth" | "api_token" | "supabase" }
