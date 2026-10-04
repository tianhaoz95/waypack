export type BBox = [number, number, number, number];

export type PlaceCategory =
  | "lodging" | "food" | "sight" | "activity" | "trailhead"
  | "transport" | "fuel" | "shopping" | "medical" | "other";

export type RouteMode = "driving" | "walking" | "hiking" | "cycling" | "transit" | "ferry" | "flight";

export interface Link { label: string; url: string }

export interface Place {
  id: string;
  name: string;
  category: PlaceCategory;
  lat: number;
  lon: number;
  address?: string;
  phone?: string;
  notes?: string;
  hours?: string;
  cost?: string;
  links?: Link[];
}

export type Position = [number, number] | [number, number, number];
export type RouteGeometry =
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] };

export interface Route {
  id: string;
  name: string;
  mode: RouteMode;
  from?: string;
  to?: string;
  distance_m?: number;
  duration_s?: number;
  geometry: RouteGeometry;
  notes?: string;
}

export interface DayItem {
  time?: string;
  end_time?: string;
  title: string;
  place_id?: string;
  route_id?: string;
  kind?: "travel" | "activity" | "meal" | "lodging" | "rest" | "reservation" | "other";
  notes?: string;
}

export interface Day { date: string; title?: string; notes?: string; items: DayItem[] }

export interface MapArea { bbox: BBox; max_zoom?: number; label?: string }

export interface Manifest {
  schema_version: 1;
  sdk_version: string;
  trip_id?: string | null;
  title: string;
  summary?: string;
  timezone: string;
  start_date: string;
  end_date: string;
  travelers?: { adults?: number; children?: { age: number }[]; pets?: object[]; notes?: string };
  map: { bbox: BBox; max_zoom?: number; extra_areas?: MapArea[] };
  places: Place[];
  routes: Route[];
  days: Day[];
  live_checks?: Link[];
  emergency?: { numbers?: { label: string; value: string }[]; notes?: string; places?: string[] };
  offline_notes?: string;
  nav_app?: "google" | "apple";
  theme?: ManifestTheme;
  [k: string]: unknown;
}

export interface ManifestTheme {
  preset?: string;
  accent?: string;
  accent_dark?: string;
  mood?: string;
  scene?: {
    sky?: string;
    sun?: "sun" | "low-sun" | "moon" | "none";
    mountains?: "none" | "rolling" | "peaks" | "snowy-peaks" | "mesas";
    water?: "none" | "lake" | "frozen-lake" | "ocean" | "river";
    trees?: "none" | "pine" | "snowy-pine" | "sequoia" | "palm" | "deciduous" | "autumn" | "blossom" | "cactus";
    ground?: "snow" | "grass" | "sand" | "rock" | "city";
    particles?: "none" | "snow" | "leaves" | "petals" | "stars" | "rain";
    skyline?: boolean;
  };
}

export interface Issue {
  /** JSON-pointer-ish location, e.g. `places[3].lat` or `index.html`. */
  path: string;
  message: string;
  /** Actionable fix suggestion for agents. */
  hint?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  manifest?: Manifest;
  stats?: { files: number; bytes: number; zipped_bytes?: number };
}

/** A file in a bundle. `data` is raw bytes. */
export interface BundleFile { path: string; data: Uint8Array }

/** Shape accepted by MCP `validate_bundle` / `upload_bundle_inline`. */
export interface InlineFile { path: string; content: string; encoding?: "utf-8" | "utf8" | "base64" }
