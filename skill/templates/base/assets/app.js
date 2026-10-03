/* Waypack base template — renders Today / Plan / Map / Places from manifest.json.
 * The Guide tab is hand-authored HTML in index.html. No network access, no dependencies
 * besides the Waypack SDK (window.Waypack), which may be absent in a plain browser. */
(function () {
  "use strict";

  var W = window.Waypack || null;
  var M = null; // manifest
  var placesById = {};
  var routesById = {};
  var tripMap = null;
  var mapLoading = null;

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var CATS = (W && W.categories) || {
    lodging: { color: "#7c3aed", emoji: "🛏️", label: "Lodging" }, food: { color: "#ea580c", emoji: "🍴", label: "Food" },
    sight: { color: "#0891b2", emoji: "📷", label: "Sight" }, activity: { color: "#16a34a", emoji: "⭐", label: "Activity" },
    trailhead: { color: "#15803d", emoji: "🥾", label: "Trailhead" }, transport: { color: "#2563eb", emoji: "🚌", label: "Transport" },
    fuel: { color: "#ca8a04", emoji: "⛽", label: "Fuel" }, shopping: { color: "#db2777", emoji: "🛒", label: "Shopping" },
    medical: { color: "#dc2626", emoji: "🏥", label: "Medical" }, other: { color: "#64748b", emoji: "📍", label: "Other" }
  };
  var KIND = { travel: "Travel", activity: "Activity", meal: "Meal", lodging: "Lodging", rest: "Rest", reservation: "Reservation", other: "" };

  /** Current date/time in the trip's time zone, as strings comparable with the manifest. */
  function nowInTz(tz) {
    try {
      var parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).formatToParts(new Date());
      var p = {};
      parts.forEach(function (x) { p[x.type] = x.value; });
      return { date: p.year + "-" + p.month + "-" + p.day, time: p.hour + ":" + p.minute };
    } catch (e) {
      var d = new Date();
      return { date: d.toISOString().slice(0, 10), time: d.toTimeString().slice(0, 5) };
    }
  }
  function parseDate(s) { var a = s.split("-"); return new Date(Date.UTC(+a[0], +a[1] - 1, +a[2], 12)); }
  function fmtDate(s, opts) {
    return parseDate(s).toLocaleDateString(undefined, Object.assign({ timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }, opts || {}));
  }
  function fmtTime(t) {
    if (!t) return "";
    var h = +t.slice(0, 2), m = t.slice(3, 5);
    var d = new Date(Date.UTC(2000, 0, 1, h, +m));
    return d.toLocaleTimeString(undefined, { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
  }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function fmtDuration(s) {
    if (!s) return "";
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? h + " h " + (m ? m + " min" : "") : m + " min";
  }
  function fmtDistance(m) {
    if (!m) return "";
    var imperial = /^en-US/.test(navigator.language);
    return imperial ? (m / 1609.34).toFixed(m < 16000 ? 1 : 0) + " mi" : (m / 1000).toFixed(m < 10000 ? 1 : 0) + " km";
  }

  function navButton(placeId, cls) {
    return placeId && placesById[placeId]
      ? '<button class="btn ' + (cls || "small") + '" data-nav="' + esc(placeId) + '">Navigate</button>' : "";
  }
  function mapButton(item) {
    if (item.route_id && routesById[item.route_id]) return '<button class="btn small secondary" data-route="' + esc(item.route_id) + '">Route</button>';
    if (item.place_id && placesById[item.place_id]) return '<button class="btn small secondary" data-show="' + esc(item.place_id) + '">Map</button>';
    return "";
  }

  // ---------- tabs ----------
  var TABS = ["today", "plan", "map", "places", "guide"];
  function showTab(name) {
    if (TABS.indexOf(name) < 0) name = "today";
    $all(".tab").forEach(function (el) { el.hidden = el.getAttribute("data-tab") !== name; });
    $all(".tabbar a").forEach(function (a) {
      if (a.getAttribute("data-go") === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (name === "map") ensureMap();
    window.scrollTo(0, 0);
  }
  function route() {
    var h = (location.hash || "#today").slice(1);
    if (TABS.indexOf(h) >= 0) return showTab(h);
    // Deep link to a guide section, e.g. #g-packing
    var target = h && document.getElementById(h);
    if (target) {
      var tab = target.closest(".tab");
      if (tab) showTab(tab.getAttribute("data-tab"));
      target.scrollIntoView();
    } else showTab("today");
  }

  // ---------- map ----------
  function ensureMap() {
    if (mapLoading) return mapLoading;
    if (!W) {
      $("#map").innerHTML = '<p class="empty">Maps need the Waypack app (or <code>waypack preview</code>).</p>';
      return (mapLoading = Promise.resolve(null));
    }
    mapLoading = W.map("#map", { fit: "bbox" }).then(function (m) { tripMap = m; return m; }).catch(function (e) {
      console.error(e);
      $("#map").innerHTML = '<p class="empty">Map could not load: ' + esc(e.message) + "</p>";
      return null;
    });
    return mapLoading;
  }
  function onMap(fn) {
    location.hash = "#map";
    ensureMap().then(function (m) { if (m) setTimeout(function () { fn(m); }, 50); });
  }

  // ---------- renderers ----------
  function itemHtml(it, state) {
    var p = it.place_id && placesById[it.place_id];
    var r = it.route_id && routesById[it.route_id];
    var meta = [];
    if (r) meta.push([fmtDistance(r.distance_m), fmtDuration(r.duration_s)].filter(Boolean).join(" · "));
    if (p && !r) meta.push(p.name);
    return '<li class="item ' + (state || "") + '">' +
      '<div class="time">' + (it.time ? esc(fmtTime(it.time)) : "—") + (it.end_time ? "<small>" + esc(fmtTime(it.end_time)) + "</small>" : "") + "</div>" +
      "<div>" + (it.kind && KIND[it.kind] ? '<span class="tag">' + esc(KIND[it.kind]) + "</span>" : "") +
      "<h3>" + esc(it.title) + "</h3>" +
      (meta.filter(Boolean).length ? '<p class="meta">' + esc(meta.filter(Boolean).join(" · ")) + "</p>" : "") +
      (it.notes ? "<p>" + esc(it.notes) + "</p>" : "") +
      (r && r.notes ? '<p class="callout">' + esc(r.notes) + "</p>" : "") +
      '<div class="btn-row">' + navButton(it.place_id || (r && r.to)) + mapButton(it) + "</div>" +
      "</div></li>";
  }

  function renderToday() {
    var el = $("#tab-today");
    var now = nowInTz(M.timezone);
    var html = "";
    var days = M.days.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    if (now.date < M.start_date) {
      var n = daysBetween(now.date, M.start_date);
      html += '<article class="card hero"><div class="label">Coming up</div><h2>' + (n === 1 ? "Tomorrow" : n + " days to go") + "</h2>" +
        '<div class="when">' + esc(fmtDate(M.start_date)) + " – " + esc(fmtDate(M.end_date)) + "</div>" +
        (M.summary ? "<p>" + esc(M.summary) + "</p>" : "") + "</article>";
      html += '<article class="card"><h2>Before you go</h2><p>Make sure this trip says <b>Available offline</b> in the Waypack app, and work through the <a href="#g-offline">offline prep checklist</a>.</p></article>';
      if (days[0]) html += '<h2 class="muted" style="padding:0 4px">Day 1 · ' + esc(days[0].title || fmtDate(days[0].date)) + '</h2><ul class="items">' + days[0].items.map(function (it) { return itemHtml(it); }).join("") + "</ul>";
    } else if (now.date > M.end_date) {
      html += '<article class="card hero"><div class="label">Trip complete</div><h2>' + esc(M.title) + '</h2><div class="when">' + esc(fmtDate(M.start_date)) + " – " + esc(fmtDate(M.end_date)) + "</div></article>";
      html += '<p class="empty">Browse the full plan in the <a href="#plan">Plan</a> tab.</p>';
    } else {
      var day = days.filter(function (d) { return d.date === now.date; })[0];
      var dayNum = daysBetween(M.start_date, now.date) + 1;
      if (!day || !day.items.length) {
        html += '<article class="card hero"><div class="label">Day ' + dayNum + '</div><h2>' + esc((day && day.title) || "Free day") + "</h2><p>Nothing scheduled — enjoy it.</p></article>";
      } else {
        var items = day.items;
        var idxNow = -1, idxNext = -1;
        items.forEach(function (it, i) {
          if (!it.time) return;
          var end = it.end_time || (items[i + 1] && items[i + 1].time) || "23:59";
          if (it.time <= now.time && now.time < end) idxNow = i;
          if (idxNext < 0 && it.time > now.time) idxNext = i;
        });
        var focus = idxNow >= 0 ? idxNow : idxNext;
        var f = items[focus];
        if (f) {
          var fp = f.place_id && placesById[f.place_id];
          html += '<article class="card hero"><div class="label">' + (focus === idxNow ? "Now" : "Next up") + " · Day " + dayNum + "</div>" +
            "<h2>" + esc(f.title) + '</h2><div class="when">' + esc(fmtTime(f.time)) + (f.end_time ? " – " + esc(fmtTime(f.end_time)) : "") + (fp ? " · " + esc(fp.name) : "") + "</div>" +
            (f.notes ? "<p>" + esc(f.notes) + "</p>" : "") +
            '<div class="btn-row">' + navButton(f.place_id || (f.route_id && routesById[f.route_id] && routesById[f.route_id].to), "") + "</div></article>";
        } else {
          html += '<article class="card hero"><div class="label">Day ' + dayNum + '</div><h2>All done for today</h2><p>' + esc(day.title || "") + "</p></article>";
        }
        html += '<div class="day-head"><h2>' + esc(day.title || "Today") + '</h2><span class="muted">' + esc(fmtDate(day.date)) + "</span></div>";
        html += '<ul class="items">' + items.map(function (it, i) {
          var st = i === idxNow ? "now" : (it.time && (it.end_time || (items[i + 1] && items[i + 1].time) || "23:59") <= now.time ? "done" : "");
          return itemHtml(it, st);
        }).join("") + "</ul>";
      }
    }
    var lodging = M.places.filter(function (p) { return p.category === "lodging"; });
    if (lodging.length) {
      html += '<article class="card"><h2>Where you\'re staying</h2>' + lodging.map(function (p) {
        return "<p><b>" + esc(p.name) + "</b><br>" + esc(p.address || "") + (p.notes ? '<br><span class="muted">' + esc(p.notes) + "</span>" : "") + '</p><div class="btn-row">' + navButton(p.id) + (p.phone ? '<a class="btn small secondary" href="tel:' + esc(p.phone) + '">Call</a>' : "") + "</div>";
      }).join("") + "</article>";
    }
    html += '<div class="btn-row"><a class="btn secondary" href="#g-safety">Emergency info</a><a class="btn secondary" href="#map">Map</a></div>';
    el.innerHTML = html;
  }

  function renderPlan() {
    var notes = {};
    $all("[data-day-notes]").forEach(function (n) { notes[n.getAttribute("data-day-notes")] = n.innerHTML; });
    var today = nowInTz(M.timezone).date;
    $("#tab-plan").innerHTML = M.days.map(function (d, i) {
      return '<section class="day" id="day-' + esc(d.date) + '"><div class="day-head"><h2>Day ' + (i + 1) + " · " + esc(d.title || "") + "</h2>" +
        '<span class="muted">' + esc(fmtDate(d.date)) + (d.date === today ? " · Today" : "") + "</span></div>" +
        (d.notes ? '<p class="day-notes">' + esc(d.notes) + "</p>" : "") +
        (notes[d.date] ? '<div class="day-notes">' + notes[d.date] + "</div>" : "") +
        '<ul class="items">' + (d.items.length ? d.items.map(function (it) { return itemHtml(it); }).join("") : '<li class="empty">Free time</li>') + "</ul>" +
        '<button class="btn small secondary" data-day-map="' + esc(d.date) + '">Show day ' + (i + 1) + " on map</button></section>";
    }).join("");
  }

  var placeFilter = "all";
  function renderPlaces() {
    var cats = [];
    M.places.forEach(function (p) { if (cats.indexOf(p.category) < 0) cats.push(p.category); });
    var html = '<div class="filters" role="toolbar">' + ["all"].concat(cats).map(function (c) {
      return '<button data-filter="' + esc(c) + '" aria-pressed="' + (c === placeFilter) + '">' + esc(c === "all" ? "All" : (CATS[c] || CATS.other).label) + "</button>";
    }).join("") + "</div>";
    html += M.places.filter(function (p) { return placeFilter === "all" || p.category === placeFilter; }).map(function (p) {
      var c = CATS[p.category] || CATS.other;
      return '<article class="card place" id="place-' + esc(p.id) + '"><div class="dot" style="background:' + c.color + '22" aria-hidden="true">' + c.emoji + "</div><div>" +
        "<h3>" + esc(p.name) + '</h3><div class="meta">' + esc([c.label, p.hours, p.cost].filter(Boolean).join(" · ")) + "</div>" +
        (p.address ? '<div class="meta">' + esc(p.address) + "</div>" : "") +
        (p.notes ? "<p>" + esc(p.notes) + "</p>" : "") +
        (p.links || []).map(function (l) { return '<a href="' + esc(l.url) + '">' + esc(l.label) + " ↗</a> "; }).join("") +
        '<div class="btn-row">' + navButton(p.id) + '<button class="btn small secondary" data-show="' + esc(p.id) + '">Map</button>' +
        (p.phone ? '<a class="btn small secondary" href="tel:' + esc(p.phone) + '">Call</a>' : "") + "</div></div></article>";
    }).join("");
    $("#tab-places").innerHTML = html;
  }

  function renderGuide() {
    var lc = $("#live-checks");
    if (lc) lc.innerHTML = (M.live_checks || []).map(function (l) { return '<a href="' + esc(l.url) + '">' + esc(l.label) + "</a>"; }).join("") || '<p class="muted">No live checks listed.</p>';
    var em = $("#emergency");
    if (em && M.emergency) {
      var e = M.emergency;
      em.innerHTML = (e.numbers || []).map(function (n) {
        return '<div class="emergency-num"><span>' + esc(n.label) + '</span><a href="tel:' + esc(n.value.replace(/[^+\d]/g, "")) + '">' + esc(n.value) + "</a></div>";
      }).join("") + (e.notes ? '<p class="callout">' + esc(e.notes) + "</p>" : "") +
        (e.places || []).map(function (id) {
          var p = placesById[id];
          return p ? "<p><b>" + esc(p.name) + "</b><br>" + esc(p.address || "") + '</p><div class="btn-row">' + navButton(id) + (p.phone ? '<a class="btn small secondary" href="tel:' + esc(p.phone) + '">Call</a>' : "") + "</div>" : "";
        }).join("");
    }
    // Checklists remember ticks on this device.
    $all(".checklist").forEach(function (ul) {
      var key = "wp:" + M.title + ":" + (ul.getAttribute("data-store") || "list");
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { /* storage unavailable */ }
      $all("li", ul).forEach(function (li, i) {
        if (saved[i]) li.classList.add("checked");
        li.setAttribute("role", "checkbox");
        li.setAttribute("aria-checked", String(!!saved[i]));
        li.tabIndex = 0;
        li.addEventListener("click", function () {
          saved[i] = !saved[i];
          li.classList.toggle("checked", saved[i]);
          li.setAttribute("aria-checked", String(saved[i]));
          try { localStorage.setItem(key, JSON.stringify(saved)); } catch (e) { /* ignore */ }
        });
      });
    });
  }

  function renderMapDays() {
    var sel = $("#map-day");
    sel.innerHTML = '<option value="">All days</option>' + M.days.map(function (d, i) {
      return '<option value="' + esc(d.date) + '">Day ' + (i + 1) + " · " + esc(d.title || fmtDate(d.date)) + "</option>";
    }).join("");
    sel.addEventListener("change", function () { ensureMap().then(function (m) { if (m) m.setDay(sel.value || null); }); });
  }

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-nav],[data-show],[data-route],[data-day-map],[data-filter],a[href^='http']");
    if (!t) return;
    if (t.hasAttribute("data-nav")) {
      e.preventDefault();
      var id = t.getAttribute("data-nav");
      if (W) W.openInMaps(id);
      else { var p = placesById[id]; window.open("https://www.google.com/maps/dir/?api=1&destination=" + p.lat + "," + p.lon, "_blank"); }
    } else if (t.hasAttribute("data-show")) {
      var pid = t.getAttribute("data-show");
      onMap(function (m) { m.flyTo(pid, 15); });
    } else if (t.hasAttribute("data-route")) {
      var rid = t.getAttribute("data-route");
      onMap(function (m) { m.highlightRoute(rid); });
    } else if (t.hasAttribute("data-day-map")) {
      var date = t.getAttribute("data-day-map");
      $("#map-day").value = date;
      onMap(function (m) { m.setDay(date); });
    } else if (t.hasAttribute("data-filter")) {
      placeFilter = t.getAttribute("data-filter");
      renderPlaces();
    } else if (W && t.tagName === "A") {
      e.preventDefault();
      W.openExternal(t.href);
    }
  });
  window.addEventListener("hashchange", route);

  function updateNet() {
    var online = W ? W.isOnline() : navigator.onLine;
    $("#net").hidden = online;
  }
  window.addEventListener("online", updateNet);
  window.addEventListener("offline", updateNet);

  // ---------- boot ----------
  var load = W ? W.manifest() : fetch("manifest.json").then(function (r) { return r.json(); });
  load.then(function (m) {
    M = m;
    M.places.forEach(function (p) { placesById[p.id] = p; });
    M.routes.forEach(function (r) { routesById[r.id] = r; });
    document.title = M.title;
    $("#trip-title").textContent = M.title;
    $("#trip-dates").textContent = fmtDate(M.start_date) + " – " + fmtDate(M.end_date, { year: "numeric" });
    renderToday();
    renderPlan();
    renderPlaces();
    renderGuide();
    renderMapDays();
    updateNet();
    route();
    // Keep Today fresh while the app stays open.
    setInterval(function () { if (!$("#tab-today").hidden) renderToday(); }, 60000);
  }).catch(function (e) {
    $("#app").innerHTML = '<p class="empty">Could not load this trip: ' + esc(e.message) + "</p>";
  });
})();
