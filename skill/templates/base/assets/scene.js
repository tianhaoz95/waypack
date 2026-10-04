/* Waypack scene illustrator: draws the header landscape for a trip from manifest.theme.
 * Layers: sky → sun/moon → mountains → water → trees → ground → particles.
 * Colours come from CSS variables in theme.css, so presets and dark mode restyle it for free.
 *   window.WaypackScene.render(containerEl, manifest.theme, seedString)
 * Agents may replace the header with their own inline SVG instead; this is a starting point. */
(function () {
  "use strict";

  var PRESETS = {
    "alpine-winter": { sun: "sun", mountains: "snowy-peaks", water: "frozen-lake", trees: "snowy-pine", ground: "snow", particles: "snow" },
    "winter-forest": { sun: "low-sun", mountains: "snowy-peaks", water: "none", trees: "sequoia", ground: "snow", particles: "snow" },
    "lake-summer": { sun: "sun", mountains: "peaks", water: "lake", trees: "pine", ground: "grass", particles: "none" },
    "coast": { sun: "sun", mountains: "rolling", water: "ocean", trees: "none", ground: "sand", particles: "none" },
    "tropical": { sun: "sun", mountains: "rolling", water: "ocean", trees: "palm", ground: "sand", particles: "none" },
    "desert": { sun: "low-sun", mountains: "mesas", water: "none", trees: "cactus", ground: "sand", particles: "none" },
    "autumn": { sun: "low-sun", mountains: "rolling", water: "lake", trees: "autumn", ground: "grass", particles: "leaves" },
    "spring-blossom": { sun: "sun", mountains: "rolling", water: "river", trees: "blossom", ground: "grass", particles: "petals" },
    "city": { sun: "low-sun", mountains: "none", water: "river", trees: "deciduous", ground: "city", particles: "none", skyline: true },
    "default": { sun: "sun", mountains: "rolling", water: "none", trees: "deciduous", ground: "grass", particles: "none" }
  };

  function resolve(theme) {
    theme = theme || {};
    var base = PRESETS[theme.preset] || PRESETS["default"];
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(theme.scene || {}).forEach(function (k) { out[k] = theme.scene[k]; });
    return out;
  }

  // Small seeded PRNG so each trip gets its own (stable) landscape.
  function rng(seedStr) {
    var h = 2166136261;
    for (var i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () {
      h += 0x6D2B79F5;
      var t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var W = 1200, H = 300;
  var f = function (n) { return Math.round(n * 10) / 10; };
  var fill = function (v, extra) { return ' style="fill:var(' + v + ')' + (extra ? ";" + extra : "") + '"'; };

  function sky() {
    return '<defs><linearGradient id="wp-sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--sky-1)"/><stop offset="1" style="stop-color:var(--sky-2)"/></linearGradient>' +
      '<linearGradient id="wp-water" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--water)"/><stop offset="1" style="stop-color:var(--water-hi)"/></linearGradient></defs>' +
      '<rect width="' + W + '" height="' + H + '" fill="url(#wp-sky)"/>';
  }

  function sun(kind, r) {
    if (kind === "none") return "";
    var y = kind === "low-sun" ? 150 : 72, x = 940 + r() * 120;
    return '<g class="scene-sun"><circle cx="' + f(x) + '" cy="' + y + '" r="62"' + fill("--sun", "opacity:.25") + '/>' +
      '<circle cx="' + f(x) + '" cy="' + y + '" r="36"' + fill("--sun") + "/></g>";
  }

  function stars(r) {
    var s = '<g class="scene-stars">';
    for (var i = 0; i < 40; i++) s += '<circle cx="' + f(r() * W) + '" cy="' + f(r() * 140) + '" r="' + f(0.6 + r() * 1.2) + '"' + fill("--particle") + "/>";
    return s + "</g>";
  }

  function mountains(kind, r) {
    if (kind === "none") return "";
    var base = 215, out = "";
    if (kind === "rolling") {
      [[0.55, "--far", 150], [0.75, "--near", 178]].forEach(function (layer) {
        var d = "M0 " + base, x = 0;
        while (x < W) {
          var w = 180 + r() * 220, h = layer[2] - r() * 40;
          d += " Q" + f(x + w / 2) + " " + f(h) + " " + f(x + w) + " " + base;
          x += w;
        }
        out += '<path d="' + d + " L" + W + " " + H + " L0 " + H + 'Z"' + fill(layer[1]) + "/>";
      });
      return out;
    }
    if (kind === "mesas") {
      var x = -40;
      var d = "M-40 " + base;
      while (x < W + 40) {
        var w = 120 + r() * 200, top = 120 + r() * 50, slope = 25 + r() * 20;
        d += " L" + f(x + slope) + " " + f(top) + " L" + f(x + w - slope) + " " + f(top) + " L" + f(x + w) + " " + base;
        x += w + r() * 80;
        d += " L" + f(x) + " " + base;
      }
      return '<path d="' + d + " L" + (W + 40) + " " + H + " L-40 " + H + 'Z"' + fill("--far") + "/>";
    }
    // peaks / snowy-peaks: two ranges, far and near
    [["--far", 70, 0.9], ["--near", 120, 0.6]].forEach(function (layer, li) {
      var pts = [[-60, base]], x = -60;
      while (x < W + 60) {
        var w = 110 + r() * 160;
        var peakY = layer[1] + r() * 70 * layer[2];
        pts.push([x + w / 2, peakY]);
        pts.push([x + w, base - 20 - r() * 40]);
        x += w;
      }
      pts.push([W + 60, base]);
      var d = "M" + pts.map(function (p) { return f(p[0]) + " " + f(p[1]); }).join(" L") + " L" + (W + 60) + " " + H + " L-60 " + H + "Z";
      out += '<path d="' + d + '"' + fill(layer[0]) + "/>";
      if (kind === "snowy-peaks") {
        for (var i = 1; i < pts.length - 1; i += 2) {
          var L = pts[i - 1], P = pts[i], R = pts[i + 1], t = li === 0 ? 0.38 : 0.3;
          var lx = P[0] + (L[0] - P[0]) * t, ly = P[1] + (L[1] - P[1]) * t;
          var rx = P[0] + (R[0] - P[0]) * t, ry = P[1] + (R[1] - P[1]) * t;
          var mx = (lx + rx) / 2, my = Math.max(ly, ry) - 4;
          out += '<path d="M' + f(P[0]) + " " + f(P[1]) + " L" + f(rx) + " " + f(ry) + " L" + f(mx + (rx - mx) * 0.4) + " " + f(my - 6) +
            " L" + f(mx) + " " + f(my + 4) + " L" + f(mx - (mx - lx) * 0.45) + " " + f(my - 8) + " L" + f(lx) + " " + f(ly) + 'Z"' + fill("--far-snow", "opacity:" + (li === 0 ? 0.95 : 0.85)) + "/>";
        }
      }
    });
    return out;
  }

  function water(kind, r) {
    if (kind === "none") return "";
    if (kind === "ocean") {
      var s = '<rect x="0" y="198" width="' + W + '" height="' + (H - 198) + '" fill="url(#wp-water)"/>';
      for (var i = 0; i < 5; i++) {
        var y = 212 + i * 16, d = "M0 " + y;
        for (var x = 0; x < W; x += 60) d += " q15 -5 30 0 t30 0";
        s += '<path d="' + d + '" fill="none" stroke-width="2"' + ' style="stroke:var(--water-hi);opacity:' + (0.55 - i * 0.08) + '"/>';
      }
      return s;
    }
    if (kind === "river") {
      return '<path d="M-20 236 C 250 214, 420 262, 640 236 S 1000 210, 1220 232 L1220 262 C 1000 240, 820 286, 600 262 S 260 244, -20 266 Z" fill="url(#wp-water)"/>';
    }
    var s2 = '<path d="M-20 206 C 300 200, 900 200, 1220 206 L1220 252 L-20 252 Z" fill="url(#wp-water)"/>';
    // shimmer (lake) or ice streaks (frozen lake)
    for (var j = 0; j < 9; j++) {
      var x0 = r() * W, y0 = 212 + r() * 32, w = 40 + r() * 120;
      s2 += '<path d="M' + f(x0) + " " + f(y0) + " h" + f(w) + '" stroke-linecap="round" stroke-width="' + (kind === "frozen-lake" ? 3 : 2) + '" style="stroke:var(--water-hi);opacity:' + (kind === "frozen-lake" ? 0.9 : 0.6) + '"/>';
    }
    return s2;
  }

  function pine(x, y, h, snowy) {
    var w = h * 0.42, s = '<rect x="' + f(x - h * 0.035) + '" y="' + f(y - h * 0.16) + '" width="' + f(h * 0.07) + '" height="' + f(h * 0.16) + '"' + fill("--trunk") + "/>";
    for (var i = 0; i < 3; i++) {
      var top = y - h + i * h * 0.24, bw = w * (0.55 + i * 0.25), by = top + h * 0.42;
      s += '<path d="M' + f(x) + " " + f(top) + " L" + f(x + bw / 2) + " " + f(by) + " L" + f(x - bw / 2) + " " + f(by) + 'Z"' + fill(i % 2 ? "--tree-2" : "--tree") + "/>";
      if (snowy) s += '<path d="M' + f(x) + " " + f(top) + " L" + f(x + bw * 0.22) + " " + f(top + h * 0.17) + " L" + f(x) + " " + f(top + h * 0.13) + " L" + f(x - bw * 0.22) + " " + f(top + h * 0.17) + 'Z"' + fill("--ground-hi") + "/>";
    }
    return s;
  }

  function sequoia(x, y, h, snowy) {
    var tw = h * 0.11, s = '<path d="M' + f(x - tw * 0.7) + " " + y + " L" + f(x - tw * 0.38) + " " + f(y - h * 0.62) + " L" + f(x + tw * 0.38) + " " + f(y - h * 0.62) + " L" + f(x + tw * 0.7) + " " + y + 'Z"' + fill("--trunk") + "/>";
    for (var i = 0; i < 4; i++) {
      var cy = y - h * (0.55 + i * 0.13), rx = h * (0.2 - i * 0.03), ry = h * 0.09;
      s += '<ellipse cx="' + f(x) + '" cy="' + f(cy) + '" rx="' + f(rx) + '" ry="' + f(ry) + '"' + fill(i % 2 ? "--tree-2" : "--tree") + "/>";
      if (snowy) s += '<ellipse cx="' + f(x) + '" cy="' + f(cy - ry * 0.6) + '" rx="' + f(rx * 0.75) + '" ry="' + f(ry * 0.35) + '"' + fill("--ground-hi") + "/>";
    }
    return s;
  }

  function roundTree(x, y, h) {
    var s = '<rect x="' + f(x - h * 0.04) + '" y="' + f(y - h * 0.45) + '" width="' + f(h * 0.08) + '" height="' + f(h * 0.45) + '"' + fill("--trunk") + "/>";
    s += '<circle cx="' + f(x - h * 0.16) + '" cy="' + f(y - h * 0.58) + '" r="' + f(h * 0.22) + '"' + fill("--tree-2") + "/>";
    s += '<circle cx="' + f(x + h * 0.15) + '" cy="' + f(y - h * 0.6) + '" r="' + f(h * 0.21) + '"' + fill("--tree") + "/>";
    s += '<circle cx="' + f(x) + '" cy="' + f(y - h * 0.8) + '" r="' + f(h * 0.24) + '"' + fill("--tree") + "/>";
    return s;
  }

  function palm(x, y, h, r) {
    var lean = (r() - 0.5) * h * 0.5, tx = x + lean, ty = y - h;
    var s = '<path d="M' + f(x) + " " + y + " Q" + f(x + lean * 0.2) + " " + f(y - h * 0.5) + " " + f(tx) + " " + f(ty) + '" stroke-width="' + f(h * 0.07) + '" fill="none" style="stroke:var(--trunk)"/>';
    for (var i = 0; i < 6; i++) {
      var a = (i / 6) * Math.PI * 2, ex = tx + Math.cos(a) * h * 0.4, ey = ty + Math.sin(a) * h * 0.18 + h * 0.08;
      s += '<path d="M' + f(tx) + " " + f(ty) + " Q" + f((tx + ex) / 2) + " " + f(ty - h * 0.12) + " " + f(ex) + " " + f(ey) + '" stroke-width="' + f(h * 0.06) + '" stroke-linecap="round" fill="none" style="stroke:var(--tree)"/>';
    }
    return s;
  }

  function cactus(x, y, h) {
    var w = h * 0.14, s = '<rect x="' + f(x - w / 2) + '" y="' + f(y - h) + '" width="' + f(w) + '" height="' + f(h) + '" rx="' + f(w / 2) + '"' + fill("--tree") + "/>";
    s += '<path d="M' + f(x - w / 2) + " " + f(y - h * 0.45) + " h" + f(-h * 0.18) + " v" + f(-h * 0.25) + '" stroke-width="' + f(w * 0.8) + '" stroke-linecap="round" stroke-linejoin="round" fill="none" style="stroke:var(--tree)"/>';
    s += '<path d="M' + f(x + w / 2) + " " + f(y - h * 0.6) + " h" + f(h * 0.16) + " v" + f(-h * 0.2) + '" stroke-width="' + f(w * 0.8) + '" stroke-linecap="round" stroke-linejoin="round" fill="none" style="stroke:var(--tree-2)"/>';
    return s;
  }

  function tree(kind, x, y, h, r) {
    switch (kind) {
      case "pine": return pine(x, y, h, false);
      case "snowy-pine": return pine(x, y, h, true);
      case "sequoia": return sequoia(x, y, h * 1.35, false);
      case "palm": return palm(x, y, h, r);
      case "cactus": return cactus(x, y, h * 0.8);
      case "deciduous": case "autumn": case "blossom": return roundTree(x, y, h);
      default: return "";
    }
  }

  function trees(kind, sceneWater, ground, r) {
    if (kind === "none") return "";
    var s = "", snowy = ground === "snow";
    // distant row along the far shore
    if (kind !== "palm" && kind !== "cactus") {
      for (var x = 10; x < W; x += 18 + r() * 26) {
        if (sceneWater === "ocean") break;
        var hh = 14 + r() * 14;
        s += kind === "sequoia" || kind === "pine" || kind === "snowy-pine" ? pine(x, 210, hh, snowy) : roundTree(x, 210, hh * 0.9);
      }
    }
    // foreground clusters on both sides (kept inside the area phones show), leaving the middle open
    [[40, 470], [730, 1160]].forEach(function (span) {
      var n = 6 + Math.floor(r() * 3);
      for (var i = 0; i < n; i++) {
        var x2 = span[0] + r() * (span[1] - span[0]), h = 60 + r() * 70, y = 262 + r() * 26;
        s += kind === "sequoia" ? sequoia(x2, y, h * 1.5, snowy) : tree(kind, x2, y, h, r);
      }
    });
    return s;
  }

  function skyline(r) {
    var s = '<g class="scene-skyline">', x = 140;
    while (x < 1060) {
      var w = 34 + r() * 50, h = 50 + r() * 110, top = 214 - h;
      s += '<rect x="' + f(x) + '" y="' + f(top) + '" width="' + f(w) + '" height="' + f(h) + '"' + fill("--near") + "/>";
      for (var wy = top + 10; wy < 204; wy += 14) {
        for (var wx = x + 6; wx < x + w - 8; wx += 12) {
          if (r() > 0.55) s += '<rect x="' + f(wx) + '" y="' + f(wy) + '" width="5" height="6"' + fill("--particle", "opacity:.85") + "/>";
        }
      }
      x += w + 4 + r() * 10;
    }
    return s + "</g>";
  }

  function ground(kind, sceneWater, r) {
    if (sceneWater === "ocean") {
      return '<path d="M-20 300 L-20 262 C 200 250, 300 270, 420 300 Z"' + fill("--ground") + '/><path d="M1220 300 L1220 258 C 1000 250, 900 272, 800 300 Z"' + fill("--ground") + "/>";
    }
    var top = sceneWater === "none" ? 226 : 248;
    var d = "M-20 " + top, x = -20;
    while (x < W + 20) {
      var w = 120 + r() * 160;
      d += " q" + f(w / 2) + " " + f(-6 - r() * 10) + " " + f(w) + " 0";
      x += w;
    }
    var s = '<path d="' + d + " L" + (W + 20) + " " + H + " L-20 " + H + 'Z"' + fill("--ground") + "/>";
    if (kind === "snow") s += '<path d="M-20 ' + (top + 18) + " C 300 " + (top + 6) + ", 700 " + (top + 30) + ", 1220 " + (top + 12) + ' L1220 300 L-20 300 Z"' + fill("--ground-hi", "opacity:.8") + "/>";
    if (kind === "city") s += '<rect x="-20" y="' + (top + 20) + '" width="' + (W + 40) + '" height="4"' + fill("--particle", "opacity:.35") + "/>";
    return s;
  }

  function particles(kind, r) {
    if (kind === "none") return "";
    var s = '<g class="scene-particles">', n = kind === "snow" ? 70 : kind === "stars" ? 0 : 26;
    for (var i = 0; i < n; i++) {
      var x = r() * W, y = -20 - r() * 60, dur = (kind === "snow" ? 9 : 12) + r() * 10, delay = -r() * 20;
      var st = ' style="animation-duration:' + f(dur) + "s;animation-delay:" + f(delay) + 's"';
      if (kind === "snow") s += '<circle class="p-fall" cx="' + f(x) + '" cy="' + f(y) + '" r="' + f(1.2 + r() * 2.6) + '"' + st + ' fill="var(--particle)" opacity="' + f(0.6 + r() * 0.4) + '"/>';
      else if (kind === "rain") s += '<path class="p-rain" d="M' + f(x) + " " + f(y) + ' l-6 18"' + st + ' stroke="var(--water-hi)" stroke-width="1.5" opacity=".7"/>';
      else s += '<ellipse class="p-drift" cx="' + f(x) + '" cy="' + f(y) + '" rx="' + f(3 + r() * 3) + '" ry="' + f(1.6 + r() * 1.6) + '"' + st + ' fill="var(--particle)" opacity=".9"/>';
    }
    return s + "</g>";
  }

  function render(el, theme, seed) {
    if (!el) return;
    var sc = resolve(theme), r = rng(seed || "waypack");
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">' +
      sky() + stars(r) + sun(sc.sun || "sun", r) + mountains(sc.mountains || "none", r) +
      (sc.skyline ? skyline(r) : "") + water(sc.water || "none", r) + trees(sc.trees || "none", sc.water || "none", sc.ground || "grass", r) +
      ground(sc.ground || "grass", sc.water || "none", r) + particles(sc.particles || "none", r) + "</svg>";
    el.innerHTML = svg;
    el.setAttribute("data-scene", [sc.mountains, sc.water, sc.trees, sc.ground, sc.particles].join(" "));
  }

  window.WaypackScene = { render: render, resolve: resolve, presets: Object.keys(PRESETS) };
})();
