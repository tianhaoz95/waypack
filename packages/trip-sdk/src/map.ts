import type * as GeoJSONNS from "geojson";
import * as maplibregl from "maplibre-gl";
import { layers as basemapLayers, namedFlavor, language_script_pairs } from "@protomaps/basemaps";
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css";
import type { Manifest, Place, Route } from "@waypack/bundle-schema";
import { sdkBase } from "./host.js";
import { resolveTiles, type TileSourceInfo } from "./tiles.js";
import { categories, routeModes } from "./theme.js";
import type { MapOptions, TripMap } from "./types.js";

const SDK_CSS = `
.wp-map{position:relative}
.wp-banner{position:absolute;left:8px;right:8px;top:8px;z-index:2;padding:8px 12px;border-radius:10px;font:13px/1.35 system-ui,sans-serif;background:rgba(255,255,255,.94);color:#334155;box-shadow:0 1px 4px rgba(0,0,0,.2)}
.wp-popup{font:14px/1.4 system-ui,sans-serif;min-width:160px;max-width:240px;color:#0f172a}
.wp-popup b{display:block;font-size:15px;margin-bottom:2px}
.wp-popup small{color:#64748b;display:block;margin-bottom:6px}
.wp-popup button{appearance:none;border:0;border-radius:10px;background:#2563eb;color:#fff;font:600 14px system-ui,sans-serif;min-height:40px;padding:8px 14px;width:100%;cursor:pointer}
.maplibregl-popup-content{border-radius:12px;padding:12px}
.maplibregl-ctrl-attrib{font-size:11px}
@media (prefers-color-scheme: dark){.wp-banner{background:rgba(30,41,59,.94);color:#e2e8f0}}
`;

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement("style");
  s.textContent = maplibreCss + SDK_CSS;
  document.head.appendChild(s);
}

type Flavor = "light" | "dark";
const prefersDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

function pickLang(): string {
  const want = (document.documentElement.lang || navigator.language || "en").slice(0, 2).toLowerCase();
  return language_script_pairs.some((p) => p.lang === want) ? want : "en";
}

function makeIcon(category: string, ratio = 2): ImageData {
  const c = categories[category] ?? categories.other;
  const size = 30 * ratio;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2 * ratio, 0, Math.PI * 2);
  ctx.fillStyle = c.color;
  ctx.fill();
  ctx.lineWidth = 2.5 * ratio;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.font = `${15 * ratio}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(c.emoji, size / 2, size / 2 + ratio);
  return ctx.getImageData(0, 0, size, size);
}

function placeFeatures(places: Place[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: places.map((p) => ({
      type: "Feature",
      id: undefined,
      properties: { id: p.id, name: p.name, category: categories[p.category] ? p.category : "other" },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  };
}

function routeFeatures(routes: Route[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: routes.map((r) => ({
      type: "Feature",
      properties: { id: r.id, name: r.name, mode: r.mode },
      geometry: r.geometry as GeoJSON.Geometry,
    })),
  };
}

function buildStyle(tiles: TileSourceInfo, flavor: Flavor): maplibregl.StyleSpecification {
  const f = namedFlavor(flavor);
  const style: maplibregl.StyleSpecification = {
    version: 8,
    glyphs: `${sdkBase}assets/fonts/{fontstack}/{range}.pbf`,
    sprite: new URL(`assets/sprites/v4/${flavor}`, sdkBase).href,
    sources: {
      "wp-places": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      "wp-routes": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [],
  };
  if (tiles.source) {
    style.sources.protomaps = tiles.source;
    style.layers.push(...(basemapLayers("protomaps", f, { lang: pickLang() }) as maplibregl.LayerSpecification[]));
  } else {
    style.layers.push({ id: "background", type: "background", paint: { "background-color": f.background } });
  }

  const casing = flavor === "dark" ? "#0f172a" : "#ffffff";
  style.layers.push({
    id: "wp-route-casing",
    type: "line",
    source: "wp-routes",
    filter: ["!=", ["get", "mode"], "flight"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": casing, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5, 15, 9], "line-opacity": 0.85 },
  });
  for (const [mode, s] of Object.entries(routeModes)) {
    style.layers.push({
      id: `wp-route-${mode}`,
      type: "line",
      source: "wp-routes",
      filter: ["==", ["get", "mode"], mode],
      layout: { "line-cap": s.dash ? "butt" : "round", "line-join": "round" },
      paint: {
        "line-color": s.color,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 15, 5.5],
        "line-opacity": 0.95,
        ...(s.dash ? { "line-dasharray": s.dash } : {}),
      },
    });
  }
  style.layers.push({
    id: "wp-places",
    type: "symbol",
    source: "wp-places",
    layout: {
      "icon-image": ["concat", "wp-", ["get", "category"]],
      "icon-size": 1,
      "icon-allow-overlap": true,
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Medium"],
      "text-size": 12.5,
      "text-offset": [0, 1.35],
      "text-anchor": "top",
      "text-optional": true,
      "text-max-width": 9,
    },
    paint: {
      "text-color": flavor === "dark" ? "#f1f5f9" : "#0f172a",
      "text-halo-color": flavor === "dark" ? "#0f172a" : "#ffffff",
      "text-halo-width": 1.6,
    },
  });
  return style;
}

export interface MapDeps {
  manifest: Manifest;
  openInMaps(placeId: string): void;
}

export async function createMap(containerArg: HTMLElement | string, opts: MapOptions, deps: MapDeps): Promise<TripMap> {
  injectCss();
  const container = typeof containerArg === "string" ? document.querySelector<HTMLElement>(containerArg) : containerArg;
  if (!container) throw new Error(`Waypack.map: container ${String(containerArg)} not found`);
  container.classList.add("wp-map");
  const m = deps.manifest;
  const placesById = new Map(m.places.map((p) => [p.id, p]));
  const routesById = new Map(m.routes.map((r) => [r.id, r]));

  const tiles = await resolveTiles();
  const flavorFor = (): Flavor => (opts.style === "dark" ? "dark" : opts.style === "light" ? "light" : prefersDark() ? "dark" : "light");
  let flavor = flavorFor();

  let map: maplibregl.Map;
  try {
    map = new maplibregl.Map({
      container,
      style: buildStyle(tiles, flavor),
      bounds: m.map.bbox as [number, number, number, number],
      fitBoundsOptions: { padding: 24 },
      maxZoom: Math.min(20, tiles.maxZoom + 3),
      interactive: opts.interactive !== false,
      attributionControl: { compact: false },
      cooperativeGestures: false,
      // Labels for CJK scripts are drawn with local fonts, so they work offline without glyph PBFs.
      localIdeographFontFamily: "'Hiragino Sans','Noto Sans CJK SC','PingFang SC',sans-serif",
    });
  } catch (e) {
    container.innerHTML = `<div class="wp-banner">Map unavailable on this device (${(e as Error).message}).</div>`;
    throw e;
  }

  map.setMissingStyleImageResolver((id) => {
    if (id.startsWith("wp-") && !map.hasImage(id)) map.addImage(id, makeIcon(id.slice(3)), { pixelRatio: 2 });
  });

  if (opts.interactive !== false) {
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: /^en-US/.test(navigator.language) ? "imperial" : "metric" }), "bottom-left");
  }
  let geolocate: maplibregl.GeolocateControl | null = null;
  if (opts.showUserLocation !== false) {
    geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 15000 },
      trackUserLocation: true,
      showAccuracyCircle: true,
    });
    map.addControl(geolocate, "top-right");
  }

  if (!tiles.source) {
    const b = document.createElement("div");
    b.className = "wp-banner";
    b.textContent = navigator.onLine
      ? "Basemap not available for this trip yet. Places and routes are shown without a background map."
      : "Offline map not downloaded for this trip — places and routes are shown without a background map.";
    container.appendChild(b);
  }

  // --- data selection ---
  let currentDay: string | null = opts.day ?? null;
  let highlighted: string | null = null;

  function selection() {
    let placeIds: Set<string>;
    let routeIds: Set<string>;
    if (currentDay) {
      const d = m.days.find((x) => x.date === currentDay);
      placeIds = new Set();
      routeIds = new Set();
      for (const it of d?.items ?? []) {
        if (it.place_id) placeIds.add(it.place_id);
        if (it.route_id) {
          routeIds.add(it.route_id);
          const r = routesById.get(it.route_id);
          if (r?.from) placeIds.add(r.from);
          if (r?.to) placeIds.add(r.to);
        }
      }
    } else {
      placeIds = new Set(m.places.map((p) => p.id));
      routeIds = new Set(m.routes.map((r) => r.id));
    }
    if (Array.isArray(opts.places)) placeIds = currentDay ? new Set(opts.places.filter((id) => placeIds.has(id))) : new Set(opts.places);
    if (Array.isArray(opts.routes)) routeIds = currentDay ? new Set(opts.routes.filter((id) => routeIds.has(id))) : new Set(opts.routes);
    return {
      places: [...placeIds].map((id) => placesById.get(id)).filter((p): p is Place => !!p),
      routes: [...routeIds].map((id) => routesById.get(id)).filter((r): r is Route => !!r),
    };
  }

  function applyData() {
    const sel = selection();
    (map.getSource("wp-places") as maplibregl.GeoJSONSource | undefined)?.setData(placeFeatures(sel.places));
    (map.getSource("wp-routes") as maplibregl.GeoJSONSource | undefined)?.setData(routeFeatures(sel.routes));
    applyHighlight();
    return sel;
  }

  function applyHighlight() {
    for (const mode of Object.keys(routeModes)) {
      const id = `wp-route-${mode}`;
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "line-opacity", highlighted ? ["case", ["==", ["get", "id"], highlighted], 1, 0.3] : 0.95);
      map.setPaintProperty(id, "line-width", highlighted
        ? ["case", ["==", ["get", "id"], highlighted], ["interpolate", ["linear"], ["zoom"], 8, 5, 15, 8], ["interpolate", ["linear"], ["zoom"], 8, 3, 15, 5.5]]
        : ["interpolate", ["linear"], ["zoom"], 8, 3, 15, 5.5]);
    }
  }

  function fit(sel: ReturnType<typeof selection>, how: MapOptions["fit"], animate = false) {
    const b = new maplibregl.LngLatBounds();
    const addRoute = (r: Route) => {
      const lines = r.geometry.type === "LineString" ? [r.geometry.coordinates] : r.geometry.coordinates;
      for (const l of lines) for (const c of l) b.extend([c[0], c[1]]);
    };
    if (how === "bbox") {
      const [a, c, d, e] = m.map.bbox;
      b.extend([a, c]).extend([d, e]);
    } else {
      if (how !== "routes" || !sel.routes.length) sel.places.forEach((p) => b.extend([p.lon, p.lat]));
      if (how === "routes" || !sel.places.length) sel.routes.forEach(addRoute);
      if (b.isEmpty()) { const [a, c, d, e] = m.map.bbox; b.extend([a, c]).extend([d, e]); }
    }
    map.fitBounds(b, { padding: { top: 56, bottom: 40, left: 40, right: 56 }, maxZoom: 14, animate });
  }

  function showPopup(p: Place) {
    const el = document.createElement("div");
    el.className = "wp-popup";
    const t = document.createElement("b");
    t.textContent = p.name;
    const s = document.createElement("small");
    s.textContent = [categories[p.category]?.label, p.hours].filter(Boolean).join(" · ");
    const btn = document.createElement("button");
    btn.textContent = "Navigate";
    btn.addEventListener("click", () => deps.openInMaps(p.id));
    el.append(t, s, btn);
    new maplibregl.Popup({ offset: 16, maxWidth: "260px" }).setLngLat([p.lon, p.lat]).setDOMContent(el).addTo(map);
  }

  map.on("click", "wp-places", (e) => {
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const p = id ? placesById.get(id) : undefined;
    if (!p) return;
    if (opts.onPlaceClick) opts.onPlaceClick(p.id);
    else showPopup(p);
  });
  map.on("mouseenter", "wp-places", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "wp-places", () => (map.getCanvas().style.cursor = ""));

  // Follow system dark mode when style is auto.
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onScheme = () => {
    const next = flavorFor();
    if (next === flavor) return;
    flavor = next;
    map.setStyle(buildStyle(tiles, flavor), { diff: false });
    map.once("styledata", () => applyData());
  };
  if (opts.style === "auto" || !opts.style) mq?.addEventListener?.("change", onScheme);

  await new Promise<void>((resolve) => (map.loaded() ? resolve() : map.once("load", () => resolve())));
  const sel = applyData();
  fit(sel, opts.fit ?? (currentDay ? "places" : "bbox"));

  return {
    raw: map,
    flyTo(placeId: string, zoom = 15) {
      const p = placesById.get(placeId);
      if (!p) return;
      map.flyTo({ center: [p.lon, p.lat], zoom: Math.min(zoom, tiles.maxZoom + 2), essential: true });
      if (!opts.onPlaceClick) map.once("moveend", () => showPopup(p));
    },
    highlightRoute(routeId: string | null) {
      highlighted = routeId;
      applyHighlight();
      const r = routeId ? routesById.get(routeId) : null;
      if (r) fit({ places: [], routes: [r] }, "routes", true);
    },
    setDay(date: string | null) {
      currentDay = date;
      fit(applyData(), "places", true);
    },
    destroy() {
      mq?.removeEventListener?.("change", onScheme);
      map.remove();
    },
  };
}
