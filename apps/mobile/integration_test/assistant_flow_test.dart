// The offline assistant end to end with the device's real model (Apple Foundation Models on
// iOS/macOS, Gemini Nano on Android): prints ANSWER lines and SHOT markers.
//   node tool/screenshots.mjs macos <out> --test integration_test/assistant_flow_test.dart --fake-now 2026-12-24T11:05:00-08:00
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:provider/provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:waypack/main.dart';

const email = String.fromEnvironment(
  'TEST_EMAIL',
  defaultValue: 'dev@waypack.test',
);

Future<void> settle(WidgetTester t, [int ms = 1500]) async {
  for (var i = 0; i < ms ~/ 100; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

Future<void> until(WidgetTester t, Finder f, {int seconds = 90}) async {
  for (var i = 0; i < seconds * 10 && f.evaluate().isEmpty; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
  expect(f, findsWidgets, reason: 'waited ${seconds}s for $f');
}

Future<void> shot(WidgetTester t, String name) async {
  await settle(t, 800);
  // ignore: avoid_print
  print('SHOT:$name');
  await settle(t, 2500);
}

/// Waits for the current answer to finish and returns its text.
Future<String> answer(WidgetTester t) async {
  await settle(t, 500);
  await until(
    t,
    find.byTooltip('Ask'),
    seconds: 120,
  ); // the Stop button turns back into Ask
  await settle(t, 300);
  final texts = find
      .byType(SelectableText)
      .evaluate()
      .map((e) => (e.widget as SelectableText).data ?? '')
      .toList();
  return texts.isEmpty ? '' : texts.last;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('assistant', (t) async {
    final state = await bootstrap();
    if (Supabase.instance.client.auth.currentSession != null) {
      await state.signOut();
    }
    for (final e in [...state.upcoming, ...state.past]) {
      await state.store.deleteLocal(e.id);
    }
    await t.pumpWidget(
      ChangeNotifierProvider.value(value: state, child: const WaypackApp()),
    );
    await settle(t);
    await t.enterText(find.byKey(const Key('dev-email')), email);
    await t.tap(find.text('Dev sign-in'));
    await until(t, find.byTooltip('Not downloaded'));
    await t.tap(find.byTooltip('Not downloaded').first);
    await until(t, find.byTooltip('Available offline'));
    await t.tap(find.byTooltip('Available offline').first);
    await settle(t, 3000);
    await t.tap(find.byTooltip('Waypack menu'));
    await settle(t);
    await t.tap(find.text('Ask'));
    await settle(t, 2500);
    if (find.text('Not available on this device yet').evaluate().isNotEmpty) {
      // ignore: avoid_print
      print(
        'ANSWER[unsupported]: ${find.textContaining('.').evaluate().map((e) => (e.widget as Text).data).join(' ')}',
      );
      await shot(t, 'ai-0-unsupported');
      return;
    }
    await shot(t, 'ai-1-start');

    await t.tap(find.text('What\'s next?'));
    final a1 = await answer(t);
    // ignore: avoid_print
    print('ANSWER[next]: $a1');
    expect(a1.trim().length, greaterThan(10));
    await shot(t, 'ai-2-next');

    for (final q in [
      'What\'s the phone number for Wuksachi Lodge?',
      'Where can we get gas, and is there any in the park?',
      'What\'s plan B if Wolverton is closed?',
    ]) {
      // Set the field directly: simulated typing into a field the app just cleared is
      // unreliable in macOS integration tests (a real keyboard is fine).
      final field =
          find.byKey(const Key('assistant-input')).evaluate().first.widget
              as TextField;
      field.controller!.text = q;
      await settle(t, 300);
      await t.tap(find.byTooltip('Ask'));
      await until(t, find.widgetWithText(Align, q), seconds: 10);
      final a = await answer(t);
      // ignore: avoid_print
      print('ANSWER[$q]: $a');
      expect(a.trim().length, greaterThan(10));
    }
    await shot(t, 'ai-3-more');
  });
}
