import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  // bindings
  OAUTH_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  BUCKET: R2Bucket;
  TILE_QUEUE: Queue<TileJob>;
  TILER?: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  // vars
  PUBLIC_URL: string;
  SUPABASE_URL: string;
  PLANET_URL: string;
  BASEMAP_MAX_ZOOM: string;
  TILER_URL?: string;
  ONLINE_TILES_URL?: string;
  ENVIRONMENT: string;
  // secrets
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  SIGNING_SECRET: string;
  ORS_API_KEY?: string;
}

export interface TileJob { extract_id: string }

/** Props stored on the OAuth grant (and synthesized for API tokens). */
export interface AuthProps { userId: string; email?: string; via: "oauth" | "api_token" | "supabase" }
