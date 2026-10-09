// The trip's one top bar. The page owns its look and title (`<header data-waypack-bar>`); the SDK owns
// its place and its controls, so nothing native ever floats over trip content:
//   [‹ back] [☰ sections] … page content (title, badges) … [⋯ trip menu]
// Back and ⋯ exist only in the Waypack app (they call the native shell). ☰ appears once the page
// registers its section menu with Waypack.onMenu(). No bar in the page → the SDK adds a plain one.
import { callNative, host } from "./host.js";

const ICONS = {
  back: '<path d="M15 5 8 12l7 7"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
};

// Layout-critical rules are !important (and doubled-up selectors win specificity) so page styles can
// restyle the bar but can't move it off the top, float it over content, or hide its controls.
// Cosmetics use custom properties pages may override: --wp-bar-btn-bg, --wp-bar-btn-fg.
export const BAR_CSS = `
[data-waypack-bar] { display: flex; align-items: center; gap: 8px; box-sizing: border-box; min-height: 52px;
  padding: calc(env(safe-area-inset-top) + 6px) 12px 8px; }
[data-waypack-bar][data-waypack-bar] { position: sticky !important; top: 0 !important; bottom: auto !important;
  transform: none !important; z-index: 25; }
html[data-waypack-app] [data-waypack-bar][data-waypack-bar] { display: flex !important; visibility: visible !important; opacity: 1 !important; }
.wp-bar-lead, .wp-bar-trail { display: flex !important; align-items: center; gap: 6px; flex: none; }
.wp-bar-trail { margin-left: auto; }
.wp-bar-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 1.05rem; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wp-bar-btn { box-sizing: border-box; width: 40px; height: 40px; min-width: 40px; margin: 0; padding: 0; border: 0;
  border-radius: 12px; display: inline-grid !important; place-items: center; cursor: pointer; font: inherit;
  color: var(--wp-bar-btn-fg, inherit); background: var(--wp-bar-btn-bg, color-mix(in srgb, currentColor 9%, transparent));
  -webkit-tap-highlight-color: transparent; }
.wp-bar-btn[hidden] { display: none !important; }
.wp-bar-btn:active { background: color-mix(in srgb, currentColor 18%, transparent); }
.wp-bar-btn:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.wp-bar-btn svg { width: 22px; height: 22px; }
@media print { [data-waypack-bar][data-waypack-bar] { display: none !important; } }
`;

let menuHandler: (() => void) | null = null;
let menuButton: HTMLButtonElement | null = null;

/** Registers (or clears) the page's section menu; the ☰ button is shown only while one is set. */
export function setMenu(fn: (() => void) | null): void {
  menuHandler = typeof fn === "function" ? fn : null;
  syncMenu();
}

function syncMenu() {
  if (menuButton) menuButton.hidden = !menuHandler;
}

function button(kind: keyof typeof ICONS, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `wp-bar-btn wp-bar-${kind}`;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg>`;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Finds the page's bar: the declared one, else a legacy template `.topbar`, else a new plain bar. */
function findOrCreateBar(title: () => Promise<string>): HTMLElement {
  const declared = document.querySelector<HTMLElement>("[data-waypack-bar]") ?? document.querySelector<HTMLElement>(".topbar");
  if (declared) return declared;
  const bar = document.createElement("header");
  const h = document.createElement("h1");
  h.className = "wp-bar-title";
  h.textContent = document.title || "Trip";
  bar.appendChild(h);
  // Neutral look that follows the page's light/dark scheme; pages that care declare their own bar.
  bar.style.cssText = "background:Canvas;color:CanvasText;border-bottom:1px solid color-mix(in srgb, CanvasText 12%, transparent)";
  void title().then((t) => t && (h.textContent = t)).catch(() => undefined);
  return bar;
}

export function mountBar(title: () => Promise<string>): void {
  const root = document.documentElement;
  if (root.hasAttribute("data-waypack-no-bar")) return;
  // The shell injects __WAYPACK_HOST__ before any page script, unlike the JS bridge object, which may
  // still be on its way when the SDK runs in <head>.
  const app = host().platform !== "web";
  if (app) root.setAttribute("data-waypack-app", "");

  if (!document.getElementById("waypack-bar-css")) {
    const style = document.createElement("style");
    style.id = "waypack-bar-css";
    style.textContent = BAR_CSS;
    // First in <head>, so the page's own (cosmetic) bar styles come later and win.
    (document.head ?? root).prepend(style);
  }

  const run = () => {
    if (!document.body || root.hasAttribute("data-waypack-no-bar")) return;
    const bar = findOrCreateBar(title);
    bar.setAttribute("data-waypack-bar", "");
    // Always the first thing on the page, so the sticky bar sits above all content, never over it.
    if (document.body.firstElementChild !== bar) document.body.prepend(bar);
    if (bar.querySelector(".wp-bar-lead")) return; // already mounted

    const lead = document.createElement("div");
    lead.className = "wp-bar-lead";
    if (app) lead.appendChild(button("back", "Back to trips", () => void callNative("waypackBack", {})));
    // Trips made from the older template ship their own ☰ toggle: keep it (and its listeners).
    const legacyToggle = bar.querySelector<HTMLElement>(".nav-toggle");
    if (legacyToggle) lead.appendChild(legacyToggle);
    else {
      menuButton = button("menu", "Open menu", () => menuHandler?.());
      menuButton.setAttribute("aria-expanded", "false");
      lead.appendChild(menuButton);
      syncMenu();
    }
    bar.prepend(lead);

    if (app) {
      const trail = document.createElement("div");
      trail.className = "wp-bar-trail";
      trail.appendChild(button("more", "Trip menu", () => void callNative("waypackMenu", {})));
      bar.appendChild(trail);
      signalReady();
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}

/** Tells the shell the bar is up (so it doesn't show its fallback button). Retries once the bridge is ready. */
function signalReady() {
  const send = () => {
    try {
      void window.flutter_inappwebview?.callHandler("waypackBar", { ready: true })?.catch?.(() => undefined);
    } catch {
      /* bridge not ready yet */
    }
  };
  send();
  window.addEventListener("flutterInAppWebViewPlatformReady", send, { once: true });
}

/** The ☰ button, so pages can mirror their drawer state into aria-expanded. */
export function menuButtonElement(): HTMLButtonElement | null {
  return menuButton;
}
