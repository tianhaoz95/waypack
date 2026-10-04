import 'dart:math';

import '../models/manifest.dart';
import '../util/today.dart';
import 'engine.dart';

/// Builds what the on-device model sees for one question (DECISIONS #50).
///
/// Small on-device models have ~4,000 tokens of context (Apple Foundation Models 4,096; Gemini
/// Nano ≤ 4,000 input), so instead of the whole trip we send a compact, question-specific brief:
/// the situation (now/next, today and tomorrow), the places that matter (nearest to the GPS fix,
/// or matching the question), emergency info, and the guide passages that best match the
/// question. Distances and directions are computed here, not by the model.

/// Plain, short instructions: small on-device models echo headings and over-apply rules
/// (tested against Apple's model; see DECISIONS #50).
const instructions =
    'You help a traveler with their trip plan, offline. Answer their question in one to three short sentences, '
    'using only the facts in the trip notes. Quote phone numbers, times and names exactly as written. '
    'Don\'t add phone numbers, advice or details the question didn\'t ask for. Don\'t repeat the notes. '
    'If the trip notes have nothing that answers the question, reply exactly: '
    '"Your plan doesn\'t cover that. Ask the lodge or a ranger."';

/// Added for emergency questions only.
const emergencyInstruction =
    ' This is an emergency question: give the emergency number first, then the nearest hospital or clinic from the notes with its phone number.';

class LatLon {
  const LatLon(this.lat, this.lon);
  final double lat;
  final double lon;
}

class Turn {
  const Turn(this.question, this.answer);
  final String question;
  final String answer;
}

/// Words that point at place categories (trip manifests use these category ids).
const _categoryWords = <String, List<String>>{
  'fuel': [
    'gas',
    'fuel',
    'petrol',
    'diesel',
    'charge',
    'charging',
    'ev',
    'fill',
  ],
  'food': [
    'food',
    'eat',
    'eating',
    'lunch',
    'dinner',
    'breakfast',
    'restaurant',
    'cafe',
    'coffee',
    'hungry',
    'snack',
    'meal',
  ],
  'medical': [
    'hospital',
    'doctor',
    'urgent',
    'clinic',
    'injury',
    'injured',
    'hurt',
    'sick',
    'pharmacy',
    'medical',
    'er',
    'fever',
    'vomiting',
    'vomit',
    'bleeding',
    'breathing',
    'breathe',
    'allergic',
    'allergy',
    'pain',
    'fell',
    'fall',
    'broken',
    'burn',
    'bite',
    'sting',
    'unconscious',
    'chest',
    'hypothermia',
    'frostbite',
    'medicine',
  ],
  'lodging': [
    'hotel',
    'lodge',
    'stay',
    'sleep',
    'room',
    'check-in',
    'checkin',
    'cabin',
    'campground',
    'bed',
  ],
  'trailhead': ['trail', 'hike', 'hiking', 'trailhead', 'walk', 'snowshoe'],
  'sight': ['see', 'view', 'viewpoint', 'sight', 'photo', 'sunset', 'sunrise'],
  'shopping': ['store', 'shop', 'groceries', 'grocery', 'supplies', 'buy'],
  'transport': [
    'parking',
    'park',
    'shuttle',
    'bus',
    'train',
    'ferry',
    'airport',
  ],
};

const _categoryLabel = {
  'fuel': 'gas station',
  'food': 'food',
  'lodging': 'lodging',
  'medical': 'medical',
  'trailhead': 'trailhead',
  'sight': 'sight',
  'activity': 'activity',
  'shopping': 'shop',
  'transport': 'transport',
  'other': 'place',
};

/// "Plan B" questions: search the guide for backup plans too.
const _backupWords = [
  'backup',
  'plan b',
  'if closed',
  'closed',
  'instead',
  'alternative',
  'not plowed',
  'rain',
  'weather',
  'storm',
];
final _backupQuestion = RegExp(
  r'plan b|backup|closed|closure|rain|weather|storm|instead|alternative|cancel',
);

const _stop = {
  'the',
  'and',
  'for',
  'are',
  'what',
  'where',
  'when',
  'how',
  'can',
  'there',
  'this',
  'that',
  'with',
  'from',
  'about',
  'near',
  'nearest',
  'closest',
  'any',
  'our',
  'we',
  'you',
  'is',
  'do',
  'does',
  'have',
  'has',
  'today',
  'now',
  'next',
  'should',
  'would',
  'could',
  'which',
  'who',
  'into',
  'out',
  'get',
  'go',
  'going',
  'trip',
  'plan',
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'at',
  'it',
  'me',
};

List<String> _terms(String q) =>
    RegExp(r"[a-z0-9'-]+")
        .allMatches(q.toLowerCase())
        .map((m) => m.group(0)!)
        .where((w) => w.length >= 2 && !_stop.contains(w))
        .toList();

double distanceKm(LatLon a, LatLon b) {
  const r = 6371.0;
  double rad(double d) => d * pi / 180;
  final dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  final h =
      pow(sin(dLat / 2), 2) +
      cos(rad(a.lat)) * cos(rad(b.lat)) * pow(sin(dLon / 2), 2);
  return 2 * r * asin(min(1.0, sqrt(h)));
}

String bearing(LatLon a, LatLon b) {
  double rad(double d) => d * pi / 180;
  final y = sin(rad(b.lon - a.lon)) * cos(rad(b.lat));
  final x =
      cos(rad(a.lat)) * sin(rad(b.lat)) -
      sin(rad(a.lat)) * cos(rad(b.lat)) * cos(rad(b.lon - a.lon));
  final deg = (atan2(y, x) * 180 / pi + 360) % 360;
  return const ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][((deg + 22.5) %
      360 ~/
      45)];
}

/// "1.2 mi (1.9 km)" for US trips' readers and everyone else.
String _dist(double km) => km < 0.2
    ? '${(km * 1000).round()} m'
    : '${(km * 0.621371).toStringAsFixed(1)} mi (${km.toStringAsFixed(1)} km)';

String _clip(String? s, int n) {
  if (s == null) return '';
  final t = s.replaceAll(RegExp(r'\s+'), ' ').trim();
  return t.length <= n ? t : '${t.substring(0, n - 1)}…';
}

/// Splits the guide page's text into passages of ~450 characters, each keeping the heading it
/// sits under (a short line without a final period starts a new passage).
List<String> guidePassages(String text) {
  final out = <String>[];
  var heading = '';
  final cur = StringBuffer();
  void flush() {
    final body = cur.toString().trim();
    if (body.length >= 25) out.add(heading.isEmpty ? body : '$heading: $body');
    cur.clear();
  }

  for (final raw in text.split('\n')) {
    final line = raw.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (line.isEmpty) continue;
    final isHeading =
        line.length <= 70 &&
        !RegExp(r'[.!?:;)]$').hasMatch(line) &&
        !RegExp(r'^\d').hasMatch(line);
    if (isHeading) {
      flush();
      heading = line;
      continue;
    }
    if (cur.length + line.length > 450) flush();
    if (line.length > 500) {
      for (var i = 0; i < line.length; i += 450) {
        cur.write(line.substring(i, min(line.length, i + 500)));
        flush();
      }
      continue;
    }
    cur.write(cur.isEmpty ? line : ' $line');
  }
  flush();
  return out;
}

/// Visible text of the trip page (no tags, scripts or styles).
String htmlText(String html) => html
    .replaceAll(
      RegExp(
        r'<(script|style|svg|template)[\s\S]*?</\1>',
        caseSensitive: false,
      ),
      ' ',
    )
    .replaceAll(
      RegExp(
        r'<br\s*/?>|</(p|div|li|h[1-6]|section|article|tr|details|summary)>',
        caseSensitive: false,
      ),
      '\n',
    )
    .replaceAll(RegExp(r'<[^>]+>'), ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll(RegExp(r'[ \t]+'), ' ')
    .replaceAll(RegExp(r' *\n *'), '\n')
    .replaceAll(RegExp(r'\n{3,}'), '\n\n')
    .trim();

class TripBrief {
  TripBrief(this.manifest, {String guideText = ''})
    : _passages = guidePassages(guideText);
  final Manifest manifest;
  final List<String> _passages;

  /// The request for [question], at most [budget] characters of notes (~4 chars per token).
  AssistantRequest build(
    String question, {
    LatLon? here,
    DateTime? now,
    List<Turn> history = const [],
    int budget = 7000,
  }) {
    final m = manifest;
    final q = question.toLowerCase();
    final terms = _terms(question);
    final cats = <String>{
      for (final e in _categoryWords.entries)
        if (terms.any((t) => e.value.contains(t))) e.key,
    };
    // Urgent situations (not just "where's the hospital"): emergency number first.
    final emergency = RegExp(
      r'emergenc|911|112|999|\bhelp\b|accident|\blost\b|rescue|hurt|injur|bleed|fever|breath|unconscious|'
      r'allerg|chest pain|fell|broken|bitten|bite|sting|hypotherm|frostbite|crash|stuck|stranded|missing',
    ).hasMatch(q);
    final aboutTime = RegExp(
      r'next|now|today|tomorrow|tonight|morning|afternoon|evening|when|time|schedule|plan|day|late|early|leave|left',
    ).hasMatch(q);

    // 1. Situation.
    final (today, nowTime) = nowIn(m.timezone, at: now);
    final tv = computeToday(m, today: today, nowTime: nowTime);
    final s = StringBuffer(
      'Right now: $today $nowTime (trip time zone ${m.timezone}). Trip: "${m.title}", ${m.startDate} to ${m.endDate}.',
    );
    if (tv.phase == TripPhase.before) {
      s.write(' The trip starts in ${tv.daysUntil} day(s).');
    }
    if (tv.phase == TripPhase.after) s.write(' The trip is over.');
    if (tv.phase == TripPhase.during && tv.day != null) {
      s.write(
        ' Day ${tv.dayNumber}${tv.day!.title != null ? ' (${tv.day!.title})' : ''}.',
      );
      if (tv.nowIndex >= 0) {
        s.write(' Happening now: ${_item(tv.day!.items[tv.nowIndex])}.');
      }
      if (tv.nextIndex >= 0) {
        s.write(' Next: ${_item(tv.day!.items[tv.nextIndex])}.');
      }
    }
    if (here != null) {
      s.write(
        ' Phone GPS: ${here.lat.toStringAsFixed(4)}, ${here.lon.toStringAsFixed(4)}.',
      );
    }
    final situation = s.toString();

    // 2. Places, scored against the question (names count most), then by distance.
    final scored = <(Place, double, bool)>[];
    for (final p in m.places) {
      var score = 0.0;
      var named = false;
      final name = p.name.toLowerCase();
      final hay = '$name ${p.category} ${p.address ?? ''} ${p.notes ?? ''}'
          .toLowerCase();
      if (cats.contains(p.category)) score += 5;
      final nameTerms = terms
          .where((t) => t.length >= 3 && name.contains(t))
          .length;
      if (nameTerms > 0) {
        score += 4.0 * nameTerms;
        named = nameTerms >= min(2, terms.where((t) => t.length >= 3).length);
      }
      for (final t in terms) {
        if (hay.contains(t)) score += 1;
      }
      if ((emergency || cats.contains('medical')) && p.category == 'medical') {
        score += 5;
      }
      if (here != null) {
        score += 2 / (1 + distanceKm(here, LatLon(p.lat, p.lon)));
      }
      scored.add((p, score, named));
    }
    scored.sort((a, b) => b.$2.compareTo(a.$2));
    // Most relevant: places the question names, or its category's best matches.
    final relevant = scored
        .where((e) => e.$3 || (cats.contains(e.$1.category) && e.$2 >= 5))
        .take(3)
        .map((e) => e.$1)
        .toList();
    final others = scored
        .map((e) => e.$1)
        .where((p) => !relevant.contains(p))
        .take(relevant.isEmpty ? 8 : 5)
        .toList();

    // 3. Emergency (protected from trimming).
    final em = <String>[
      ...m.emergencyNumbers.map((n) => '${n['label']}: ${n['value']}'),
      if ((m.raw['emergency'] as Map?)?['notes'] != null)
        _clip((m.raw['emergency'] as Map)['notes'] as String?, 300),
    ];
    final emergencyBlock = em.isEmpty
        ? null
        : 'Emergency contacts: ${em.join(' · ')}';

    // 4. Days: today (or day 1 before the trip); tomorrow for time/plan questions; any named day.
    final days = <Day>[];
    final idx = tv.day == null
        ? -1
        : m.days.indexWhere((d) => d.date == tv.day!.date);
    if (idx >= 0) {
      days.add(m.days[idx]);
      if ((aboutTime || relevant.isEmpty) && idx + 1 < m.days.length) {
        days.add(m.days[idx + 1]);
      }
    }
    for (final mm in RegExp(r'day\s*(\d+)').allMatches(q)) {
      final n = int.parse(mm.group(1)!) - 1;
      if (n >= 0 && n < m.days.length && !days.contains(m.days[n])) {
        days.add(m.days[n]);
      }
    }

    // 5. Guide passages that match the question.
    final guide = <String>[];
    if (terms.isNotEmpty || cats.isNotEmpty) {
      final words = {
        ...terms.where((t) => t.length >= 3),
        for (final c in cats) ..._categoryWords[c]!,
        if (_backupQuestion.hasMatch(q)) ..._backupWords,
      };
      final ranked =
          _passages
              .map((p) {
                final l = p.toLowerCase();
                return (p, words.where((w) => l.contains(w)).length.toDouble());
              })
              .where((e) => e.$2 > 0)
              .toList()
            ..sort((a, b) => b.$2.compareTo(a.$2));
      guide.addAll(ranked.take(4).map((e) => e.$1));
    }

    // Assemble in priority order, then trim: guide passages first, then other places, then
    // day-item notes. Never trimmed: the situation, the most relevant places and emergency contacts.
    String assemble(int dayNotes, int otherCount, int guideCount) {
      final parts = <String>[situation];
      if (emergency && emergencyBlock != null) parts.add(emergencyBlock);
      if (relevant.isNotEmpty) {
        parts.add(
          'Most relevant to the question:\n${relevant.map((p) => '- ${_place(p, here, full: true)}').join('\n')}',
        );
      }
      for (final d in days) {
        final n = m.days.indexOf(d) + 1;
        parts.add(
          'Day $n, ${d.date}${d.title != null ? ' "${d.title}"' : ''}:\n${d.items.map((it) => '- ${_item(it, notes: dayNotes)}').join('\n')}',
        );
      }
      if (otherCount > 0 && others.isNotEmpty) {
        parts.add(
          'Other places:\n${others.take(otherCount).map((p) => '- ${_place(p, here)}').join('\n')}',
        );
      }
      if (!emergency && emergencyBlock != null) parts.add(emergencyBlock);
      if (guideCount > 0 && guide.isNotEmpty) {
        parts.add(
          'From the trip guide:\n${guide.take(guideCount).map((p) => '- $p').join('\n')}',
        );
      }
      return parts.join('\n\n');
    }

    var notes = assemble(110, others.length, guide.length);
    for (var g = guide.length - 1; notes.length > budget && g >= 0; g--) {
      notes = assemble(110, others.length, g);
    }
    for (var o = others.length - 1; notes.length > budget && o >= 0; o--) {
      notes = assemble(110, o, 0);
    }
    if (notes.length > budget) notes = assemble(0, 0, 0);
    if (notes.length > budget) notes = '${notes.substring(0, budget - 1)}…';

    final convo = history.isEmpty
        ? ''
        : '\n\nEarlier in this conversation:\n${history.reversed.take(2).toList().reversed.map((t) => 'Q: ${_clip(t.question, 200)}\nA: ${_clip(t.answer, 300)}').join('\n')}';
    // The question both before and after the notes: small models lose track of it otherwise.
    final asked = question.trim();
    return AssistantRequest(
      instructions: emergency
          ? instructions + emergencyInstruction
          : instructions,
      prompt:
          'Question: $asked\n\nTrip notes:\n$notes$convo\n\nQuestion: $asked',
    );
  }

  /// One place as plain sentences (small models copy this text into answers).
  String _place(Place p, LatLon? here, {bool full = false}) {
    final b = StringBuffer(
      '${p.name} (${_categoryLabel[p.category] ?? 'place'})',
    );
    if (here != null) {
      b.write(
        ', about ${_dist(distanceKm(here, LatLon(p.lat, p.lon)))} ${bearing(here, LatLon(p.lat, p.lon))} of the phone',
      );
    }
    b.write('.');
    if (p.phone != null) b.write(' Phone: ${p.phone}.');
    if (p.address != null) {
      b.write(' Address: ${_clip(p.address, full ? 120 : 70)}.');
    }
    final hours = p.raw['hours'] as String?;
    if (hours != null) b.write(' Hours: ${_clip(hours, full ? 120 : 60)}.');
    if (p.notes != null) b.write(' ${_clip(p.notes, full ? 240 : 110)}');
    return b.toString();
  }

  String _item(DayItem it, {int notes = 80}) {
    final p = it.placeId == null ? null : manifest.placesById[it.placeId];
    final time = [it.time, it.endTime].whereType<String>().join('–');
    return '${time.isEmpty ? '' : '$time '}${it.title}${p != null ? ' at ${p.name}' : ''}${it.notes != null && notes > 0 ? ' (${_clip(it.notes, notes)})' : ''}';
  }
}
