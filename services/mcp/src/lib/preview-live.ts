// Injected into every preview page (served at /__waypack/preview/live.js on the preview origin).
// Shows a small "Preview" badge and reloads the page when the agent pushes a new revision,
// keeping the reader's place: the URL hash (tab) survives a reload by itself; scroll positions
// of the page and of scrolled panes are saved and restored.
export const LIVE_JS = String.raw`(function () {
  "use strict";
  var me = document.currentScript;
  var rev = Number(me && me.getAttribute("data-rev")) || 0;
  var token = (location.pathname.match(/^\/t\/([^/]+)\//) || [])[1];
  if (!token) return;
  var KEY = "waypack-preview:" + token;
  var stateUrl = "/__waypack/preview/" + token + "/state";
  var info = null;

  // ---- badge (shadow DOM so the plan's CSS can't touch it, and it can't touch the plan)
  var host = document.createElement("div");
  host.setAttribute("data-waypack-preview", "");
  // Top-right corner, collapsed to a dot most of the time: plans can have any layout, so stay small.
  host.style.cssText = "position:fixed;z-index:2147483647;right:calc(env(safe-area-inset-right,0px) + 8px);top:calc(env(safe-area-inset-top,0px) + 8px);pointer-events:none;display:flex;flex-direction:column;align-items:flex-end";
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML =
    "<style>" +
    ".pill{pointer-events:auto;display:flex;align-items:center;gap:0;font:600 12px/1 system-ui,-apple-system,sans-serif;color:#fff;background:rgba(15,23,42,.82);" +
    "backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);box-sizing:border-box;height:26px;padding:0 9px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer;user-select:none;white-space:nowrap;transition:padding .2s}" +
    ".text{display:inline-flex;gap:8px;max-width:0;overflow:hidden;opacity:0;transition:max-width .3s,opacity .2s,margin .3s}" +
    ".open{padding:0 12px}.open .text{max-width:320px;opacity:1;margin-left:8px}" +
    ".dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:p 2s infinite}" +
    ".off .dot{background:#94a3b8;animation:none}.err .dot{background:#f59e0b}" +
    "@keyframes p{70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}" +
    ".muted{opacity:.75;font-weight:500}" +
    ".toast{pointer-events:none;margin-top:8px;width:max-content;font:600 13px/1 system-ui,-apple-system,sans-serif;color:#0f172a;background:#fff;padding:9px 14px;border-radius:10px;" +
    "box-shadow:0 4px 18px rgba(0,0,0,.18);opacity:0;transform:translateY(-4px);transition:opacity .25s,transform .25s}.toast.on{opacity:1;transform:none}" +
    "@media (prefers-reduced-motion:reduce){.dot{animation:none}.toast,.text,.pill{transition:none}}" +
    "</style>" +
    '<div class="pill" title="Live preview: this page updates as your agent works. Not published to the app yet."><span class="dot"></span><span class="text"><span class="label">Preview</span><span class="muted when"></span></span></div>' +
    '<div class="toast" role="status" aria-live="polite"></div>';
  var pill = root.querySelector(".pill"), when = root.querySelector(".when"), label = root.querySelector(".label"), toast = root.querySelector(".toast");
  function mount() { (document.body || document.documentElement).appendChild(host); }
  var pinned = false, closeTimer = null;
  function open(ms) {
    pill.classList.add("open");
    clearTimeout(closeTimer);
    if (!pinned) closeTimer = setTimeout(function () { pill.classList.remove("open"); }, ms || 6000);
  }
  pill.addEventListener("click", function () { pinned = !pinned; if (pinned) open(); else pill.classList.remove("open"); });
  pill.addEventListener("mouseenter", function () { open(); });
  open(6000);
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  function ago(iso) {
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return "updated just now";
    if (s < 3600) return "updated " + Math.round(s / 60) + " min ago";
    if (s < 86400) return "updated " + Math.round(s / 3600) + " h ago";
    return "updated " + Math.round(s / 86400) + " d ago";
  }
  function render() {
    if (!info) return;
    var issues = info.errors ? " · " + info.errors + " issue" + (info.errors === 1 ? "" : "s") : "";
    label.textContent = info.published_version ? "Preview · v" + info.published_version + " published" : "Preview";
    when.textContent = ago(info.updated_at) + issues;
    pill.classList.toggle("err", !!info.errors);
  }
  function say(text) {
    toast.textContent = text;
    toast.className = "toast on";
    open(4000);
    setTimeout(function () { toast.className = "toast"; }, 3200);
  }

  // ---- keep the reader's place across reloads
  function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      var i = 1, s = el;
      while ((s = s.previousElementSibling)) if (s.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      el = el.parentElement;
    }
    return "body > " + parts.join(" > ");
  }
  function savePlace() {
    var panes = [];
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length && panes.length < 20; i++) {
      var el = all[i];
      if ((el.scrollTop > 0 || el.scrollLeft > 0) && el !== host) panes.push([cssPath(el), el.scrollTop, el.scrollLeft]);
    }
    try { sessionStorage.setItem(KEY, JSON.stringify({ x: scrollX, y: scrollY, panes: panes, updated: true })); } catch (e) {}
  }
  function restorePlace() {
    var saved;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) || "null"); sessionStorage.removeItem(KEY); } catch (e) {}
    if (!saved) return;
    if (saved.updated) say("Updated by your agent");
    // The plan renders asynchronously (manifest fetch, map); re-apply for a moment.
    var tries = 0;
    (function apply() {
      window.scrollTo(saved.x, saved.y);
      (saved.panes || []).forEach(function (p) {
        try { var el = document.querySelector(p[0]); if (el) { el.scrollTop = p[1]; el.scrollLeft = p[2]; } } catch (e) {}
      });
      if (++tries < 12) setTimeout(apply, 150);
    })();
  }
  if (document.readyState === "complete") restorePlace(); else addEventListener("load", restorePlace);

  // ---- watch for pushes (only while the tab is visible)
  var timer = null, busy = false;
  function schedule() {
    clearTimeout(timer);
    if (document.visibilityState !== "visible") return;
    // Slow down once the agent has gone quiet for 30 minutes.
    var idle = info && Date.now() - Date.parse(info.updated_at) > 30 * 60 * 1000;
    timer = setTimeout(check, idle ? 15000 : 3000);
  }
  function check() {
    if (busy) return;
    busy = true;
    fetch(stateUrl, { cache: "no-store" })
      .then(function (r) {
        if (r.status === 404) { label.textContent = "Preview expired"; when.textContent = ""; pill.classList.add("off"); open(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (s) {
        if (!s) return;
        pill.classList.remove("off");
        info = s;
        render();
        if (s.rev > rev) { savePlace(); location.reload(); return; }
      })
      .catch(function () { pill.classList.add("off"); when.textContent = "offline"; })
      .then(function () { busy = false; schedule(); });
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") check(); else clearTimeout(timer); });
  setInterval(render, 30000);
  check();
})();
`;
