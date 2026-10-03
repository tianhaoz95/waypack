// Downloads a seeded trip and checks offline serving end to end on a simulator/emulator.
// Prereqs (host): local stack running and `node services/mcp/scripts/seed-dev.mjs dev@waypack.test`.
//   flutter test integration_test/app_test.dart -d <device> --dart-define=NO_PERMISSION_PROMPTS=true
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:provider/provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:waypack/config.dart';
import 'package:waypack/main.dart';

const email = String.fromEnvironment('TEST_EMAIL', defaultValue: 'dev@waypack.test');
const password = String.fromEnvironment('TEST_PASSWORD', defaultValue: 'waypack-dev-password');

Future<(int, Map<String, String>, List<int>)> get(Uri u, {Map<String, String> headers = const {}}) async {
  final c = HttpClient();
  final req = await c.getUrl(u);
  req.followRedirects = false;
  headers.forEach(req.headers.set);
  final res = await req.close();
  final body = await res.fold<List<int>>([], (a, b) => a..addAll(b));
  final h = <String, String>{};
  res.headers.forEach((k, v) => h[k] = v.join(','));
  return (res.statusCode, h, body);
}

Future<void> pumpUntil(WidgetTester t, Finder f, {Duration timeout = const Duration(seconds: 90)}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await t.pump(const Duration(milliseconds: 500));
    if (f.evaluate().isNotEmpty) return;
  }
  throw TestFailure('timed out waiting for $f');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('sign in, download, serve offline', (t) async {
    final state = await bootstrap();
    final sb = Supabase.instance.client;
    if (sb.auth.currentSession != null) await state.signOut();
    for (final e in [...state.upcoming, ...state.past]) {
      await state.store.deleteLocal(e.id);
    }

    await t.pumpWidget(ChangeNotifierProvider.value(value: state, child: const WaypackApp()));
    await t.pumpAndSettle();
    // Email + password only.
    expect(find.text('Forgot password?'), findsOneWidget);
    expect(find.textContaining('Continue with'), findsNothing);

    // Wrong password first, then the seeded one.
    await t.enterText(find.byKey(const Key('email')), email);
    await t.enterText(find.byKey(const Key('password')), 'not the password');
    await t.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await pumpUntil(t, find.text('Wrong email or password.'));
    await t.tap(find.byKey(const Key('password')));
    await t.pump(const Duration(milliseconds: 300));
    await t.enterText(find.byKey(const Key('password')), password);
    await t.pump(const Duration(milliseconds: 300));
    await t.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await pumpUntil(t, find.text('Sequoia Winter Weekend'));
    expect(find.text('Not downloaded'), findsOneWidget);

    // Download (bundle + offline map), verified by SHA-256 inside the app.
    await t.tap(find.text('Download'));
    await pumpUntil(t, find.text('Available offline'));
    final trip = state.upcoming.firstWhere((e) => e.title == 'Sequoia Winter Weekend');
    expect(trip.local!.tiles.length, 2);

    // Local server: token gate, cookie exchange, CSP, tiles index, Range, traversal.
    final s = state.server;
    final noToken = await get(Uri.parse('${s.origin}/t/${trip.id}/index.html'));
    expect(noToken.$1, 403);
    final first = await get(Uri.parse(s.tripUrl(trip.id)));
    expect(first.$1, 302);
    final cookie = first.$2['set-cookie']!.split(';').first;
    final index = await get(Uri.parse('${s.origin}/t/${trip.id}/index.html'), headers: {'cookie': cookie});
    expect(index.$1, 200);
    expect(index.$2['content-security-policy'], contains("connect-src 'self'"));
    expect(utf8.decode(index.$3), contains('/__waypack/sdk/v1/waypack.js'));
    final sdk = await get(Uri.parse('${s.origin}/__waypack/sdk/v1/waypack.js'), headers: {'cookie': cookie});
    expect(sdk.$1, 200);
    final glyph = await get(Uri.parse('${s.origin}/__waypack/sdk/v1/assets/fonts/Noto%20Sans%20Regular/0-255.pbf'), headers: {'cookie': cookie});
    expect(glyph.$1, 200);
    final idx = jsonDecode(utf8.decode((await get(Uri.parse('${s.origin}/__waypack/tiles/${trip.id}/index.json'), headers: {'cookie': cookie})).$3)) as Map;
    expect((idx['extracts'] as List).length, 2);
    final tileUrl = (idx['extracts'] as List).first['url'] as String;
    final range = await get(Uri.parse('${s.origin}$tileUrl'), headers: {'cookie': cookie, 'range': 'bytes=0-6'});
    expect(range.$1, 206);
    expect(utf8.decode(range.$3), 'PMTiles');
    final traversal = await get(Uri.parse('${s.origin}/t/${trip.id}/%2E%2E/local.json'), headers: {'cookie': cookie});
    expect(traversal.$1, anyOf(400, 404));
    final hostCheck = await get(Uri.parse('${s.origin}/t/${trip.id}/index.html'), headers: {'cookie': cookie, 'host': 'evil.example'});
    expect(hostCheck.$1, 421);

    // Open the trip (WebView). Give the map time to render for the host-side screenshot.
    await t.tap(find.text('Open'));
    await t.pump(const Duration(seconds: 2));
    expect(find.byTooltip('Waypack menu'), findsOneWidget);
    final shotDelay = int.tryParse(const String.fromEnvironment('SHOT_DELAY', defaultValue: '6')) ?? 6;
    for (var i = 0; i < shotDelay * 2; i++) {
      await t.pump(const Duration(milliseconds: 500));
    }

    // Native Today view from the manifest.
    await t.tap(find.byTooltip('Waypack menu'));
    await t.pumpAndSettle();
    await t.tap(find.text('Today'));
    await pumpUntil(t, find.textContaining('days to go'));
    await t.scrollUntilVisible(find.text('Where you\'re staying'), 300);
    expect(find.text('Where you\'re staying'), findsOneWidget);

    // Native offline Map (SDK page served by the app, tiles from the device).
    await t.pageBack();
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Waypack menu'));
    await t.pumpAndSettle();
    await t.tap(find.text('Map'));
    for (var i = 0; i < shotDelay * 2; i++) {
      await t.pump(const Duration(milliseconds: 500));
    }
    debugPrint('API at ${Config.apiUrl}; trip ${trip.id} OK');
  });
}
