/* Trip gallery building blocks, shared by /discover (magazine home + search) and /trips/<slug>.
 * Draws everything locally: postcards with a drawn scene, the TRAVELED postmark, a stylised world map
 * (Natural Earth 1:110m land, public domain, /data/land-110m.json) and a route map of a template's stops.
 * No map tiles, no third-party requests. */
(function () {
  "use strict";
  var WG = (window.WG = {});
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  WG.MON = MON;
  WG.MONTHS = MONTHS;
  var esc = (WG.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  });
  WG.cap = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; };
  WG.month = function (c) { return Number(String(c.traveled).slice(5, 7)) || 1; };
  WG.traveled = function (c) { return MON[WG.month(c) - 1] + " " + String(c.traveled).slice(0, 4); };
  WG.facts = function (c) { return c.days + " days · " + MON[WG.month(c) - 1] + " · " + WG.cap(c.pace); };
  WG.crew = function (c) {
    var p = [c.crew.adults + " adult" + (c.crew.adults === 1 ? "" : "s")];
    if (c.crew.kids.length) p.push("kids " + c.crew.kids.join(" & "));
    if (c.crew.pets) p.push("dog");
    return p.join(" · ");
  };
  WG.move = function (c) { return { car: "Car", transit: "Transit", walking: "On foot", bike: "Bike", mixed: "Mixed" }[c.getting_around] || c.getting_around; };
  WG.planned = function (c) { return c.remix_count ? c.remix_count + " planned from it" : "New"; };
  WG.k = function (n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); };

  // ── drawn scene (manifest.theme.scene vocabulary; colours from the trip's accent)
  var uid = 0;
  function mix(a, b, t) {
    var p = function (h) { return [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); };
    var x = p(a), y = p(b);
    return "#" + x.map(function (v, i) { return Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0"); }).join("");
  }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  WG.scene = function (c) {
    var s = c.scene || {}, acc = /^#[0-9a-f]{6}$/i.test(c.accent || "") ? c.accent : "#C2562D";
    var W = 160, H = 100, hz = 66, id = "sg" + uid++;
    var sky = s.sun === "moon" ? ["#C9B6E8", "#FBE1E6"] : s.ground === "snow" ? ["#B9D3EE", "#EEF4FA"] : s.sun === "low-sun" ? ["#F7C59F", "#FBE3C8"] : s.ground === "sand" ? ["#9ED0E6", "#FCE6C9"] : ["#BFD9E8", "#F4EBD3"];
    var g = '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + sky[0] + '"/><stop offset="1" stop-color="' + sky[1] + '"/></linearGradient></defs>';
    g += '<rect width="' + W + '" height="' + H + '" fill="url(#' + id + ')"/>';
    if (s.sun === "sun") g += '<circle cx="122" cy="26" r="17" fill="#FFF3C4" opacity=".35"/><circle cx="122" cy="26" r="11" fill="#FFF3C4"/>';
    if (s.sun === "low-sun") g += '<circle cx="104" cy="' + (hz - 6) + '" r="29" fill="#FFE7C2" opacity=".45"/><circle cx="104" cy="' + (hz - 6) + '" r="20" fill="#FFD9A0"/>';
    if (s.sun === "moon") g += '<circle cx="120" cy="24" r="9" fill="#FFF8E8"/><circle cx="125" cy="21" r="8" fill="' + sky[0] + '"/>';
    var far = mix(acc, sky[1], 0.55);
    if (s.mountains === "rolling") g += '<path d="M0 ' + (hz - 4) + " C30 " + (hz - 22) + " 55 " + (hz - 18) + " 80 " + (hz - 6) + " S130 " + (hz - 26) + " 160 " + (hz - 10) + " V" + H + ' H0Z" fill="' + far + '"/>';
    if (s.mountains === "peaks" || s.mountains === "snowy-peaks") {
      g += '<path d="M-5 ' + hz + " L28 " + (hz - 34) + " L52 " + (hz - 12) + " L82 " + (hz - 44) + " L112 " + (hz - 10) + " L138 " + (hz - 30) + " L170 " + hz + ' Z" fill="' + far + '"/>';
      if (s.mountains === "snowy-peaks") g += '<path d="M82 ' + (hz - 44) + " L74 " + (hz - 33) + " L80 " + (hz - 35) + " L85 " + (hz - 31) + " L91 " + (hz - 34) + "Z M28 " + (hz - 34) + " L21 " + (hz - 25) + " L28 " + (hz - 27) + " L35 " + (hz - 25) + "Z M138 " + (hz - 30) + " L132 " + (hz - 23) + " L139 " + (hz - 24) + " L144 " + (hz - 23) + 'Z" fill="#fff"/>';
    }
    if (s.mountains === "mesas") g += '<path d="M0 ' + hz + " L0 " + (hz - 16) + " L18 " + (hz - 16) + " L24 " + (hz - 30) + " L58 " + (hz - 30) + " L64 " + (hz - 14) + " L100 " + (hz - 14) + " L106 " + (hz - 36) + " L140 " + (hz - 36) + " L146 " + (hz - 18) + " L160 " + (hz - 18) + " L160 " + hz + 'Z" fill="' + far + '"/>';
    if (s.skyline) {
      [[8, 22], [20, 34], [34, 18], [44, 40], [58, 26], [70, 30], [84, 46], [96, 24], [108, 32], [120, 20], [132, 36], [146, 26]].forEach(function (b, i) {
        g += '<rect x="' + b[0] + '" y="' + (hz - b[1]) + '" width="11" height="' + b[1] + '" fill="' + mix(acc, sky[1], 0.35) + '"/>';
        if (i % 2) g += '<rect x="' + (b[0] + 3) + '" y="' + (hz - b[1] + 6) + '" width="2" height="2" fill="#FFE9A8"/>';
      });
    }
    var ground = { snow: "#F4F7FB", grass: mix("#7FA66A", acc, 0.15), sand: "#F2D6A2", rock: "#A79C8E", city: mix(acc, "#E9DCCB", 0.6) }[s.ground] || mix("#7FA66A", acc, 0.15);
    var water = s.water && s.water !== "none";
    if (water) {
      var wc = s.water === "frozen-lake" ? "#DCE9F5" : mix("#5BA4C8", acc, 0.15);
      if (s.water === "river") {
        g += '<path d="M0 ' + hz + " C50 " + (hz - 4) + " 110 " + (hz + 4) + " 160 " + (hz - 2) + " V" + H + ' H0Z" fill="' + ground + '"/>';
        g += '<path d="M60 ' + hz + " C80 " + (hz + 10) + " 40 " + (hz + 20) + " 70 " + H + " L100 " + H + " C70 " + (hz + 20) + " 110 " + (hz + 10) + " 84 " + hz + 'Z" fill="' + wc + '"/>';
      } else {
        g += '<rect y="' + hz + '" width="' + W + '" height="' + (H - hz) + '" fill="' + wc + '"/>';
        g += '<path d="M14 ' + (hz + 8) + " h18 M60 " + (hz + 13) + " h26 M110 " + (hz + 7) + " h20" + '" stroke="#fff" stroke-opacity=".6" stroke-width="1.4" stroke-linecap="round"/>';
        g += '<path d="M0 ' + (H - 12) + " C40 " + (H - 18) + " 90 " + (H - 8) + " 160 " + (H - 15) + " V" + H + ' H0Z" fill="' + ground + '"/>';
      }
    } else {
      g += '<path d="M0 ' + hz + " C50 " + (hz - 4) + " 110 " + (hz + 4) + " 160 " + (hz - 2) + " V" + H + ' H0Z" fill="' + ground + '"/>';
    }
    var snowy = s.ground === "snow";
    var tree = {
      pine: function (x, y, k) { return '<path d="M' + x + " " + (y - 20 * k) + " L" + (x - 7 * k) + " " + y + " H" + (x + 7 * k) + 'Z" fill="' + mix("#2F5D3A", acc, 0.1) + '"/>' + (snowy ? '<path d="M' + x + " " + (y - 20 * k) + " L" + (x - 3 * k) + " " + (y - 12 * k) + " H" + (x + 3 * k) + 'Z" fill="#fff"/>' : ""); },
      sequoia: function (x, y, k) { return '<rect x="' + (x - 1.6 * k) + '" y="' + (y - 14 * k) + '" width="' + 3.2 * k + '" height="' + 14 * k + '" fill="#8A3B22"/><path d="M' + x + " " + (y - 30 * k) + " L" + (x - 6 * k) + " " + (y - 10 * k) + " H" + (x + 6 * k) + 'Z" fill="#2F5D3A"/>' + (snowy ? '<path d="M' + x + " " + (y - 30 * k) + " L" + (x - 2.5 * k) + " " + (y - 22 * k) + " H" + (x + 2.5 * k) + 'Z" fill="#fff"/>' : ""); },
      deciduous: function (x, y, k) { return '<rect x="' + (x - 1) + '" y="' + (y - 8 * k) + '" width="2" height="' + 8 * k + '" fill="#6B4430"/><circle cx="' + x + '" cy="' + (y - 12 * k) + '" r="' + 7 * k + '" fill="#5E8C4E"/>'; },
      autumn: function (x, y, k) { return '<rect x="' + (x - 1) + '" y="' + (y - 8 * k) + '" width="2" height="' + 8 * k + '" fill="#6B4430"/><circle cx="' + x + '" cy="' + (y - 12 * k) + '" r="' + 7 * k + '" fill="' + ["#D9562B", "#E8A33A", "#B8452A"][Math.round(x) % 3] + '"/>'; },
      blossom: function (x, y, k) { return '<rect x="' + (x - 1) + '" y="' + (y - 8 * k) + '" width="2" height="' + 8 * k + '" fill="#6B4430"/><circle cx="' + x + '" cy="' + (y - 12 * k) + '" r="' + 7 * k + '" fill="#F2B5C8"/>'; },
      palm: function (x, y, k) { var t = x + 4 * k, u = y - 20 * k; return '<path d="M' + x + " " + y + " q2 -10 " + 4 * k + " " + -20 * k + '" stroke="#7A5A3A" stroke-width="2" fill="none"/><path d="M' + t + " " + u + " q-10 -2 -14 6 M" + t + " " + u + " q10 -3 13 5 M" + t + " " + u + " q-4 -8 -11 -8 M" + t + " " + u + ' q6 -8 12 -6" stroke="#3E7D4E" stroke-width="2.4" fill="none" stroke-linecap="round"/>'; },
      cactus: function (x, y, k) { return '<path d="M' + x + " " + y + " V" + (y - 16 * k) + " M" + (x - 5 * k) + " " + (y - 6 * k) + " V" + (y - 11 * k) + " H" + x + " M" + (x + 5 * k) + " " + (y - 9 * k) + " V" + (y - 13 * k) + " H" + x + '" stroke="#4E7D4F" stroke-width="' + 3 * k + '" stroke-linecap="round" fill="none"/>'; },
    };
    tree["snowy-pine"] = tree.pine;
    var tf = tree[s.trees];
    if (tf) {
      var spots = water && s.water !== "river" ? [[12, H - 12, 1.1], [26, H - 13, 0.8], [148, H - 13, 1]] : [[14, hz + 6, 1], [28, hz + 10, 1.3], [134, hz + 4, 0.9], [148, hz + 10, 1.2], [118, hz + 8, 0.7]];
      g += spots.map(function (p) { return tf(p[0], p[1], p[2]); }).join("");
    }
    return '<svg class="scene" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + g + "</svg>";
  };

  // ── TRAVELED postmark: the proof the trip happened (its dates passed before it could be shared)
  WG.postmark = function (c, size) {
    size = size || 56;
    var id = "pm" + uid++, col = "#A9583F", m = MON[WG.month(c) - 1].toUpperCase(), y = String(c.traveled).slice(0, 4);
    return '<svg class="postmark" width="' + size + '" height="' + size + '" viewBox="0 0 64 64" role="img" aria-label="Traveled ' + esc(WG.traveled(c)) + '"><defs><path id="' + id + '" d="M32 32 m-22 0 a22 22 0 1 1 44 0 a22 22 0 1 1 -44 0"/></defs><circle cx="32" cy="32" r="29" fill="none" stroke="' + col + '" stroke-width="2.4"/><circle cx="32" cy="32" r="16" fill="none" stroke="' + col + '" stroke-width="1.4"/><text font-size="7.2" font-weight="800" letter-spacing="1.6" fill="' + col + '" font-family="system-ui,sans-serif"><textPath href="#' + id + '">TRAVELED · WAYPACK · TRAVELED ·</textPath></text><text x="32" y="30" text-anchor="middle" font-size="8.5" font-weight="900" fill="' + col + '" font-family="system-ui,sans-serif">' + m + '</text><text x="32" y="40" text-anchor="middle" font-size="8.5" font-weight="900" fill="' + col + '" font-family="system-ui,sans-serif">' + y + "</text></svg>";
  };

  /** A postcard: drawn scene, a stamp with month + length, the postmark. `big` adds "Greetings from". */
  WG.postcard = function (c, opts) {
    opts = opts || {};
    var place = String(c.region || "").split(",")[0];
    return '<div class="pc' + (opts.big ? " big" : "") + '"' + (opts.rot ? ' style="transform:rotate(' + opts.rot + 'deg)"' : "") + '><div class="ph">' + WG.scene(c) +
      '<span class="stamp-m"><i>' + MON[WG.month(c) - 1] + "</i><b>" + c.days + "d</b></span>" +
      '<span class="pm">' + WG.postmark(c, opts.big ? 70 : 44) + "</span>" +
      (opts.big ? '<span class="greet">Greetings from<b>' + esc(place) + "</b></span>" : "") + "</div></div>";
  };

  /** Postcard + caption, linking to the template page. */
  WG.card = function (c, opts) {
    opts = opts || {};
    return '<a class="pcard" href="/trips/' + esc(c.slug) + '" data-slug="' + esc(c.slug) + '">' + WG.postcard(c, { rot: opts.rot }) +
      '<span class="cap"><b>' + esc(c.title) + "</b><small>" + esc(WG.facts(c)) + (opts.planned ? " · " + esc(WG.planned(c)) : "") + "</small></span></a>";
  };

  // ── world map (equirectangular), drawn once into an SVG the search page pans and zooms
  var land = null;
  WG.loadLand = function () {
    if (land) return Promise.resolve(land);
    return fetch("/data/land-110m.json").then(function (r) { return r.json(); }).then(function (j) { land = j.rings; return land; });
  };
  WG.landPath = function () {
    return (land || []).map(function (r) {
      var d = "";
      for (var i = 0; i < r.length; i += 2) d += (i ? "L" : "M") + r[i] + " " + (-r[i + 1]);
      return d + "Z";
    }).join("");
  };

  // ── route map for one template: its stops in a local projection, coloured by day
  var DAYC = ["#D9694F", "#3E7A8C", "#B87810", "#4F8A62", "#8A5BB8", "#C2562D", "#2F7F9E"];
  WG.dayColor = function (i) { return DAYC[i % DAYC.length]; };
  WG.routeMap = function (c, W, H) {
    var pts = [];
    c.plan.forEach(function (d, di) { d.stops.forEach(function (s) { if (typeof s.lat === "number") pts.push({ d: di, lat: s.lat, lon: s.lon, name: s.name }); }); });
    if (pts.length < 2) return "";
    var k = Math.cos((pts[0].lat * Math.PI) / 180);
    var xs = pts.map(function (p) { return p.lon * k; }), ys = pts.map(function (p) { return -p.lat; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var span = Math.max(x1 - x0, (y1 - y0) * (W / H), 0.01), pad = 34;
    var sc = (W - pad * 2) / span, ox = (W - (x1 - x0) * sc) / 2, oy = (H - (y1 - y0) * sc) / 2;
    if ((y1 - y0) * sc > H - pad * 2) { sc = (H - pad * 2) / (y1 - y0); ox = (W - (x1 - x0) * sc) / 2; oy = pad; }
    var P = pts.map(function (p, i) { return [ox + (xs[i] - x0) * sc, oy + (ys[i] - y0) * sc]; });
    var g = '<rect width="' + W + '" height="' + H + '" class="rm-bg"/>';
    for (var gx = 0; gx < W; gx += 40) g += '<path d="M' + gx + " 0V" + H + '" class="rm-grid"/>';
    for (var gy = 0; gy < H; gy += 40) g += '<path d="M0 ' + gy + "H" + W + '" class="rm-grid"/>';
    for (var i = 1; i < P.length; i++) {
      var same = pts[i].d === pts[i - 1].d;
      g += '<path d="M' + P[i - 1][0].toFixed(1) + " " + P[i - 1][1].toFixed(1) + " L" + P[i][0].toFixed(1) + " " + P[i][1].toFixed(1) + '" stroke="' + WG.dayColor(pts[i].d) + '" stroke-width="3" stroke-linecap="round"' + (same ? "" : ' stroke-dasharray="5 5"') + ' fill="none" opacity=".85"/>';
    }
    // Stops at the same spot (lunch at the lodge, then back to the lodge) share one dot.
    var seen = {};
    P.forEach(function (p, i) {
      var key = Math.round(p[0] / 6) + ":" + Math.round(p[1] / 6);
      if (seen[key]) return;
      seen[key] = 1;
      g += '<g><title>' + esc(pts[i].name) + '</title><circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="7.5" fill="' + WG.dayColor(pts[i].d) + '" stroke="#FFFDF8" stroke-width="2"/><text x="' + p[0].toFixed(1) + '" y="' + (p[1] + 3).toFixed(1) + '" text-anchor="middle" font-size="8.5" font-weight="900" fill="#fff" font-family="system-ui,sans-serif">' + (i + 1) + "</text></g>";
    });
    return '<svg class="rmap" viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" aria-label="Map of the stops, coloured by day">' + g + "</svg>";
  };

  /** The prompt "Plan this trip" hands the viewer's agent. */
  WG.prompt = function (c, url, when, who, changes) {
    var lines = [
      "Using Waypack, plan a trip based on the template \"" + c.title + "\": " + url,
      "Start by reading it with get_template, then adapt it for me:",
      "- When: " + (when || "ask me"),
      "- Who's going: " + (who || "ask me"),
    ];
    if (changes) lines.push("- Changes: " + changes);
    lines.push("Follow the travelers' notes, re-check what they flagged for my dates, and send me a live preview link while you work.");
    return lines.join("\n");
  };
})();
