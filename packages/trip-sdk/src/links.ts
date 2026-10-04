import type { LatLon } from "./types.js";

export type MapsApp = "google" | "apple";

/** Web URLs for map hand-off. Both open the native app when installed. */
export function mapsUrl(t: LatLon, app: MapsApp, navigate: boolean): string {
  const ll = `${t.lat},${t.lon}`;
  if (app === "apple") {
    const q = t.label ? `&q=${encodeURIComponent(t.label)}` : "";
    return navigate ? `https://maps.apple.com/?daddr=${ll}${q}` : `https://maps.apple.com/?ll=${ll}${q}`;
  }
  return navigate
    ? `https://www.google.com/maps/dir/?api=1&destination=${ll}`
    : `https://www.google.com/maps/search/?api=1&query=${ll}`;
}

export function chooseApp(pref: "google" | "apple" | "auto" | undefined, manifestPref: unknown, platform: string, hostPref?: MapsApp): MapsApp {
  if (pref === "google" || pref === "apple") return pref;
  if (hostPref) return hostPref;
  if (manifestPref === "google" || manifestPref === "apple") return manifestPref;
  return platform === "ios" || platform === "macos" ? "apple" : "google";
}
