import 'dart:math';

import '../models/manifest.dart';
import '../util/today.dart';
import 'engine.dart';
import 'plan_index.dart';

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

/// Added when the model can search the plan itself (Apple Foundation Models tool calling).
const toolInstruction =
    ' The trip notes already include the current time, what\'s next, today\'s schedule and the best matches for the question. '
    'Use the searchPlan tool only to look up something the notes don\'t cover; after searching, answer from the notes and the results together.';

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

/// Extra search words for each kind of question.
const _expand = <String, List<String>>{
  'fuel': ['gas', 'fuel', 'station'],
  'food': ['restaurant', 'cafe', 'meal', 'lunch', 'dinner', 'breakfast'],
  'medical': ['hospital', 'clinic', 'medical', 'emergency', 'urgent', 'er'],
  'lodging': ['lodge', 'hotel', 'check-in', 'stay'],
  'trailhead': ['trail', 'hike', 'trailhead'],
  'transport': ['parking', 'shuttle', 'bus'],
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

/// Splits the page's text into passages of ~450 characters, each labeled with the headings it
/// sits under ("Backup plans › Dec 25 — Wolverton road not plowed yet: Swap the morning…").
/// Headings come from the page's h1–h6/summary tags (marked by [htmlText] as "§N "); text
/// without markers falls back to treating short lines without final punctuation as headings.
List<String> guidePassages(String text) {
  final out = <String>[];
  final marked = text.contains('§');
  final stack = <(int, String)>[];
  final cur = StringBuffer();
  String path() => stack.map((h) => h.$2).join(' › ');
  void flush() {
    final body = cur.toString().trim();
    if (body.length >= 25) out.add(stack.isEmpty ? body : '${path()}: $body');
    cur.clear();
  }

  for (final raw in text.split('\n')) {
    final line = raw.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (line.isEmpty) continue;
    final m = RegExp(r'^§([1-6]) (.*)$').firstMatch(line);
    final heading = m != null
        ? (int.parse(m.group(1)!), m.group(2)!.trim())
        : (!marked &&
              line.length <= 70 &&
              !RegExp(r'[.!?:;)]$').hasMatch(line) &&
              !RegExp(r'^\d').hasMatch(line))
        ? (3, line)
        : null;
    if (heading != null) {
      flush();
      stack.removeWhere((h) => h.$1 >= heading.$1);
      if (heading.$2.isNotEmpty) stack.add(heading);
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
    // Keep heading levels as "§N " markers so passages know which section they're in.
    .replaceAllMapped(
      RegExp(r'<h([1-6])[^>]*>', caseSensitive: false),
      (m) => '\n§${m.group(1)} ',
    )
    .replaceAll(RegExp(r'<summary[^>]*>', caseSensitive: false), '\n§6 ')
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
    : index = PlanIndex.build(manifest.raw, guidePassages(guideText));
  final Manifest manifest;

  /// The whole plan (every manifest key + the page's passages), searchable.
  final PlanIndex index;

  /// Words the question implies but may not say ("fever" → medical, hospital).
  Set<String> expansions(String question) {
    final q = question.toLowerCase();
    final terms = _terms(question);
    return {
      for (final e in _categoryWords.entries)
        if (terms.any((t) => e.value.contains(t))) ...[
          e.key,
          ...?_expand[e.key],
        ],
      if (_backupQuestion.hasMatch(q)) ..._backupWords,
    };
  }

  /// Search results for [query] as text, with distances from [here] when entries have
  /// coordinates. This is also what the assistant's searchPlan tool returns.
  String lookup(
    String query, {
    LatLon? here,
    int limit = 5,
    int maxChars = 1800,
  }) {
    var hits = index.search(
      query,
      limit: max(limit, 10),
      extraTerms: expansions(query),
    );
    if (here != null &&
        RegExp(r'nearest|closest|nearby|near me|close by|how far')
            .hasMatch(query.toLowerCase())) {
      double d(PlanEntry e) => distanceKm(here, LatLon(e.lat!, e.lon!));
      final located = hits.where((h) => h.lat != null).toList()
        ..sort((a, b) => d(a).compareTo(d(b)));
      // A distance question is about places: drop entries without a location when any have one.
      hits = located.isNotEmpty ? located : hits;
    }
    if (hits.isEmpty) return 'Nothing in the trip plan matches "$query".';
    final b = StringBuffer();
    for (final h in hits.take(limit)) {
      final where = here != null && h.lat != null
          ? ' — about ${_dist(distanceKm(here, LatLon(h.lat!, h.lon!)))} ${bearing(here, LatLon(h.lat!, h.lon!))} of the phone'
          : '';
      final line =
          '- ${h.source.replaceFirst(RegExp(r'^(plan|page): '), '')}$where: ${_clip(h.text, 420)}\n';
      if (b.length + line.length > maxChars) break;
      b.write(line);
    }
    return b.toString().trimRight();
  }

  /// What the searchPlan tool returns: matches plus a reminder that the notes still apply
  /// (small models otherwise answer from the last tool result alone).
  String toolResult(String query, {LatLon? here}) =>
      '${lookup(query, here: here)}\n(More matches from the plan. The trip notes you were given still apply.)';

  /// The request for [question]. With [toolAvailable] (Apple) the notes are shorter and the
  /// model can search the plan itself; otherwise (Gemini Nano) search results are pre-filled.
  AssistantRequest build(
    String question, {
    LatLon? here,
    DateTime? now,
    List<Turn> history = const [],
    int budget = 7000,
    bool toolAvailable = false,
  }) {
    final m = manifest;
    final q = question.toLowerCase();
    final urgent = RegExp(
      r'emergenc|911|112|999|\bhelp\b|accident|\blost\b|rescue|hurt|injur|bleed|fever|breath|unconscious|'
      r'allerg|chest pain|fell|broken|bitten|bite|sting|hypotherm|frostbite|crash|stuck|stranded|missing',
    ).hasMatch(q);
    final aboutTime = RegExp(
      r'next|now|today|tomorrow|tonight|morning|afternoon|evening|when|time|schedule|plan|day|late|early|leave|left',
    ).hasMatch(q);

    // 1. Situation (computed: the model can't do time zones or "now").
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

    // 2. Schedule: today (or day 1 before the trip); tomorrow for time/plan questions; named days.
    final days = <Day>[];
    final idx = tv.day == null
        ? -1
        : m.days.indexWhere((d) => d.date == tv.day!.date);
    if (idx >= 0) {
      days.add(m.days[idx]);
      if (aboutTime && idx + 1 < m.days.length) days.add(m.days[idx + 1]);
    }
    for (final mm in RegExp(r'day\s*(\d+)').allMatches(q)) {
      final n = int.parse(mm.group(1)!) - 1;
      if (n >= 0 && n < m.days.length && !days.contains(m.days[n])) {
        days.add(m.days[n]);
      }
    }

    // 3. From the whole plan: urgent help first, then what the question is about.
    final urgentHits = urgent
        ? lookup(
            'emergency hospital medical clinic phone',
            here: here,
            limit: 3,
            maxChars: 1200,
          )
        : '';

    String assemble(int dayNotes, int foundChars) {
      final parts = <String>[situation];
      if (urgentHits.isNotEmpty) {
        parts.add('Emergency help from the plan:\n$urgentHits');
      }
      final f = foundChars > 0
          ? lookup(
              question,
              here: here,
              limit: toolAvailable ? 4 : 5,
              maxChars: foundChars,
            )
          : '';
      if (f.isNotEmpty) {
        parts.add('From the plan, most relevant to the question:\n$f');
      }
      for (final d in days) {
        final n = m.days.indexOf(d) + 1;
        parts.add(
          'Day $n, ${d.date}${d.title != null ? ' "${d.title}"' : ''}:\n${d.items.map((it) => '- ${_item(it, notes: dayNotes)}').join('\n')}',
        );
      }
      return parts.join('\n\n');
    }

    // With the tool, leave room in the context for its results.
    final limit = toolAvailable ? min(budget, 4500) : budget;
    var foundChars = toolAvailable ? 1800 : 3800;
    var notes = assemble(110, foundChars);
    while (notes.length > limit && foundChars > 600) {
      foundChars -= 600;
      notes = assemble(110, foundChars);
    }
    if (notes.length > limit) notes = assemble(0, foundChars);
    if (notes.length > limit) notes = '${notes.substring(0, limit - 1)}…';

    final convo = history.isEmpty
        ? ''
        : '\n\nEarlier in this conversation:\n${history.reversed.take(2).toList().reversed.map((t) => 'Q: ${_clip(t.question, 200)}\nA: ${_clip(t.answer, 300)}').join('\n')}';
    // The question both before and after the notes: small models lose track of it otherwise.
    final asked = question.trim();
    var ins = urgent ? instructions + emergencyInstruction : instructions;
    if (toolAvailable) ins += toolInstruction;
    return AssistantRequest(
      instructions: ins,
      prompt:
          'Question: $asked\n\nTrip notes:\n$notes$convo\n\nQuestion: $asked',
      tools: toolAvailable,
    );
  }

  String _item(DayItem it, {int notes = 80}) {
    final p = it.placeId == null ? null : manifest.placesById[it.placeId];
    final time = [it.time, it.endTime].whereType<String>().join('–');
    return '${time.isEmpty ? '' : '$time '}${it.title}${p != null ? ' at ${p.name}' : ''}${it.notes != null && notes > 0 ? ' (${_clip(it.notes, notes)})' : ''}';
  }
}
