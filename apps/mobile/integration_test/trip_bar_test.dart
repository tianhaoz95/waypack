// The trip page's top bar (trip SDK ≥ 1.1) in the real WebView: the bar reports in, so the app
// draws nothing over the page, and its ⋯ and back buttons reach the app through the JS bridge. No network or sign-in:
// the skill template is installed into a temp store and served by the app's own local server.
//
//   flutter test integration_test/trip_bar_test.dart -d <simulator> \
//     --dart-define=WAYPACK_TEMPLATE=$PWD/../../skill/templates/base --dart-define=NO_PERMISSION_PROMPTS=true
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:waypack/models/trip.dart';
import 'package:waypack/screens/trip_screen.dart';
import 'package:waypack/services/api.dart';
import 'package:waypack/services/local_server.dart';
import 'package:waypack/services/trip_store.dart';
import 'package:waypack/state/app_state.dart';
import 'package:waypack/widgets/bundle_webview.dart';
import 'package:waypack/widgets/scrapbook.dart';

// The iOS simulator can read the host checkout, so the test reads the template straight from it.
const _template = String.fromEnvironment('WAYPACK_TEMPLATE');

Future<void> _until(WidgetTester t, Finder f, {int seconds = 20}) async {
  for (var i = 0; i < seconds * 10; i++) {
    await t.pump(const Duration(milliseconds: 100));
    if (f.evaluate().isNotEmpty) return;
  }
  fail('timed out waiting for $f');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('trip page bar: no native overlay, ⋯ and back reach the app', (
    t,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final root = await Directory.systemTemp.createTemp('trip_bar_test');
    final store = TripStore(root);
    late LocalServer server;
    late AppState state;
    await t.runAsync(() async {
      expect(
        _template,
        isNotEmpty,
        reason: 'pass --dart-define=WAYPACK_TEMPLATE=…',
      );
      final src = Directory(_template);
      final dst = store.versionDir('bar', 1);
      for (final f in src.listSync(recursive: true).whereType<File>()) {
        final out = File(
          '${dst.path}/${f.path.substring(src.path.length + 1)}',
        );
        await out.parent.create(recursive: true);
        await f.copy(out.path);
      }
      final local = LocalTrip(
        id: 'bar',
        title: 'Bar test',
        version: 1,
        bundleSha256: '',
        tiles: const [],
        bytes: 1,
        downloadedAt: DateTime(2026, 10, 1),
      );
      await store.saveMeta(local);
      server = LocalServer(store);
      await server.start();
      // adoptLocal also tells the local server which version to serve.
      state = AppState(store: store, server: server, api: Api())
        ..adoptLocal(local);
    });

    final nav = GlobalKey<NavigatorState>();
    await t.pumpWidget(
      ChangeNotifierProvider.value(
        value: state,
        child: MaterialApp(
          navigatorKey: nav,
          theme: scrapbookTheme(Brightness.light),
          home: const Scaffold(body: Center(child: Text('Trips'))),
        ),
      ),
    );
    nav.currentState!.push(
      MaterialPageRoute(builder: (_) => const TripScreen(tripId: 'bar')),
    );
    await t.pump(const Duration(seconds: 1));

    // Past the 6s fallback deadline: the page's bar reported in, so no floating ⋯ was drawn.
    for (var i = 0; i < 80; i++) {
      await t.pump(const Duration(milliseconds: 100));
    }
    expect(find.byTooltip('Waypack menu'), findsNothing);

    // Click the page's own bar buttons (in the real WebView) and check they reach the app.
    Future<void> click(String selector) => t.runAsync(
      () => BundleWebView.debugLastController!.evaluateJavascript(
        source:
            'document.querySelector("[data-waypack-bar] $selector").click()',
      ),
    );
    final buttons = await t.runAsync(
      () => BundleWebView.debugLastController!.evaluateJavascript(
        source: '[...document.querySelectorAll("[data-waypack-bar] .wp-bar-btn")].filter(b => b.offsetWidth > 0).map(b => b.className.split(" ")[1]).join(",")',
      ),
    );
    expect(buttons, 'wp-bar-back,wp-bar-menu,wp-bar-more');

    await click('.wp-bar-more');
    await _until(t, find.text('Hand off to a nearby phone'));
    Navigator.of(t.element(find.text('Hand off to a nearby phone'))).pop();
    await t.pump(const Duration(seconds: 1));

    await click('.wp-bar-back');
    for (
      var i = 0;
      i < 100 && find.byType(TripScreen).evaluate().isNotEmpty;
      i++
    ) {
      await t.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(TripScreen), findsNothing);
    expect(find.text('Trips'), findsOneWidget);

    await t.runAsync(() async {
      await server.stop();
      await root.delete(recursive: true);
    });
  });
}
