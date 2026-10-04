import 'dart:math';

/// Everything in a trip plan, searchable (DECISIONS #52).
///
/// The manifest is walked generically: every key the agent used, known to the app or not, becomes
/// part of a readable entry ("places › Wuksachi Lodge: category lodging; phone +1-559-…"), so the
/// assistant never depends on a predefined set of fields. The page's text adds passages (each with
/// the heading it sits under). Search is BM25 over words, with names counting extra.
class PlanEntry {
  PlanEntry(this.source, this.text, [this.lat, this.lon]);

  /// e.g. "plan: places › Wuksachi Lodge" or "page: Backup plans"
  final String source;
  final String text;

  /// Coordinates, when the entry had any (whatever the keys were called).
  final double? lat;
  final double? lon;

  @override
  String toString() => '$source — $text';
}

class PlanIndex {
  PlanIndex._(this.entries) {
    for (final e in entries) {
      // Names and headings count double: they say what an entry is about.
      final toks = _tokens('${e.source} ${e.source} ${e.text}');
      _docTokens.add(toks);
      for (final t in toks.toSet()) {
        _df[t] = (_df[t] ?? 0) + 1;
      }
    }
    _avgLen = _docTokens.isEmpty
        ? 1
        : _docTokens.map((d) => d.length).reduce((a, b) => a + b) /
              _docTokens.length;
  }

  final List<PlanEntry> entries;
  final _docTokens = <List<String>>[];
  final _df = <String, int>{};
  late final double _avgLen;

  /// [manifest]: the trip's manifest.json as parsed JSON. [passages]: the page's text passages.
  factory PlanIndex.build(
    Map<String, dynamic> manifest,
    List<String> passages,
  ) {
    final out = <PlanEntry>[];
    // Short top-level values (title, dates) together; longer ones (summary, notes) on their own.
    final top = <String>[];
    for (final MapEntry(:key, :value) in manifest.entries) {
      if (_skipKeys.contains(key)) continue;
      if (value is List) {
        for (var i = 0; i < value.length; i++) {
          final v = value[i];
          final label = v is Map ? _label(v) ?? '#${i + 1}' : '#${i + 1}';
          // Long lists inside an entry (a day's items) get their own entries too.
          if (v is Map) {
            final nested = v.entries
                .where((e) => e.value is List && (e.value as List).length > 3)
                .toList();
            out.add(
              PlanEntry(
                'plan: ${_words(key)} › $label',
                _describe(
                  Map.fromEntries(v.entries.where((e) => !nested.contains(e))),
                ),
                _coords(v).$1,
                _coords(v).$2,
              ),
            );
            for (final n in nested) {
              final items = n.value as List;
              for (var j = 0; j < items.length; j++) {
                out.add(
                  PlanEntry(
                    'plan: ${_words(key)} › $label › ${_words(n.key)}',
                    _describe(items[j]),
                  ),
                );
              }
            }
          } else {
            out.add(PlanEntry('plan: ${_words(key)}', _describe(v)));
          }
        }
      } else if (value is Map) {
        final d = _describe(value);
        if (d.length <= 600) {
          out.add(PlanEntry('plan: ${_words(key)}', d));
        } else {
          for (final e in value.entries) {
            out.add(
              PlanEntry(
                'plan: ${_words(key)} › ${_words(e.key)}',
                _describe(e.value),
              ),
            );
          }
        }
      } else if (value != null && '$value'.isNotEmpty) {
        final text = '$value';
        if (text.length <= 80) {
          top.add('${_words(key)}: $text');
        } else {
          out.add(PlanEntry('plan: ${_words(key)}', text));
        }
      }
    }
    if (top.isNotEmpty) out.insert(0, PlanEntry('plan: trip', top.join('; ')));
    for (final p in passages) {
      final i = p.indexOf(': ');
      final heading = i > 0 && i < 70 ? p.substring(0, i) : 'trip page';
      out.add(
        PlanEntry('page: $heading', i > 0 && i < 70 ? p.substring(i + 2) : p),
      );
    }
    return PlanIndex._(out);
  }

  /// Best matches for [query], most relevant first.
  List<PlanEntry> search(
    String query, {
    int limit = 5,
    Set<String> extraTerms = const {},
  }) {
    final q = {
      ..._tokens(query),
      ...extraTerms.expand(_tokens),
    }.where((t) => !_stop.contains(t)).toSet();
    if (q.isEmpty) return const [];
    final n = entries.length;
    final scores = <(int, double)>[];
    final ql = query.toLowerCase();
    for (var i = 0; i < n; i++) {
      final doc = _docTokens[i];
      var s = 0.0;
      for (final t in q) {
        final tf = doc.where((x) => x == t).length;
        if (tf == 0) continue;
        final idf = log(1 + (n - (_df[t] ?? 0) + 0.5) / ((_df[t] ?? 0) + 0.5));
        s +=
            idf *
            (tf * 2.2) /
            (tf + 1.2 * (0.25 + 0.75 * doc.length / _avgLen));
      }
      // An entry whose name the question spells out is what the question is about.
      final name = entries[i].source.split('›').last.trim().toLowerCase();
      if (name.length > 3 && ql.contains(name)) s += 6;
      if (s > 0) scores.add((i, s));
    }
    scores.sort((a, b) => b.$2.compareTo(a.$2));
    return scores.take(limit).map((e) => entries[e.$1]).toList();
  }

  /// Search results as text for a model (a tool result or prompt notes), within [maxChars].
  String lookup(
    String query, {
    int limit = 5,
    int maxChars = 1800,
    Set<String> extraTerms = const {},
  }) {
    final hits = search(query, limit: limit, extraTerms: extraTerms);
    if (hits.isEmpty) return 'Nothing in the trip plan matches "$query".';
    final b = StringBuffer();
    for (final h in hits) {
      final line =
          '- ${h.source.replaceFirst(RegExp(r'^(plan|page): '), '')}: ${h.text}\n';
      if (b.length + line.length > maxChars) break;
      b.write(line);
    }
    return b.toString().trimRight();
  }
}

/// Keys that are bulky or meaningless as text (route geometry, ids the model can't use).
const _skipKeys = {'schema_version', 'sdk_version', 'trip_id'};

/// lat/lon under any of the usual spellings.
(double?, double?) _coords(Map v) {
  num? pick(List<String> ks) {
    for (final k in ks) {
      if (v[k] is num) return v[k] as num;
    }
    return null;
  }

  final lat = pick(['lat', 'latitude']);
  final lon = pick(['lon', 'lng', 'longitude']);
  return lat == null || lon == null
      ? (null, null)
      : (lat.toDouble(), lon.toDouble());
}

String? _label(Map v) {
  for (final k in ['name', 'title', 'label', 'date', 'id']) {
    final x = v[k];
    if (x is String && x.isNotEmpty) return x;
  }
  return null;
}

final _hiddenKey = RegExp(
  r'^(id|.*_id|lat|lon|lng|latitude|longitude|bbox|geometry)$',
);

/// "start_date" → "start date".
String _words(String key) => key.replaceAll('_', ' ');

/// A JSON value as compact prose, skipping coordinates lists and geometry.
String _describe(Object? v, [int depth = 0]) {
  if (v == null) return '';
  if (v is String) return v;
  if (v is num || v is bool) return '$v';
  if (v is List) {
    if (v.isNotEmpty && v.every((x) => x is num)) {
      return v.length <= 4 ? v.join(', ') : '';
    }
    if (v.isNotEmpty && v.every((x) => x is List)) {
      return ''; // coordinate arrays
    }
    return v
        .map((x) => _describe(x, depth + 1))
        .where((s) => s.isNotEmpty)
        .join(depth == 0 ? '; ' : ', ');
  }
  if (v is Map) {
    if (v['type'] == 'LineString' || v['coordinates'] != null) {
      return ''; // GeoJSON
    }
    final parts = <String>[];
    for (final e in v.entries) {
      // Ids and raw coordinates are noise to a reader (distances are computed separately).
      if (_hiddenKey.hasMatch('${e.key}')) continue;
      final d = _describe(e.value, depth + 1);
      if (d.isEmpty) continue;
      parts.add('${_words('${e.key}')} $d');
    }
    return depth == 0 ? parts.join('; ') : '(${parts.join(', ')})';
  }
  return '$v';
}

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
  'any',
  'our',
  'we',
  'you',
  'is',
  'do',
  'does',
  'have',
  'has',
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
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'at',
  'it',
  'me',
  'my',
  'us',
  'be',
  'or',
  'if',
  'was',
  'will',
  'i',
  'its',
  "what's",
  "where's",
  'whats',
  'wheres',
  'tell',
};

List<String> _tokens(String s) =>
    RegExp(r"[a-z0-9][a-z0-9'+-]*")
        .allMatches(s.toLowerCase())
        .map((m) => _stem(m.group(0)!.replaceAll("'s", '')))
        .where((t) => t.length >= 2)
        .toList();

/// Light plural/verb folding so "hotels"/"hotel", "closed"/"close" match.
String _stem(String w) {
  if (w.length > 4 && w.endsWith('ies')) {
    return '${w.substring(0, w.length - 3)}y';
  }
  if (w.length > 4 && w.endsWith('ing')) return w.substring(0, w.length - 3);
  if (w.length > 3 && w.endsWith('ed')) return w.substring(0, w.length - 2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) {
    return w.substring(0, w.length - 1);
  }
  return w;
}
