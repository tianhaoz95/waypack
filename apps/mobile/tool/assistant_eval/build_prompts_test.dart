// Builds the exact assistant requests for tool/assistant_eval/cases.json (run by run.sh).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:waypack/assistant/context.dart';
import 'package:waypack/models/manifest.dart';

void main() {
  test('build prompts', () {
    tzdata.initializeTimeZones();
    final out = Platform.environment['EVAL_OUT']!;
    final cases = jsonDecode(File('tool/assistant_eval/cases.json').readAsStringSync()) as List;
    for (var i = 0; i < cases.length; i++) {
      final c = cases[i] as Map;
      final dir = '../../examples/${c['trip']}';
      final m = Manifest(jsonDecode(File('$dir/manifest.json').readAsStringSync()) as Map<String, dynamic>);
      final b = TripBrief(m, guideText: htmlText(File('$dir/index.html').readAsStringSync()));
      final here = c['here'] as List?;
      final r = b.build(
        c['q'] as String,
        now: DateTime.parse(c['now'] as String),
        here: here == null ? null : LatLon((here[0] as num).toDouble(), (here[1] as num).toDouble()),
      );
      File('$out/$i.instructions').writeAsStringSync(r.instructions);
      File('$out/$i.prompt').writeAsStringSync(r.prompt);
    }
  });
}
