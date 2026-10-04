import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:waypack/assistant/context.dart';
import 'package:waypack/assistant/engine.dart';
import 'package:waypack/assistant/plan_index.dart';
import 'package:waypack/models/manifest.dart';

Manifest tahoe() => Manifest(
  jsonDecode(
    File('../../examples/tahoe-winter/manifest.json').readAsStringSync(),
  ) as Map<String, dynamic>,
);
String tahoeGuide() =>
    htmlText(File('../../examples/tahoe-winter/index.html').readAsStringSync());

/// Sat Jan 16 2027 10:50 in Tahoe (mid-gondola).
final duringTrip = DateTime.parse('2027-01-16T10:50:00-08:00');
const placerville = LatLon(38.7296, -120.7985);
const southLake = LatLon(38.9567, -119.9421);

class FakeEngine implements AssistantEngine {
  FakeEngine(this.s, [this.answer = 'ok']);
  final EngineStatus s;
  final String answer;
  AssistantRequest? last;
  @override
  Future<EngineStatus> status() async => s;
  @override
  Stream<double> download() => const Stream.empty();
  @override
  Stream<String> generate(AssistantRequest r, {SearchPlan? search}) {
    last = r;
    return Stream.fromIterable([answer.substring(0, 2), answer]);
  }

  @override
  Future<void> cancel() async {}
}

void main() {
  setUpAll(tzdata.initializeTimeZones);

  group('trip brief', () {
    final brief = TripBrief(tahoe(), guideText: tahoeGuide());
    String found(AssistantRequest r) => r.prompt
        .split('From the plan, most relevant to the question:\n')[1]
        .split('\n\n')
        .first;

    test('situation: now and next in the trip time zone', () {
      final r = brief.build('What\'s next?', now: duringTrip);
      expect(
        r.prompt,
        contains(
          'Right now: 2027-01-16 10:50 (trip time zone America/Los_Angeles)',
        ),
      );
      expect(r.prompt, contains('Happening now: 10:45–12:45 Heavenly Gondola'));
      expect(r.prompt, contains('Next: '));
      expect(r.prompt, contains('Day 1, 2027-01-16'));
      expect(
        r.prompt,
        contains('Day 2, '),
        reason: 'tomorrow is included for time questions',
      );
      expect(r.prompt, startsWith('Question: What\'s next?'));
      expect(r.prompt.trim(), endsWith('Question: What\'s next?'));
      expect(
        r.instructions,
        contains('using only the facts in the trip notes'),
      );
      expect(r.tools, isFalse);
    });

    test(
      'nearest gas: the closest fuel entry first, with distance and direction',
      () {
        final r = brief.build(
          'Where is the nearest gas station?',
          here: placerville,
          now: duringTrip,
        );
        final first = found(r).split('\n').first;
        expect(first.toLowerCase(), contains('fuel'));
        expect(first, matches(RegExp(r'about [\d.]+ (mi|m)')));
        expect(first, matches(RegExp(r' (N|NE|E|SE|S|SW|W|NW) of the phone')));
      },
    );

    test('emergency: help from the plan right after the situation', () {
      final r = brief.build(
        'My kid is hurt, where is the hospital?',
        here: southLake,
        now: duringTrip,
      );
      expect(
        r.prompt.indexOf('Emergency help from the plan:'),
        greaterThan(r.prompt.indexOf('Right now:')),
      );
      expect(
        r.prompt.indexOf('Emergency help from the plan:'),
        lessThan(r.prompt.indexOf('From the plan, most relevant')),
      );
      expect(r.prompt, contains('911'));
      expect(
        r.prompt.split('Emergency help from the plan:\n')[1].toLowerCase(),
        contains('medical'),
      );
      expect(r.instructions, contains('emergency question'));
    });

    test(
      'a named place leads, with its phone number; tomorrow is left out',
      () {
        final r = brief.build(
          'What\'s the phone number for Heavenly Village?',
          now: duringTrip,
        );
        expect(found(r).split('\n').first.toLowerCase(), contains('heavenly'));
        expect(r.prompt, isNot(contains('Day 2, ')));
      },
    );

    test('page passages are searched too (with their section headings)', () {
      final r = brief.build(
        'Do we need chains for Echo Summit?',
        now: duringTrip,
      );
      expect(found(r).toLowerCase(), contains('chain'));
    });

    test('plan B questions find backup plans', () {
      final r = brief.build(
        'What\'s plan B if the gondola is closed?',
        now: duringTrip,
      );
      expect(
        found(r).toLowerCase(),
        anyOf(contains('backup'), contains('plan b'), contains('instead')),
      );
    });

    test(
      '"where\'s the hospital" is not an emergency; "someone is bleeding" is',
      () {
        expect(
          brief.build('How far is the hospital?', now: duringTrip).instructions,
          isNot(contains('emergency question')),
        );
        expect(
          brief
              .build('Someone is bleeding, help', now: duringTrip)
              .instructions,
          contains('emergency question'),
        );
      },
    );

    test('with tool calling: shorter notes, the search tool offered', () {
      final r = brief.build(
        'Tell me about every restaurant and hike and the hospital',
        here: southLake,
        now: duringTrip,
        toolAvailable: true,
      );
      expect(r.tools, isTrue);
      expect(r.instructions, contains('searchPlan'));
      final notes = r.prompt
          .split('Trip notes:\n')[1]
          .split('\n\nQuestion:')
          .first;
      expect(notes.length, lessThanOrEqualTo(4500));
    });

    test('asking about a specific day includes it', () {
      final r = brief.build('What do we do on day 3?', now: duringTrip);
      expect(r.prompt, contains('Day 3, '));
    });

    test('stays within the budget (fits a ~4k-token on-device model)', () {
      for (final q in [
        'What\'s next?',
        'Tell me everything about food, gas, hikes, lodging, parking, views and the hospital',
        'day 1 day 2 day 3',
      ]) {
        final r = brief.build(
          q,
          here: southLake,
          now: duringTrip,
          budget: 7000,
        );
        final notes = r.prompt
            .split('Trip notes:\n')[1]
            .split('\n\nQuestion:')
            .first;
        expect(notes.length, lessThanOrEqualTo(7000), reason: q);
        expect(
          (r.instructions.length + r.prompt.length) / 4,
          lessThan(2400),
          reason: '~tokens for: $q',
        );
      }
    });

    test('follow-ups carry the last two exchanges, trimmed', () {
      final r = brief.build(
        'And after that?',
        now: duringTrip,
        history: const [Turn('a', '1'), Turn('b', '2'), Turn('c', '3')],
      );
      expect(
        r.prompt,
        contains('Earlier in this conversation:\nQ: b\nA: 2\nQ: c\nA: 3'),
      );
      expect(r.prompt, isNot(contains('Q: a')));
    });

    test('before the trip: says how many days to go', () {
      final r = brief.build(
        'What\'s next?',
        now: DateTime.parse('2027-01-10T09:00:00-08:00'),
      );
      expect(r.prompt, contains('The trip starts in 6 day(s).'));
    });
  });

  group('plan index (any keys the agent used)', () {
    final raw = jsonDecode(
      File('../../examples/tahoe-winter/manifest.json').readAsStringSync(),
    ) as Map<String, dynamic>;
    // Keys the app has never heard of.
    raw['tide_times'] = {'2027-01-16': 'High 06:12, low 12:40 at Zephyr Cove'};
    raw['ski_passes'] = [
      {
        'name': 'Heavenly sightseeing ticket',
        'price': '\$79 adult',
        'where': 'Gondola ticket windows or online',
      },
    ];
    raw['packing_extras'] = 'Bring the red sled from the garage';
    final brief = TripBrief(Manifest(raw), guideText: tahoeGuide());

    test('unknown keys are searchable like everything else', () {
      expect(brief.lookup('when is low tide'), contains('12:40'));
      expect(
        brief.lookup('how much is the sightseeing ticket'),
        contains('\$79'),
      );
      expect(brief.lookup('which sled should we bring'), contains('red sled'));
    });
    test('ids and raw coordinates are left out of entries', () {
      final text = brief.index.entries.map((e) => e.text).join('\n');
      expect(text, isNot(matches(RegExp(r'\blat -?\d'))));
      expect(text, isNot(contains('place id ')));
    });
    test('entries with coordinates (any key spelling) get distances', () {
      final idx = PlanIndex.build({
        'spots': [
          {'title': 'Secret beach', 'latitude': 38.95, 'longitude': -119.95},
        ],
      }, const []);
      expect(idx.entries.single.lat, 38.95);
      expect(
        TripBrief(
          Manifest({
            'title': 'x',
            'timezone': 'UTC',
            'start_date': '2027-01-01',
            'end_date': '2027-01-02',
            'spots': [
              {
                'title': 'Secret beach',
                'latitude': 38.95,
                'longitude': -119.95,
              },
            ],
          }),
        ).lookup('how far is the secret beach', here: southLake),
        contains('of the phone'),
      );
    });
    test('page passages keep their section path', () {
      final p = guidePassages(
        htmlText(
          '<h2>Backup plans</h2><h3>If it storms</h3><p>Swap the gondola for the museum and lunch at the lodge.</p>',
        ),
      );
      expect(p, [
        'Backup plans › If it storms: Swap the gondola for the museum and lunch at the lodge.',
      ]);
    });
  });

  group('engine selection', () {
    test('picks the first usable engine', () async {
      final a = FakeEngine(
        const EngineStatus(
          engine: 'apple-foundation',
          state: EngineState.available,
        ),
      );
      final (e, s) = await AssistantEngines.pick([a]);
      expect(e, same(a));
      expect(s.label, 'Apple Intelligence, on this device');
    });
    test('a downloadable model is offered, not hidden', () async {
      final g = FakeEngine(
        const EngineStatus(
          engine: 'gemini-nano',
          state: EngineState.downloadable,
        ),
      );
      final (e, s) = await AssistantEngines.pick([g]);
      expect(e, same(g));
      expect(s.state, EngineState.downloadable);
    });
    test(
      'falls through to a later engine (e.g. a future LiteRT/Qwen one)',
      () async {
        final native = FakeEngine(
          const EngineStatus(
            engine: 'gemini-nano',
            state: EngineState.unavailable,
            reason: 'unsupportedDevice',
          ),
        );
        final later = FakeEngine(
          const EngineStatus(
            engine: 'litert-qwen',
            state: EngineState.downloadable,
          ),
        );
        final (e, _) = await AssistantEngines.pick([native, later]);
        expect(e, same(later));
      },
    );
    test(
      'nothing usable: unsupported, keeping the most helpful reason',
      () async {
        final (e, s) = await AssistantEngines.pick([
          FakeEngine(
            const EngineStatus(
              engine: 'apple-foundation',
              state: EngineState.unavailable,
              reason: 'appleIntelligenceNotEnabled',
            ),
          ),
        ]);
        expect(e, isA<UnsupportedEngine>());
        expect(s.explanation, contains('Turn on Apple Intelligence'));
        expect(
          e.generate(const AssistantRequest(instructions: '', prompt: '')),
          emitsError(isA<AssistantException>()),
        );
      },
    );
  });

  group('native channel protocol', () {
    TestWidgetsFlutterBinding.ensureInitialized();
    const methods = MethodChannel('test/assistant');
    const events = EventChannel('test/assistant/events');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

    test('status, streamed cumulative text, done', () async {
      MockStreamHandlerEventSink? sink;
      messenger.setMockStreamHandler(
        events,
        MockStreamHandler.inline(onListen: (_, s) => sink = s),
      );
      messenger.setMockMethodCallHandler(methods, (call) async {
        if (call.method == 'status') {
          return {'engine': 'apple-foundation', 'state': 'available'};
        }
        if (call.method == 'generate') {
          final id = (call.arguments as Map)['id'];
          expect((call.arguments as Map)['instructions'], 'be brief');
          Future.microtask(() {
            sink!.success({'id': id, 'type': 'text', 'text': 'Carson'});
            sink!.success({'id': 'other', 'type': 'text', 'text': 'not mine'});
            sink!.success({'id': id, 'type': 'text', 'text': 'Carson City.'});
            sink!.success({'id': id, 'type': 'done', 'text': 'Carson City.'});
          });
        }
        return null;
      });
      final engine = NativeAssistantEngine(methods: methods, events: events);
      expect((await engine.status()).state, EngineState.available);
      final out = await engine
          .generate(
            const AssistantRequest(
              instructions: 'be brief',
              prompt: 'capital?',
            ),
          )
          .toList();
      expect(out, ['Carson', 'Carson City.', 'Carson City.']);
    });

    test('errors become AssistantException with a code', () async {
      MockStreamHandlerEventSink? sink;
      messenger.setMockStreamHandler(
        events,
        MockStreamHandler.inline(onListen: (_, s) => sink = s),
      );
      messenger.setMockMethodCallHandler(methods, (call) async {
        if (call.method == 'generate') {
          final id = (call.arguments as Map)['id'];
          Future.microtask(
            () => sink!.success({
              'id': id,
              'type': 'error',
              'code': 'context',
              'message': 'too long',
            }),
          );
        }
        return null;
      });
      final engine = NativeAssistantEngine(methods: methods, events: events);
      await expectLater(
        engine.generate(const AssistantRequest(instructions: '', prompt: 'x')),
        emitsError(
          isA<AssistantException>().having((e) => e.code, 'code', 'context'),
        ),
      );
    });

    test(
      'no native side (e.g. Linux, tests): unavailable, not a crash',
      () async {
        final engine = NativeAssistantEngine(
          methods: const MethodChannel('nobody/home'),
          events: events,
        );
        final s = await engine.status();
        expect(s.state, EngineState.unavailable);
        expect(s.reason, 'noEngine');
      },
    );
  });
}
