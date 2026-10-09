import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:waypack/models/template.dart';
import 'package:waypack/screens/discover_screen.dart';
import 'package:waypack/services/api.dart';
import 'package:waypack/services/local_server.dart';
import 'package:waypack/services/trip_store.dart';
import 'package:waypack/state/app_state.dart';
import 'package:waypack/widgets/scrapbook.dart';

/// Responses captured from a local Worker seeded with scripts/seed-templates.mjs.
String _fixture(String name) => File('test/fixtures/templates/$name.json').readAsStringSync();

Future<void> _loadFonts() async {
  await (FontLoader('Caveat')..addFont(rootBundle.load('assets/fonts/Caveat.ttf'))).load();
  const sys = '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (File(sys).existsSync()) {
    await (FontLoader('Roboto')..addFont(Future.value(ByteData.sublistView(File(sys).readAsBytesSync())))).load();
  }
}

void main() {
  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    await Supabase.initialize(
      url: 'http://localhost:9',
      publishableKey: 'test',
      authOptions: const FlutterAuthClientOptions(localStorage: EmptyLocalStorage(), autoRefreshToken: false),
    );
  });

  test('template model reads a gallery card', () {
    final t = TripTemplate(jsonDecode(_fixture("sequoia")) as Map<String, dynamic>);
    expect(t.title, 'Sequoia in the snow');
    expect(t.traveledLabel, 'Jan 2026');
    expect(t.facts, '3 days · Jan · Easy');
    expect(t.crewLabel, '2 adults · kids 9 & 6');
    expect(t.notes('kept'), isNotEmpty);
    expect(t.plan.length, 3);
    expect(t.prompt(when: 'Feb 13–15'), allOf(contains(t.url), contains('get_template'), contains('- When: Feb 13–15'), contains("- Who's going: ask me")));
  });

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    final requests = <Uri>[];

    Future<GlobalKey> pump(WidgetTester t, Widget home, {bool empty = false}) async {
      await _loadFonts();
      requests.clear();
      final client = MockClient((req) async {
        requests.add(req.url);
        final p = req.url.path;
        final body = p.endsWith('/home')
            ? (empty ? '{"issue":{"month":"October","week":1},"total":0,"featured":null,"in_season":[],"collections":[],"most_planned":[],"newest":[]}' : _fixture('home'))
            : p == '/api/public/templates'
            ? _fixture('search')
            : p.startsWith('/api/public/templates/')
            ? _fixture('sequoia')
            : '{"error":"not found"}';
        return http.Response(body, body.contains('"error"') ? 404 : 200, headers: {'content-type': 'application/json; charset=utf-8'});
      });
      final temp = Directory.systemTemp.createTempSync('discover_test');
      addTearDown(() => temp.deleteSync(recursive: true));
      final store = TripStore(temp);
      final state = AppState(store: store, server: LocalServer(store), api: Api(client: client));
      t.view.physicalSize = const Size(1170, 2532);
      t.view.devicePixelRatio = 3;
      addTearDown(t.view.reset);
      final key = GlobalKey();
      await t.pumpWidget(
        ChangeNotifierProvider.value(
          value: state,
          child: RepaintBoundary(
            key: key,
            child: MaterialApp(debugShowCheckedModeBanner: false, theme: scrapbookTheme(dark ? Brightness.dark : Brightness.light), home: home),
          ),
        ),
      );
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await t.pump(const Duration(milliseconds: 300));
      return key;
    }

    Future<void> shot(WidgetTester t, GlobalKey key, String name) async {
      final out = Platform.environment['SCRAPBOOK_SCREENSHOT_DIR'];
      if (out == null) return;
      await t.pump(const Duration(milliseconds: 500));
      await t.runAsync(() async {
        final b = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final png = await (await b.toImage(pixelRatio: 1)).toByteData(format: ui.ImageByteFormat.png);
        File('$out/${name}_$mode.png').writeAsBytesSync(png!.buffer.asUint8List());
      });
    }

    testWidgets('discover: magazine home ($mode)', (t) async {
      final key = await pump(t, const DiscoverScreen());
      expect(find.text('The Waypack Journal'), findsOneWidget);
      expect(find.text('TRIP OF THE WEEK'), findsOneWidget);
      expect(find.byKey(const Key('discover-search')), findsOneWidget);
      await shot(t, key, 'discover_home');
      await t.scrollUntilVisible(find.text('Most planned'), 400, scrollable: find.byType(Scrollable).first);
      expect(find.text('Most planned'), findsOneWidget);
      await shot(t, key, 'discover_home_more');
      await t.scrollUntilVisible(find.byKey(const Key('discover-browse-all')), 400, scrollable: find.byType(Scrollable).first);
      expect(find.text('Browse all 9 trips'), findsOneWidget);
    });

    testWidgets('discover: empty gallery explains how trips get here ($mode)', (t) async {
      await pump(t, const DiscoverScreen(), empty: true);
      expect(find.text('The gallery is just opening'), findsOneWidget);
    });

    testWidgets('search: postcards, filters and the map ($mode)', (t) async {
      final key = await pump(t, const TemplateSearchScreen());
      expect(find.byKey(const Key('template-grid')), findsOneWidget);
      expect(find.text('9 trips'), findsOneWidget);
      await shot(t, key, 'search_postcards');
      await t.tap(find.text('Winter'));
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await t.pump();
      expect(requests.last.queryParameters['season'], 'winter');
      await t.tap(find.byKey(const Key('view-map')));
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.byKey(const Key('template-map')), findsOneWidget);
      expect(find.byKey(const Key('template-carousel')), findsOneWidget);
      expect(find.byKey(const Key('template-grid')), findsNothing);
      await shot(t, key, 'search_map');
      // Back to postcards keeps the same results and filters.
      await t.tap(find.byKey(const Key('view-postcards')));
      await t.pump();
      expect(find.byKey(const Key('template-grid')), findsOneWidget);
      expect(requests.last.queryParameters['season'], 'winter');
    });

    testWidgets('template: postcard, notes, plan and the hand-off ($mode)', (t) async {
      final key = await pump(t, const TemplateScreen(slug: 'sequoia-in-the-snow-xojpnq'));
      expect(find.text('Dear future traveler,'), findsOneWidget);
      expect(find.textContaining('TRAVELED JAN 2026'), findsOneWidget);
      await shot(t, key, 'template_top');
      await t.scrollUntilVisible(find.text('Day by day'), 400, scrollable: find.byType(Scrollable).first);
      await shot(t, key, 'template_days');
      await t.tap(find.byKey(const Key('plan-this-trip')));
      await t.pump(const Duration(milliseconds: 400));
      expect(find.byKey(const Key('open-in-claude')), findsOneWidget);
      await t.enterText(find.widgetWithText(TextField, 'When'), 'Feb 13–15');
      await t.pump();
      expect(find.textContaining('- When: Feb 13–15'), findsOneWidget);
      await shot(t, key, 'template_plan');
    });
  }
}
