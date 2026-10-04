# Waypack SDK v1 (`window.Waypack`)

Include once, before your own scripts:

```html
<script src="/__waypack/sdk/v1/waypack.js"></script>
```

The app serves it locally (offline); `waypack preview` serves it too. In a plain browser without the SDK, `window.Waypack` is undefined — guard with `if (window.Waypack)`.

```ts
Waypack.version: string
Waypack.manifest(): Promise<Manifest>           // parsed manifest.json (cached)
Waypack.isOnline(): boolean
Waypack.platform(): "ios" | "android" | "macos" | "web"

Waypack.map(container: HTMLElement | string, opts?: {
  places?: string[] | "all";        // default all (or the day's)
  routes?: string[] | "all";
  day?: string;                     // "YYYY-MM-DD": only that day's places/routes
  fit?: "places" | "routes" | "bbox";
  showUserLocation?: boolean;       // default true — GPS blue dot works offline
  interactive?: boolean;            // default true
  style?: "light" | "dark" | "auto";// default auto (follows system)
  onPlaceClick?: (placeId) => void; // default: popup with a Navigate button
}): Promise<TripMap>

TripMap.flyTo(placeId, zoom?)       // pans + opens the popup
TripMap.highlightRoute(routeId|null)// emphasizes one route and fits to it
TripMap.setDay(date|null)           // filter to a day (null = all)
TripMap.destroy()
TripMap.raw                         // maplibregl.Map escape hatch (not semver-stable)

Waypack.openInMaps(placeId | {lat, lon, label?}, { app?: "google"|"apple"|"auto", navigate?: true })
Waypack.addToCalendar(target, { app?: "apple"|"google"|"auto" })
  // target: { date: "YYYY-MM-DD", index }  → that manifest day item
  //      or { date, time?, end_time?, title, location?, notes? }  → a custom event
Waypack.calendarEvents(): Promise<CalEvent[]> // every day item as an event
Waypack.downloadCalendar({ dates?, filename? }) // whole trip (or some dates) as one .ics; browser only

Waypack.openExternal(url)           // system browser
Waypack.share(text)                 // native share sheet

Waypack.categories                  // { lodging: {color, emoji, label}, … } for consistent styling
Waypack.routeModes                  // { driving: {color, dash?, label}, … }
```

## Notes
- **Add to calendar.** In the app, Apple Calendar opens the native "new event" sheet (works offline); on the Mac app it opens Calendar with an `.ics`. Google Calendar opens Google's add-event page (needs signal); on Android it uses the device calendar. In a browser, Apple downloads an `.ics` and Google opens the link. Times are local to `manifest.timezone`. With no `end_time`, the event runs until the next timed item (at most 3 hours), or 1 hour for the day's last item. An item with no `time` becomes an all-day event. The template's `data-cal="<date>|<index>"` buttons already open an Apple/Google chooser.
- The map container needs an explicit height (e.g. `height: 60vh`).
- Basemap: OpenStreetMap vector tiles cut to `map.bbox` (+ `extra_areas`). Outside them the map is blank offline. Attribution is shown automatically — don't hide it.
- Routes are styled by mode (hiking dashed, driving solid); places by category.
- Don't create maps for hidden elements; create on first show (see template `ensureMap`).
- One map per page is plenty; call `destroy()` before creating another in the same container.
