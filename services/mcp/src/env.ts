import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Bucket } from "./lib/bucket.js";

export interface Env {
  // bindings
  OAUTH_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  /** Files (bundles, uploads, previews, shares, releases) in Supabase Storage; attached in index.ts. */
  BUCKET: Bucket;
  /** R2 bucket for the monthly planet mirror (design §6.6). Container mode only; optional. */
  BASEMAP?: R2Bucket;
  TILE_QUEUE: Queue<TileJob>;
  TILER?: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Static site + portal (site/), served by this Worker (Workers static assets). */
  ASSETS?: Fetcher;
  // vars
  PUBLIC_URL: string;
  /** Origin for live previews (agent-written HTML). Must be a different host from PUBLIC_URL; unset = previews off. */
  PREVIEW_URL?: string;
  SUPABASE_URL: string;
  PLANET_URL: string;
  BASEMAP_MAX_ZOOM: string;
  TILER_URL?: string;
  /**
   * Who cuts offline maps. "server" (default): the tiler container, stored with the other files.
   * "device": the app reads the trip's tiles straight from the planet (no container, no queue).
   */
  MAP_EXTRACTS?: "server" | "device";
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
