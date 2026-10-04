// The offline assistant's quality check, run inside the app against the device's real model
// (Apple Foundation Models with the searchPlan tool; with EVAL_TOOLS=false, pre-filled search
// results only, which is what Gemini Nano gets). tool/assistant_eval/run.sh serves the example
// trips + cases.json over HTTP (the app is sandboxed).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:waypack/assistant/context.dart';
import 'package:waypack/assistant/engine.dart';
import 'package:waypack/models/manifest.dart';

const evalUrl = String.fromEnvironment('EVAL_URL');
const evalTools = bool.fromEnvironment('EVAL_TOOLS', defaultValue: true);

Future<String> fetch(String path) async {
  final c = HttpClient();
  try {
    final res = await (await c.getUrl(Uri.parse('$evalUrl/$path'))).close();
    return await utf8.decodeStream(res);
  } finally {
    c.close();
  }
}

// ignore: avoid_print
void say(String s) => print('EVAL $s');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('assistant eval', (t) async {
    tzdata.initializeTimeZones();
    final (engine, status) = await AssistantEngines.pick();
    say(
      'engine=${status.engine} state=${status.state.name} tools=${status.tools}',
    );
    if (status.state != EngineState.available) return;
    final tools = status.tools && evalTools;
    say('mode: ${tools ? 'tool calling' : 'pre-filled search results'}');

    final cases = (jsonDecode(
      await fetch('apps/mobile/tool/assistant_eval/cases.json'),
    ) as List).cast<Map>();
    final briefs = <String, TripBrief>{};
    var pass = 0, toolCalls = 0;
    for (final c in cases) {
      final trip = c['trip'] as String;
      // "add": keys the app knows nothing about, merged into the plan (any key must be usable).
      final add = c['add'] as Map?;
      final key = add == null ? trip : '$trip+';
      if (!briefs.containsKey(key)) {
        final raw = jsonDecode(
          await fetch('examples/$trip/manifest.json'),
        ) as Map<String, dynamic>;
        if (add != null) raw.addAll(add.cast<String, dynamic>());
        briefs[key] = TripBrief(
          Manifest(raw),
          guideText: htmlText(await fetch('examples/$trip/index.html')),
        );
      }
      final brief = briefs[key]!;
      final here = c['here'] as List?;
      final loc = here == null
          ? null
          : LatLon((here[0] as num).toDouble(), (here[1] as num).toDouble());
      final q = c['q'] as String;
      final req = brief.build(
        q,
        here: loc,
        now: DateTime.parse(c['now'] as String),
        toolAvailable: tools,
      );

      final searches = <String>[];
      Future<String> search(String query) async {
        searches.add(query);
        return brief.toolResult(query, here: loc);
      }

      var answer = '';
      try {
        await for (final text in engine.generate(
          req,
          search: tools ? search : null,
        )) {
          answer = text;
        }
      } on AssistantException catch (e) {
        answer = 'ERROR ${e.code}: ${e.message}';
      }
      toolCalls += searches.length;
      final ok = (c['expect'] as List).every(
        (e) => answer.toLowerCase().contains('$e'.toLowerCase()),
      );
      if (ok) pass++;
      say(
        '${ok ? '✓' : '✗'} [$trip${add == null ? '' : ' + extra keys'}] $q${searches.isEmpty ? '' : '  (searched: ${searches.join(' | ')})'}',
      );
      say('    ${answer.replaceAll('\n', ' ')}');
      if (!ok) {
        say(
          '    notes sent: ${req.prompt.split('Trip notes:\n').last.split('\n\nQuestion:').first.replaceAll('\n', ' / ')}',
        );
      }
    }
    say('$pass/${cases.length} passed, $toolCalls tool call(s)');
    expect(pass, cases.length);
  });
}
