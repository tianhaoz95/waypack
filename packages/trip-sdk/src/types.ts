import type { Manifest } from "@waypack/bundle-schema";
export type { Manifest };

export type LatLon = { lat: number; lon: number; label?: string };

export interface MapOptions {
  /** Place ids to show (default: all, or the day's places when `day` is set). */
  places?: string[] | "all";
  routes?: string[] | "all";
  /** ISO date → show only that day's places/routes. */
  day?: string;
  fit?: "places" | "routes" | "bbox";
  showUserLocation?: boolean;
  interactive?: boolean;
  style?: "light" | "dark" | "auto";
  onPlaceClick?: (placeId: string) => void;
}

export interface TripMap {
  flyTo(placeId: string, zoom?: number): void;
  highlightRoute(routeId: string | null): void;
  setDay(date: string | null): void;
  destroy(): void;
  /** Underlying maplibregl.Map (escape hatch; not covered by semver). */
  raw: unknown;
}

export interface OpenInMapsOptions { app?: "google" | "apple" | "auto"; navigate?: boolean }

export interface WaypackSDK {
  version: string;
  manifest(): Promise<Manifest>;
  isOnline(): boolean;
  platform(): "ios" | "android" | "web";
  map(container: HTMLElement | string, opts?: MapOptions): Promise<TripMap>;
  openInMaps(target: string | LatLon, opts?: OpenInMapsOptions): void;
  openExternal(url: string): void;
  share(text: string): void;
  /** Additive helpers (v1.x). */
  categories: Record<string, { color: string; emoji: string; label: string }>;
  routeModes: Record<string, { color: string; dash?: number[]; label: string }>;
}

/** Host info. In-app the native shell injects `window.__WAYPACK_HOST__` before page scripts run. */
export interface HostInfo {
  platform: "ios" | "android" | "web";
  /** Base URL for tile index; default `/__waypack/tiles/`. */
  tilesBase?: string;
  /** Preferred maps app if the user set one natively. */
  navApp?: "google" | "apple";
}

export interface TilesIndex {
  extracts: { url: string; bbox?: [number, number, number, number]; max_zoom?: number }[];
  /** Optional online fallback archive/TileJSON for previews and free tier. */
  online?: string | null;
}
