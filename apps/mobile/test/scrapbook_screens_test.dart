import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:waypack/models/manifest.dart';
import 'package:waypack/models/trip.dart';
import 'package:waypack/screens/nearby_screens.dart';
import 'package:waypack/screens/settings_screen.dart';
import 'package:waypack/screens/sign_in_screen.dart';
import 'package:waypack/screens/today_screen.dart';
import 'package:waypack/screens/trips_screen.dart';
import 'package:waypack/services/api.dart';
import 'package:waypack/services/local_server.dart';
import 'package:waypack/services/trip_store.dart';
import 'package:waypack/state/app_state.dart';
import 'package:waypack/util/today.dart';
import 'package:waypack/widgets/scrapbook.dart';

/// The Tahoe example, moved so that its first day is today (in the trip's time zone).
Manifest _todayManifest() {
  final raw = jsonDecode(
    File('../../examples/tahoe-winter/manifest.json').readAsStringSync(),
  ) as Map<String, dynamic>;
  final (today, _) = nowIn(raw['timezone'] as String);
  final start = DateTime.parse(raw['start_date'] as String);
  final shift = DateTime.parse(today).difference(start);
  String move(String d) =>
      DateTime.parse(d).add(shift).toIso8601String().substring(0, 10);
  raw['start_date'] = move(raw['start_date'] as String);
  raw['end_date'] = move(raw['end_date'] as String);
  for (final d in (raw['days'] as List).cast<Map<String, dynamic>>()) {
    d['date'] = move(d['date'] as String);
  }
  return Manifest(raw);
}

AppState _seed(TripStore store) {
  final s = AppState(store: store, server: LocalServer(store), api: Api());
  final y = DateTime.now().year + 1;
  s.debugPut(
    TripEntry(
      remote: RemoteTrip(
        id: 'kyoto',
        title: 'Kyoto fall break',
        startDate: '$y-01-20',
        endDate: '$y-01-27',
        version: 2,
        status: 'ready',
        bundleBytes: 4000000,
        tilesBytes: 120000000,
        tilesStatus: 'ready',
        role: 'owner',
      ),
      local: LocalTrip(
        id: 'kyoto',
        title: 'Kyoto fall break',
        version: 1,
        startDate: '$y-01-20',
        endDate: '$y-01-27',
        bundleSha256: '',
        tiles: const [],
        bytes: 124000000,
        downloadedAt: DateTime(2026, 10, 1),
        accent: '#C2562D',
      ),
    ),
  );
  return s;
}

Future<void> _loadFonts() async {
  final caveat = FontLoader('Caveat')
    ..addFont(rootBundle.load('assets/fonts/Caveat.ttf'));
  await caveat.load();
  // Real glyphs instead of Ahem boxes for the screenshots (macOS only).
  const sys = '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (File(sys).existsSync()) {
    final body = FontLoader(
      'Roboto',
    )..addFont(Future.value(ByteData.sublistView(File(sys).readAsBytesSync())));
    await body.load();
  }
}

void main() {
  setUpAll(() async {
    tzdata.initializeTimeZones();
    SharedPreferences.setMockInitialValues({});
    // Settings reads the signed-in user; no session, no network.
    await Supabase.initialize(
      url: 'http://localhost:9',
      publishableKey: 'test',
      authOptions: const FlutterAuthClientOptions(
        localStorage: EmptyLocalStorage(),
        autoRefreshToken: false,
      ),
    );
  });

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';

    Future<(GlobalKey, AppState)> pump(WidgetTester t, Widget home) async {
      SharedPreferences.setMockInitialValues({});
      await _loadFonts();
      final temp = Directory.systemTemp.createTempSync('scrapbook_test');
      addTearDown(() => temp.deleteSync(recursive: true));
      final state = _seed(TripStore(temp));
      t.view.physicalSize = const Size(1170, 2532);
      t.view.devicePixelRatio = 3;
      addTearDown(t.view.reset);
      final key = GlobalKey();
      await t.pumpWidget(
        ChangeNotifierProvider.value(
          value: state,
          child: RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: scrapbookTheme(dark ? Brightness.dark : Brightness.light),
              home: home,
            ),
          ),
        ),
      );
      await t.pump(const Duration(milliseconds: 300));
      return (key, state);
    }

    Future<void> shot(WidgetTester t, GlobalKey key, String name) async {
      final out = Platform.environment['SCRAPBOOK_SCREENSHOT_DIR'];
      if (out == null) return;
      await t.pump(const Duration(milliseconds: 500));
      await t.runAsync(() async {
        final b =
            key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final img = await b.toImage(pixelRatio: 1);
        final png = await img.toByteData(format: ui.ImageByteFormat.png);
        File('$out/${name}_$mode.png')
            .writeAsBytesSync(png!.buffer.asUint8List());
      });
    }

    testWidgets('today: ticket trail ($mode)', (t) async {
      final (key, _) = await pump(t, TodayScreen(manifest: _todayManifest()));
      expect(find.textContaining('Day 1'), findsWidgets);
      await shot(t, key, 'today_top');
      await t.scrollUntilVisible(find.text('Where you\'re staying'), 300);
      expect(find.text('Where you\'re staying'), findsOneWidget);
      await t.scrollUntilVisible(find.text('If something goes wrong'), 300);
      await shot(t, key, 'today');
    });

    testWidgets('settings: index cards ($mode)', (t) async {
      final (key, _) = await pump(t, const SettingsScreen());
      expect(find.text('Settings'), findsOneWidget);
      expect(find.text('Connect your AI agent'), findsOneWidget);
      await shot(t, key, 'settings');
    });

    testWidgets('receive: manual entry ($mode)', (t) async {
      final (key, _) = await pump(t, const ReceiveNearbyScreen());
      expect(find.widgetWithText(TextField, 'Address'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Code'), findsOneWidget);
      expect(find.text('Connect'), findsOneWidget);
      await shot(t, key, 'receive');
    });

    testWidgets('sign in: photo pile ($mode)', (t) async {
      final (key, _) = await pump(t, const SignInScreen());
      expect(find.text('Continue with Apple'), findsOneWidget);
      expect(find.text('Continue with Google'), findsOneWidget);
      await shot(t, key, 'signin');
    });

    testWidgets('trip actions, share sheet and delete confirm ($mode)', (
      t,
    ) async {
      final (key, _) = await pump(t, const TripsScreen());
      await t.longPress(find.text('Kyoto fall break'));
      await t.pumpAndSettle();
      expect(find.text('Version 2 is ready'), findsOneWidget);
      expect(find.text('Delete offline copy'), findsOneWidget);
      await shot(t, key, 'actions');

      await t.tap(find.text('Share travel plan'));
      await t.pumpAndSettle();
      expect(find.text('Send as PDF'), findsOneWidget);
      expect(find.text('Hand off'), findsOneWidget);
      await shot(t, key, 'share');
      await t.tapAt(const Offset(20, 120));
      await t.pumpAndSettle();

      await t.longPress(find.text('Kyoto fall break'));
      await t.pumpAndSettle();
      await t.tap(find.text('Delete offline copy'));
      await t.pumpAndSettle();
      expect(find.text('Delete offline copy?'), findsOneWidget);
      await shot(t, key, 'confirm');
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
      expect(find.text('Delete offline copy?'), findsNothing);
    });
  }
}
