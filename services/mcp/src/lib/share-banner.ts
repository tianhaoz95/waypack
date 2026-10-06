// Injected into shared trips (served at /__waypack/share.js on the preview origin): a small
// "Plan this trip" button that opens the remix page on the main site (data-remix).
export const SHARE_JS = String.raw`(function () {
  "use strict";
  var me = document.currentScript;
  var remix = me && me.getAttribute("data-remix");
  if (!remix || !/^https?:\/\//.test(remix)) return;
  var host = document.createElement("div");
  host.setAttribute("data-waypack-share", "");
  host.style.cssText = "position:fixed;z-index:2147483647;right:calc(env(safe-area-inset-right,0px) + 8px);top:calc(env(safe-area-inset-top,0px) + 8px)";
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML =
    "<style>" +
    "a{display:flex;align-items:center;gap:8px;box-sizing:border-box;height:32px;padding:0 12px;border-radius:999px;text-decoration:none;white-space:nowrap;" +
    "font:600 13px/1 system-ui,-apple-system,sans-serif;color:var(--accent-ink,#fff);background:var(--accent,#1d6fe0);box-shadow:0 2px 12px rgba(0,0,0,.22);border:1px solid color-mix(in srgb,var(--accent-ink,#fff) 18%,transparent);transition:transform .15s ease,box-shadow .15s ease}" +
    "a:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,.28)}" +
    "a:focus-visible{outline:3px solid var(--accent,#93c5fd);outline-offset:2px}" +
    ".more{max-width:0;overflow:hidden;opacity:.85;font-weight:500;transition:max-width .4s,opacity .3s}" +
    ".open .more{max-width:260px}" +
    "@media (prefers-reduced-motion:reduce){.more,a{transition:none}}" +
    "</style>" +
    '<a target="_blank" rel="noopener"><span class="more">Made with Waypack ·</span><span class="cta">Plan this trip</span><span aria-hidden="true">→</span></a>';
  var a = root.querySelector("a");
  a.href = remix;
  a.title = "Plan this trip for your own dates with your AI agent";
  a.className = "open";
  setTimeout(function () { a.className = ""; }, 6000);
  a.addEventListener("mouseenter", function () { a.className = "open"; });
  a.addEventListener("mouseleave", function () { a.className = ""; });
  function mount() { document.body.appendChild(host); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
`;
