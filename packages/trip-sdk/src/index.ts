import type { Manifest } from "@waypack/bundle-schema";
import { callNative, host } from "./host.js";
import { chooseApp, mapsUrl } from "./links.js";
import { createMap } from "./map.js";
import { categories, routeModes } from "./theme.js";
import type { LatLon, MapOptions, OpenInMapsOptions, WaypackSDK } from "./types.js";

declare const __SDK_VERSION__: string;

let manifestPromise: Promise<Manifest> | null = null;
function manifest(): Promise<Manifest> {
  manifestPromise ??= fetch(new URL("manifest.json", location.href).href, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
    return r.json() as Promise<Manifest>;
  });
  manifestPromise.catch(() => (manifestPromise = null));
  return manifestPromise;
}

function openWeb(url: string) {
  const w = window.open(url, "_blank", "noopener");
  if (!w) location.href = url;
}

async function resolveTarget(target: string | LatLon): Promise<LatLon | null> {
  if (typeof target !== "string") return target;
  const m = await manifest();
  const p = m.places.find((x) => x.id === target);
  if (!p) {
    console.warn(`[waypack] openInMaps: unknown place id "${target}"`);
    return null;
  }
  return { lat: p.lat, lon: p.lon, label: p.name };
}

const Waypack: WaypackSDK = {
  version: __SDK_VERSION__,
  manifest,
  isOnline: () => navigator.onLine,
  platform: () => host().platform,

  async map(container, opts: MapOptions = {}) {
    const m = await manifest();
    return createMap(container, opts, { manifest: m, openInMaps: (id) => Waypack.openInMaps(id) });
  },

  openInMaps(target, opts: OpenInMapsOptions = {}) {
    void (async () => {
      const t = await resolveTarget(target);
      if (!t) return;
      const m = await manifest().catch(() => null);
      const app = chooseApp(opts.app, m?.nav_app, host().platform, host().navApp);
      const navigate = opts.navigate !== false;
      const url = mapsUrl(t, app, navigate);
      if (!(await callNative("openInMaps", { lat: t.lat, lon: t.lon, label: t.label ?? null, app, navigate, url }))) openWeb(url);
    })();
  },

  openExternal(url) {
    void callNative("openExternal", { url }).then((ok) => ok || openWeb(url));
  },

  share(text) {
    void callNative("share", { text }).then(async (ok) => {
      if (ok) return;
      if (navigator.share) return navigator.share({ text }).catch(() => undefined);
      await navigator.clipboard?.writeText(text).catch(() => undefined);
      alert("Copied to clipboard");
    });
  },

  categories,
  routeModes,
};

(window as unknown as { Waypack: WaypackSDK }).Waypack = Waypack;
export default Waypack;
