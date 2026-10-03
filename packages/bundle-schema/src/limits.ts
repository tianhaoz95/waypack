export const SCHEMA_VERSION = 1;
export const SDK_MAJOR = "1";
export const SDK_PATH_PREFIX = "/__waypack/sdk/v1/";
export const SDK_SCRIPT_PATH = "/__waypack/sdk/v1/waypack.js";

export const LIMITS = {
  maxZippedBytes: 25 * 1024 * 1024,
  maxUnzippedBytes: 100 * 1024 * 1024,
  maxFiles: 2000,
  maxInlineBytes: 4 * 1024 * 1024,
  maxAreaKm2: 40_000,
  maxAreas: 4,
  maxRouteCoords: 5000,
  minZoom: 10,
  maxZoom: 16,
  defaultMaxZoom: 15,
  maxImageBytesWarn: 1_500_000,
} as const;
