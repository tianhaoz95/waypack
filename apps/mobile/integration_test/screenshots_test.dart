// Walks the main screens and prints `SHOT:<name>` markers; tool/screenshots.mjs captures
// the simulator screen at each marker (so WebView content is included).
//   node tool/screenshots.mjs <simulator-udid> <out-dir>
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:provider/provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:waypack/main.dart';

const email = String.fromEnvironment('TEST_EMAIL', defaultValue: 'dev@waypack.test');

Future<void> settle(WidgetTester t, [int ms = 1500]) async {
  for (var i = 0; i < ms ~/ 100; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

Future<void> shot(WidgetTester t, String name, {int waitMs = 1200}) async {
  await settle(t, waitMs);
  // ignore: avoid_print
  print('SHOT:$name');
  await settle(t, 2500); // host captures during this window
}

Future<void> until(WidgetTester t, Finder f) async {
  for (var i = 0; i < 300 && f.evaluate().isEmpty; i++) {
    await t.pump(const Duration(milliseconds: 300));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('screenshots', (t) async {
    final state = await bootstrap();
    if (Supabase.instance.client.auth.currentSession != null) await state.signOut();
    for (final e in [...state.upcoming, ...state.past]) {
      await state.store.deleteLocal(e.id);
    }
    await t.pumpWidget(ChangeNotifierProvider.value(value: state, child: const WaypackApp()));
    await shot(t, '01-sign-in');

    await t.enterText(find.byKey(const Key('dev-email')), email);
    await t.tap(find.text('Dev sign-in'));
    await until(t, find.text('Not downloaded'));
    await shot(t, '03-trips-not-downloaded');

    await t.tap(find.text('Download'));
    await until(t, find.text('Available offline'));
    await shot(t, '04-trips-offline');

    await t.tap(find.text('Open'));
    await shot(t, '05-trip-bundle', waitMs: 6000);

    await t.tap(find.byTooltip('Waypack menu'));
    await shot(t, '06-trip-menu');

    await t.tap(find.text('Today'));
    await until(t, find.text('Where you\'re staying'));
    await shot(t, '07-native-today');

    await t.pageBack();
    await settle(t);
    await t.tap(find.byTooltip('Waypack menu'));
    await settle(t);
    await t.tap(find.text('Map'));
    await shot(t, '08-native-offline-map', waitMs: 9000);

    // The trip screen is full-screen (no app bar), so pop the routes directly.
    final nav = t.state<NavigatorState>(find.byType(Navigator).first);
    nav.popUntil((r) => r.isFirst);
    await settle(t);
    await t.tap(find.byTooltip('Settings'));
    await shot(t, '09-settings');
    await t.drag(find.byType(ListView), const Offset(0, -700));
    await shot(t, '10-settings-connect-agent');
  });
}
