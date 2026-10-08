import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:waypack/models/trip.dart';
import 'package:waypack/screens/trips_screen.dart';
import 'package:waypack/services/api.dart';
import 'package:waypack/services/local_server.dart';
import 'package:waypack/services/trip_store.dart';
import 'package:waypack/state/app_state.dart';

RemoteTrip _remote(
  String id,
  String title,
  String start,
  String end, {
  int version = 1,
  String status = 'ready',
  String role = 'owner',
  String? owner,
}) => RemoteTrip(
  id: id,
  title: title,
  startDate: start,
  endDate: end,
  version: version,
  status: status,
  bundleBytes: 4000000,
  tilesBytes: 120000000,
  tilesStatus: 'ready',
  role: role,
  ownerEmail: owner,
);

LocalTrip _local(
  String id,
  String title,
  String start,
  String end, {
  String? accent,
}) => LocalTrip(
  id: id,
  title: title,
  version: 1,
  startDate: start,
  endDate: end,
  bundleSha256: '',
  tiles: const [],
  bytes: 124000000,
  downloadedAt: DateTime(2026, 10, 1),
  accent: accent,
);

/// Seeds the home screen with one trip in every state.
AppState _seed(TripStore store) {
  final s = AppState(store: store, server: LocalServer(store), api: Api());
  final y = DateTime.now().year + 1;
  s.debugPut(
    TripEntry(
      remote: _remote('kyoto', 'Kyoto fall break', '$y-01-20', '$y-01-27'),
      local: _local(
        'kyoto',
        'Kyoto fall break',
        '$y-01-20',
        '$y-01-27',
        accent: '#C2562D',
      ),
    ),
  );
  s.debugPut(
    TripEntry(
      remote: _remote(
        'lisbon',
        'Grandma\'s 80th in Lisbon',
        '$y-02-18',
        '$y-02-28',
        version: 2,
        role: 'member',
        owner: 'aunt.may@example.com',
      ),
      local: _local(
        'lisbon',
        'Grandma\'s 80th in Lisbon',
        '$y-02-18',
        '$y-02-28',
        accent: '#2F7F9E',
      ),
    ),
  );
  s.debugPut(
    TripEntry(
      remote: _remote('tahoe', 'Tahoe ski weekend', '$y-03-12', '$y-03-15'),
    ),
  );
  s.progress['tahoe'] = .64;
  s.progressStage['tahoe'] = 'Offline map';
  s.debugPut(
    TripEntry(
      remote: _remote('obx', 'Outer Banks beach week', '$y-07-10', '$y-07-17'),
    ),
  );
  s.debugPut(
    TripEntry(
      local: _local(
        'maui',
        'Maui spring break',
        '2026-03-28',
        '2026-04-05',
        accent: '#E0703A',
      ),
    ),
  );
  s.debugPut(
    TripEntry(
      local: _local(
        'smokies',
        'Smokies camping',
        '2025-07-04',
        '2025-07-08',
        accent: '#4E7D4F',
      ),
    ),
  );
  return s;
}

Future<void> _loadFonts() async {
  final caveat = FontLoader('Caveat')
    ..addFont(rootBundle.load('assets/fonts/Caveat.ttf'));
  await caveat.load();
  // Real glyphs instead of Ahem boxes for the screenshot (macOS only).
  const sys = '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (File(sys).existsSync()) {
    final body = FontLoader(
      'Roboto',
    )..addFont(Future.value(ByteData.sublistView(File(sys).readAsBytesSync())));
    await body.load();
  }
}

void main() {
  for (final dark in [false, true]) {
    testWidgets('scrapbook home renders every trip state (dark: $dark)', (
      t,
    ) async {
      SharedPreferences.setMockInitialValues({});
      await _loadFonts();
      final temp = Directory.systemTemp.createTempSync('trips_screen_test');
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
              theme: ThemeData(
                brightness: dark ? Brightness.dark : Brightness.light,
              ),
              home: const TripsScreen(),
            ),
          ),
        ),
      );
      await t.pump(const Duration(milliseconds: 100));

      expect(find.text('Our trips'), findsOneWidget);
      expect(find.text('Kyoto fall break'), findsOneWidget);
      expect(find.text('Remember when…'), findsOneWidget);
      expect(find.byTooltip('Available offline'), findsOneWidget);
      expect(find.byTooltip('Update available'), findsOneWidget);
      expect(find.byTooltip('Not downloaded'), findsOneWidget);
      expect(find.text('Shared by aunt.may'), findsOneWidget);

      // Long-press opens the action sheet that replaced the card buttons.
      await t.longPress(find.text('Outer Banks beach week'));
      await t.pumpAndSettle();
      expect(find.text('Download'), findsOneWidget);
      expect(find.text('Share travel plan'), findsOneWidget);

      final out = Platform.environment['TRIPS_SCREENSHOT_DIR'];
      if (out != null) {
        await t.tapAt(const Offset(20, 20));
        await t.pumpAndSettle();
        await t.runAsync(() async {
          final boundary =
              key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
          final img = await boundary.toImage(pixelRatio: 2);
          final png = await img.toByteData(format: ui.ImageByteFormat.png);
          File('$out/trips_${dark ? 'dark' : 'light'}.png')
              .writeAsBytesSync(png!.buffer.asUint8List());
        });
      }
    });
  }
}
