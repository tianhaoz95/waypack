import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/template.dart';
import 'scrapbook.dart';

/// Trip gallery objects: postcards with a drawn scene, the TRAVELED postmark, the stylised world
/// map and a template's route map. Same drawings as the site (site/gallery.js).

Color _mix(Color a, Color b, double t) => Color.lerp(a, b, t)!;

/// The trip's landscape from manifest.theme.scene (sun, mountains, water, trees, ground, skyline).
class TemplateScenePainter extends CustomPainter {
  TemplateScenePainter(this.scene, this.accent);
  final Map<String, dynamic> scene;
  final Color accent;

  @override
  void paint(Canvas canvas, Size size) {
    // Drawn on a 160×100 canvas, scaled to cover the box (like CSS `slice`).
    const w = 160.0, h = 100.0, hz = 66.0;
    final k = math.max(size.width / w, size.height / h);
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    canvas.translate((size.width - w * k) / 2, (size.height - h * k) / 2);
    canvas.scale(k);
    final s = scene;
    final sky = s['sun'] == 'moon'
        ? const [Color(0xFFC9B6E8), Color(0xFFFBE1E6)]
        : s['ground'] == 'snow'
        ? const [Color(0xFFB9D3EE), Color(0xFFEEF4FA)]
        : s['sun'] == 'low-sun'
        ? const [Color(0xFFF7C59F), Color(0xFFFBE3C8)]
        : s['ground'] == 'sand'
        ? const [Color(0xFF9ED0E6), Color(0xFFFCE6C9)]
        : const [Color(0xFFBFD9E8), Color(0xFFF4EBD3)];
    canvas.drawRect(
      const Rect.fromLTWH(0, 0, w, h),
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: sky,
        ).createShader(const Rect.fromLTWH(0, 0, w, h)),
    );
    final p = Paint();
    switch (s['sun']) {
      case 'sun':
        canvas.drawCircle(const Offset(122, 26), 17, p..color = const Color(0x59FFF3C4));
        canvas.drawCircle(const Offset(122, 26), 11, p..color = const Color(0xFFFFF3C4));
      case 'low-sun':
        canvas.drawCircle(const Offset(104, hz - 6), 29, p..color = const Color(0x73FFE7C2));
        canvas.drawCircle(const Offset(104, hz - 6), 20, p..color = const Color(0xFFFFD9A0));
      case 'moon':
        canvas.drawCircle(const Offset(120, 24), 9, p..color = const Color(0xFFFFF8E8));
        canvas.drawCircle(const Offset(125, 21), 8, p..color = sky[0]);
    }
    final far = _mix(accent, sky[1], .55);
    Path poly(List<double> xy) {
      final path = Path()..moveTo(xy[0], xy[1]);
      for (var i = 2; i < xy.length; i += 2) {
        path.lineTo(xy[i], xy[i + 1]);
      }
      return path..close();
    }

    switch (s['mountains']) {
      case 'rolling':
        canvas.drawPath(
          Path()
            ..moveTo(0, hz - 4)
            ..cubicTo(30, hz - 22, 55, hz - 18, 80, hz - 6)
            ..cubicTo(105, hz + 6, 130, hz - 26, 160, hz - 10)
            ..lineTo(160, h)
            ..lineTo(0, h)
            ..close(),
          p..color = far,
        );
      case 'peaks' || 'snowy-peaks':
        canvas.drawPath(
          poly([-5, hz, 28, hz - 34, 52, hz - 12, 82, hz - 44, 112, hz - 10, 138, hz - 30, 170, hz]),
          p..color = far,
        );
        if (s['mountains'] == 'snowy-peaks') {
          p.color = Colors.white;
          canvas.drawPath(poly([82, hz - 44, 74, hz - 33, 80, hz - 35, 85, hz - 31, 91, hz - 34]), p);
          canvas.drawPath(poly([28, hz - 34, 21, hz - 25, 28, hz - 27, 35, hz - 25]), p);
          canvas.drawPath(poly([138, hz - 30, 132, hz - 23, 139, hz - 24, 144, hz - 23]), p);
        }
      case 'mesas':
        canvas.drawPath(
          poly([0, hz, 0, hz - 16, 18, hz - 16, 24, hz - 30, 58, hz - 30, 64, hz - 14, 100, hz - 14, 106, hz - 36, 140, hz - 36, 146, hz - 18, 160, hz - 18, 160, hz]),
          p..color = far,
        );
    }
    if (s['skyline'] == true) {
      const b = [[8, 22], [20, 34], [34, 18], [44, 40], [58, 26], [70, 30], [84, 46], [96, 24], [108, 32], [120, 20], [132, 36], [146, 26]];
      for (final (i, e) in b.indexed) {
        canvas.drawRect(Rect.fromLTWH(e[0].toDouble(), hz - e[1], 11, e[1].toDouble()), p..color = _mix(accent, sky[1], .35));
        if (i.isOdd) canvas.drawRect(Rect.fromLTWH(e[0] + 3.0, hz - e[1] + 6, 2, 2), p..color = const Color(0xFFFFE9A8));
      }
    }
    final ground = switch (s['ground']) {
      'snow' => const Color(0xFFF4F7FB),
      'sand' => const Color(0xFFF2D6A2),
      'rock' => const Color(0xFFA79C8E),
      'city' => _mix(accent, const Color(0xFFE9DCCB), .6),
      _ => _mix(const Color(0xFF7FA66A), accent, .15),
    };
    final water = s['water'] is String && s['water'] != 'none';
    Path groundPath() => Path()
      ..moveTo(0, hz)
      ..cubicTo(50, hz - 4, 110, hz + 4, 160, hz - 2)
      ..lineTo(160, h)
      ..lineTo(0, h)
      ..close();
    if (water) {
      final wc = s['water'] == 'frozen-lake'
          ? const Color(0xFFDCE9F5)
          : _mix(const Color(0xFF5BA4C8), accent, .15);
      if (s['water'] == 'river') {
        canvas.drawPath(groundPath(), p..color = ground);
        canvas.drawPath(
          Path()
            ..moveTo(60, hz)
            ..cubicTo(80, hz + 10, 40, hz + 20, 70, h)
            ..lineTo(100, h)
            ..cubicTo(70, hz + 20, 110, hz + 10, 84, hz)
            ..close(),
          p..color = wc,
        );
      } else {
        canvas.drawRect(const Rect.fromLTWH(0, hz, w, h - hz), p..color = wc);
        final line = Paint()
          ..color = const Color(0x99FFFFFF)
          ..strokeWidth = 1.4
          ..strokeCap = StrokeCap.round;
        canvas.drawLine(const Offset(14, hz + 8), const Offset(32, hz + 8), line);
        canvas.drawLine(const Offset(60, hz + 13), const Offset(86, hz + 13), line);
        canvas.drawLine(const Offset(110, hz + 7), const Offset(130, hz + 7), line);
        canvas.drawPath(
          Path()
            ..moveTo(0, h - 12)
            ..cubicTo(40, h - 18, 90, h - 8, 160, h - 15)
            ..lineTo(160, h)
            ..lineTo(0, h)
            ..close(),
          p..color = ground,
        );
      }
    } else {
      canvas.drawPath(groundPath(), p..color = ground);
    }
    final snowy = s['ground'] == 'snow';
    final spots = water && s['water'] != 'river'
        ? const [[12.0, h - 12, 1.1], [26.0, h - 13, .8], [148.0, h - 13, 1.0]]
        : const [[14.0, hz + 6, 1.0], [28.0, hz + 10, 1.3], [134.0, hz + 4, .9], [148.0, hz + 10, 1.2], [118.0, hz + 8, .7]];
    for (final sp in spots) {
      _tree(canvas, '${s['trees']}', sp[0], sp[1], sp[2], snowy);
    }
    canvas.restore();
  }

  void _tree(Canvas c, String kind, double x, double y, double k, bool snowy) {
    final p = Paint();
    Path tri(double top, double half, double base) => Path()
      ..moveTo(x, top)
      ..lineTo(x - half, base)
      ..lineTo(x + half, base)
      ..close();
    void round(Color col) {
      c.drawRect(Rect.fromLTWH(x - 1, y - 8 * k, 2, 8 * k), p..color = const Color(0xFF6B4430));
      c.drawCircle(Offset(x, y - 12 * k), 7 * k, p..color = col);
    }

    switch (kind) {
      case 'pine' || 'snowy-pine':
        c.drawPath(tri(y - 20 * k, 7 * k, y), p..color = _mix(const Color(0xFF2F5D3A), accent, .1));
        if (snowy || kind == 'snowy-pine') c.drawPath(tri(y - 20 * k, 3 * k, y - 12 * k), p..color = Colors.white);
      case 'sequoia':
        c.drawRect(Rect.fromLTWH(x - 1.6 * k, y - 14 * k, 3.2 * k, 14 * k), p..color = const Color(0xFF8A3B22));
        c.drawPath(tri(y - 30 * k, 6 * k, y - 10 * k), p..color = const Color(0xFF2F5D3A));
        if (snowy) c.drawPath(tri(y - 30 * k, 2.5 * k, y - 22 * k), p..color = Colors.white);
      case 'deciduous':
        round(const Color(0xFF5E8C4E));
      case 'autumn':
        round(const [Color(0xFFD9562B), Color(0xFFE8A33A), Color(0xFFB8452A)][x.round() % 3]);
      case 'blossom':
        round(const Color(0xFFF2B5C8));
      case 'palm':
        final stroke = Paint()
          ..style = PaintingStyle.stroke
          ..strokeCap = StrokeCap.round;
        final t = Offset(x + 4 * k, y - 20 * k);
        c.drawPath(Path()..moveTo(x, y)..quadraticBezierTo(x + 2, y - 10, t.dx, t.dy), stroke..color = const Color(0xFF7A5A3A)..strokeWidth = 2);
        stroke
          ..color = const Color(0xFF3E7D4E)
          ..strokeWidth = 2.4;
        for (final d in const [[-10.0, -2.0, -14.0, 6.0], [10.0, -3.0, 13.0, 5.0], [-4.0, -8.0, -11.0, -8.0], [6.0, -8.0, 12.0, -6.0]]) {
          c.drawPath(Path()..moveTo(t.dx, t.dy)..relativeQuadraticBezierTo(d[0], d[1], d[2], d[3]), stroke);
        }
      case 'cactus':
        final stroke = Paint()
          ..style = PaintingStyle.stroke
          ..strokeCap = StrokeCap.round
          ..strokeWidth = 3 * k
          ..color = const Color(0xFF4E7D4F);
        c.drawLine(Offset(x, y), Offset(x, y - 16 * k), stroke);
        c.drawPath(Path()..moveTo(x - 5 * k, y - 6 * k)..lineTo(x - 5 * k, y - 11 * k)..lineTo(x, y - 11 * k), stroke);
        c.drawPath(Path()..moveTo(x + 5 * k, y - 9 * k)..lineTo(x + 5 * k, y - 13 * k)..lineTo(x, y - 13 * k), stroke);
    }
  }

  @override
  bool shouldRepaint(TemplateScenePainter old) =>
      old.accent != accent || old.scene != scene;
}

/// Round TRAVELED postmark with the month and year.
class Postmark extends StatelessWidget {
  const Postmark({super.key, required this.t, this.size = 56});
  final TripTemplate t;
  final double size;
  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Traveled ${t.traveledLabel}',
    child: SizedBox.square(
      dimension: size,
      child: CustomPaint(painter: _PostmarkPainter(t.traveledLabel)),
    ),
  );
}

class _PostmarkPainter extends CustomPainter {
  _PostmarkPainter(this.label);
  final String label;
  static const color = Color(0xFFA9583F);

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 64;
    canvas.save();
    canvas.scale(s);
    const c = Offset(32, 32);
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..color = color;
    canvas.drawCircle(c, 29, ring..strokeWidth = 2.4);
    canvas.drawCircle(c, 16, ring..strokeWidth = 1.4);
    // Text around the ring, one letter at a time.
    const around = 'TRAVELED · WAYPACK · TRAVELED · ';
    for (var i = 0; i < around.length; i++) {
      final a = -math.pi + i * (2 * math.pi / around.length);
      final tp = TextPainter(
        text: TextSpan(
          text: around[i],
          style: const TextStyle(fontSize: 6.6, fontWeight: FontWeight.w800, color: color),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      canvas.save();
      canvas.translate(c.dx + math.cos(a) * 22.5, c.dy + math.sin(a) * 22.5);
      canvas.rotate(a + math.pi / 2);
      tp.paint(canvas, Offset(-tp.width / 2, -tp.height / 2));
      canvas.restore();
    }
    final parts = label.split(' ');
    for (final (i, part) in parts.indexed) {
      final tp = TextPainter(
        text: TextSpan(
          text: part.toUpperCase(),
          style: const TextStyle(fontSize: 8.5, fontWeight: FontWeight.w900, color: color),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, Offset(32 - tp.width / 2, (i == 0 ? 24 : 34) - 1));
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_PostmarkPainter old) => old.label != label;
}

/// A postcard: the trip's scene with a stamp (month + days) and the postmark.
/// [big] adds "Greetings from" and the place name. Postcards are paper objects: light in dark mode too.
class Postcard extends StatelessWidget {
  const Postcard({super.key, required this.t, this.big = false, this.tilt = 0, this.selected = false});
  final TripTemplate t;
  final bool big, selected;
  final double tilt;

  @override
  Widget build(BuildContext context) {
    final place = t.region.split(',').first;
    Widget card = Container(
      padding: EdgeInsets.all(big ? 8 : 5),
      decoration: BoxDecoration(
        color: Paper.lightPaper,
        borderRadius: BorderRadius.circular(3),
        boxShadow: paperShadow,
        border: selected ? Border.all(color: Paper.of(context).accent, width: 2.5) : null,
      ),
      child: AspectRatio(
        aspectRatio: 3 / 2,
        child: Stack(
          fit: StackFit.expand,
          children: [
            CustomPaint(painter: TemplateScenePainter(t.scene, t.accent)),
            Positioned(
              top: big ? 10 : 5,
              right: big ? 10 : 5,
              child: _Stamp(t: t, big: big),
            ),
            Positioned(
              left: big ? null : 2,
              right: big ? 70 : null,
              top: big ? 8 : null,
              bottom: big ? null : 0,
              child: Transform.rotate(
                angle: -.21,
                child: Opacity(opacity: .85, child: Postmark(t: t, size: big ? 64 : 40)),
              ),
            ),
            if (big)
              Positioned(
                left: 14,
                right: 14,
                bottom: 10,
                child: DefaultTextStyle(
                  style: const TextStyle(
                    color: Colors.white,
                    shadows: [Shadow(color: Color(0x66000000), blurRadius: 8, offset: Offset(0, 2))],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Greetings from', style: hand(20, Colors.white)),
                      FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: Text(
                          place.toUpperCase(),
                          style: const TextStyle(fontSize: 46, fontWeight: FontWeight.w900, height: 1, letterSpacing: -1),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
    return tilt == 0 ? card : Transform.rotate(angle: tilt * math.pi / 180, child: card);
  }
}

class _Stamp extends StatelessWidget {
  const _Stamp({required this.t, required this.big});
  final TripTemplate t;
  final bool big;
  @override
  Widget build(BuildContext context) => Container(
    width: big ? 54 : 34,
    padding: const EdgeInsets.symmetric(vertical: 3),
    decoration: BoxDecoration(
      color: Paper.lightPaper,
      border: Border.all(color: const Color(0xFFE7B9A8), width: 1.5),
      boxShadow: const [BoxShadow(color: Paper.lightPaper, spreadRadius: 2)],
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          TripTemplate.months[t.travelMonth - 1],
          style: TextStyle(fontSize: big ? 11 : 8.5, fontWeight: FontWeight.w900, color: const Color(0xFFA9583F), height: 1),
        ),
        Text('${t.days}d', style: hand(big ? 26 : 16, const Color(0xFFA9583F))),
      ],
    ),
  );
}

/// Postcard with its handwritten caption, as in the grid and the rows.
class PostcardTile extends StatelessWidget {
  const PostcardTile({super.key, required this.t, required this.onTap, this.tilt = 0, this.showPlanned = false, this.selected = false, this.titleLines = 2});
  final TripTemplate t;
  final VoidCallback onTap;
  final double tilt;
  final bool showPlanned, selected;

  /// One line in horizontal rows (fixed height), two in grids.
  final int titleLines;
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return Semantics(
      button: true,
      label: '${t.title}, ${t.facts}',
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: ExcludeSemantics(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Postcard(t: t, tilt: tilt, selected: selected),
              const SizedBox(height: 8),
              Text(t.title, maxLines: titleLines, overflow: TextOverflow.ellipsis, style: hand(21, p.ink)),
              const SizedBox(height: 3),
              Text(
                showPlanned ? '${t.facts} · ${t.plannedLabel}' : t.facts,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11.5, color: p.muted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ───────────────────────── world map

/// Natural Earth 1:110m land (public domain), flattened [lon, lat, lon, lat, …] rings.
class LandData {
  static List<List<double>>? _rings;
  static Future<List<List<double>>> load() async {
    if (_rings != null) return _rings!;
    final j = jsonDecode(await rootBundle.loadString('assets/data/land-110m.json')) as Map<String, dynamic>;
    return _rings = (j['rings'] as List).map((r) => (r as List).map((n) => (n as num).toDouble()).toList()).toList();
  }
}

/// Equirectangular map. [view] is the visible box in (lon, -lat) units.
class WorldMapPainter extends CustomPainter {
  WorldMapPainter({required this.rings, required this.view, required this.pins, required this.selected, required this.dark});
  final List<List<double>> rings;
  final Rect view;
  final List<TripTemplate> pins;
  final String? selected;
  final bool dark;

  Offset project(double lon, double lat, Size size) => Offset(
    (lon - view.left) / view.width * size.width,
    (-lat - view.top) / view.height * size.height,
  );

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = dark ? const Color(0xFF2A3138) : const Color(0xFFD8E6EC));
    final land = Paint()..color = dark ? const Color(0xFF4A4038) : const Color(0xFFEFE4CF);
    final edge = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..strokeJoin = StrokeJoin.round
      ..color = dark ? const Color(0xFF6A5B4E) : const Color(0xFFC9B597);
    for (final r in rings) {
      final path = Path();
      for (var i = 0; i < r.length; i += 2) {
        final o = project(r[i], r[i + 1], size);
        i == 0 ? path.moveTo(o.dx, o.dy) : path.lineTo(o.dx, o.dy);
      }
      path.close();
      canvas.drawPath(path, land);
      canvas.drawPath(path, edge);
    }
    for (final t in pins) {
      if (t.lat == null || t.lon == null) continue;
      final o = project(t.lon!, t.lat!, size);
      final on = t.slug == selected;
      canvas.drawCircle(o, on ? 13 : 10, Paint()..color = t.accent.withValues(alpha: .25));
      canvas.drawCircle(o, on ? 8 : 6, Paint()..color = on ? const Color(0xFFD9694F) : t.accent);
      canvas.drawCircle(
        o,
        on ? 8 : 6,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..color = Paper.lightPaper,
      );
    }
  }

  @override
  bool shouldRepaint(WorldMapPainter old) =>
      old.view != view || old.pins != pins || old.selected != selected || old.dark != dark || old.rings != rings;
}

// ───────────────────────── route map

const dayColors = [
  Color(0xFFD9694F),
  Color(0xFF3E7A8C),
  Color(0xFFB87810),
  Color(0xFF4F8A62),
  Color(0xFF8A5BB8),
  Color(0xFFC2562D),
  Color(0xFF2F7F9E),
];
Color dayColor(int i) => dayColors[i % dayColors.length];

/// A template's stops in a local projection, joined in order and coloured by day.
class RouteMapPainter extends CustomPainter {
  RouteMapPainter(this.t, {required this.dark});
  final TripTemplate t;
  final bool dark;

  static bool canDraw(TripTemplate t) =>
      t.plan.expand((d) => d.stops).where((s) => s.lat != null).length >= 2;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = dark ? const Color(0xFF2F2722) : Paper.lightPaper);
    final grid = Paint()..color = dark ? const Color(0x0FFFFFFF) : const Color(0x247FA3B5);
    for (var x = 0.0; x < size.width; x += 40) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), grid);
    }
    for (var y = 0.0; y < size.height; y += 40) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }
    final pts = <(int, double, double)>[];
    for (final (di, d) in t.plan.indexed) {
      for (final s in d.stops) {
        if (s.lat != null && s.lon != null) pts.add((di, s.lat!, s.lon!));
      }
    }
    if (pts.length < 2) return;
    final k = math.cos(pts.first.$2 * math.pi / 180);
    final xs = pts.map((p) => p.$3 * k).toList(), ys = pts.map((p) => -p.$2).toList();
    final x0 = xs.reduce(math.min), x1 = xs.reduce(math.max), y0 = ys.reduce(math.min), y1 = ys.reduce(math.max);
    const pad = 28.0;
    final sc = math.min((size.width - pad * 2) / math.max(x1 - x0, 1e-4), (size.height - pad * 2) / math.max(y1 - y0, 1e-4));
    final ox = (size.width - (x1 - x0) * sc) / 2, oy = (size.height - (y1 - y0) * sc) / 2;
    final o = [for (var i = 0; i < pts.length; i++) Offset(ox + (xs[i] - x0) * sc, oy + (ys[i] - y0) * sc)];
    for (var i = 1; i < o.length; i++) {
      final paint = Paint()
        ..color = dayColor(pts[i].$1).withValues(alpha: .85)
        ..strokeWidth = 3
        ..strokeCap = StrokeCap.round;
      if (pts[i].$1 == pts[i - 1].$1) {
        canvas.drawLine(o[i - 1], o[i], paint);
      } else {
        // Dashed between days.
        final d = o[i] - o[i - 1];
        final n = (d.distance / 10).floor().clamp(1, 400);
        for (var j = 0; j < n; j += 2) {
          canvas.drawLine(o[i - 1] + d * (j / n), o[i - 1] + d * (math.min(j + 1, n) / n), paint);
        }
      }
    }
    final seen = <String>{};
    for (final (i, p) in o.indexed) {
      if (!seen.add('${(p.dx / 6).round()}:${(p.dy / 6).round()}')) continue;
      canvas.drawCircle(p, 8, Paint()..color = dayColor(pts[i].$1));
      canvas.drawCircle(
        p,
        8,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..color = Paper.lightPaper,
      );
      final tp = TextPainter(
        text: TextSpan(text: '${i + 1}', style: const TextStyle(fontSize: 8.5, fontWeight: FontWeight.w900, color: Colors.white)),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, p - Offset(tp.width / 2, tp.height / 2));
    }
  }

  @override
  bool shouldRepaint(RouteMapPainter old) => old.t != t || old.dark != dark;
}
