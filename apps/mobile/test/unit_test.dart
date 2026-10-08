import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:waypack/models/manifest.dart';
import 'package:waypack/models/trip.dart';
import 'package:waypack/services/api.dart';
import 'package:waypack/services/calendar.dart';
import 'package:waypack/services/local_server.dart';
import 'package:waypack/services/pdf_export.dart';
import 'package:waypack/services/trip_store.dart';
import 'package:waypack/state/app_state.dart';
import 'package:waypack/util/format.dart';
import 'package:waypack/util/today.dart';

Manifest sample() => Manifest({
  'title': 'T',
  'timezone': 'America/Los_Angeles',
  'start_date': '2026-12-24',
  'end_date': '2026-12-26',
  'places': [
    {'id': 'a', 'name': 'A', 'category': 'lodging', 'lat': 1, 'lon': 2},
  ],
  'routes': [],
  'days': [
    {
      'date': '2026-12-25',
      'items': [
        {'time': '09:00', 'end_time': '10:00', 'title': 'One'},
        {'time': '12:00', 'title': 'Two'},
        {'time': '15:00', 'title': 'Three'},
      ],
    },
    {
      'date': '2026-12-24',
      'items': [
        {'time': '08:00', 'title': 'Zero'},
      ],
    },
  ],
});

void main() {
  group('parseRange', () {
    test('forms', () {
      expect(parseRange(null, 100), isNull);
      expect(parseRange('bytes=0-6', 100), [0, 6]);
      expect(parseRange('bytes=10-', 100), [10, 99]);
      expect(parseRange('bytes=-10', 100), [90, 99]);
      expect(parseRange('bytes=0-1000', 100), [0, 99]);
      expect(parseRange('bytes=200-300', 100), isEmpty);
      expect(parseRange('items=0-1', 100), isNull);
    });
  });

  group('safeRelative', () {
    test(
      'accepts normal paths',
      () => expect(safeRelative('assets/./a.css'), 'assets/a.css'),
    );
    for (final bad in [
      '/etc/passwd',
      '../x',
      'a/../../x',
      r'a\b',
      'C:/x',
      '',
    ]) {
      test(
        'rejects $bad',
        () => expect(() => safeRelative(bad), throwsFormatException),
      );
    }
  });

  test(
    'unzipBundle strips a single top folder and rejects traversal',
    () async {
      final tmp = await Directory.systemTemp.createTemp('wp');
      final a = Archive()
        ..addFile(ArchiveFile.string('trip/manifest.json', '{}'))
        ..addFile(ArchiveFile.string('trip/index.html', '<p>'));
      final zip = File('${tmp.path}/b.zip')
        ..writeAsBytesSync(ZipEncoder().encode(a));
      await unzipBundle(zip, Directory('${tmp.path}/out'));
      expect(File('${tmp.path}/out/index.html').existsSync(), isTrue);

      final evil = Archive()..addFile(ArchiveFile.string('../evil.txt', 'x'));
      final ez = File('${tmp.path}/e.zip')
        ..writeAsBytesSync(ZipEncoder().encode(evil));
      await expectLater(
        unzipBundle(ez, Directory('${tmp.path}/out2')),
        throwsFormatException,
      );
      await tmp.delete(recursive: true);
    },
  );

  group('computeToday', () {
    final m = sample();
    test('before the trip', () {
      final v = computeToday(m, today: '2026-12-20', nowTime: '10:00');
      expect(v.phase, TripPhase.before);
      expect(v.daysUntil, 4);
      expect(v.day!.date, '2026-12-24'); // days are sorted
    });
    test('during: now and next', () {
      final v = computeToday(m, today: '2026-12-25', nowTime: '09:30');
      expect(v.phase, TripPhase.during);
      expect(v.dayNumber, 2);
      expect(v.focus!.title, 'One');
      expect(v.focusIsNow, isTrue);
      final v2 = computeToday(m, today: '2026-12-25', nowTime: '10:30');
      expect(v2.focus!.title, 'Two');
      expect(v2.focusIsNow, isFalse);
      expect(v2.isDone(0), isTrue);
    });
    test(
      'after',
      () => expect(
        computeToday(m, today: '2027-01-01', nowTime: '00:00').phase,
        TripPhase.after,
      ),
    );
    test('nowIn uses the trip time zone', () {
      tzdata.initializeTimeZones();
      final (d, t) = nowIn(
        'America/Los_Angeles',
        at: DateTime.utc(2026, 12, 25, 7, 30),
      );
      expect(d, '2026-12-24');
      expect(t, '23:30');
    });
  });

  test('formatBytes', () {
    expect(formatBytes(512), '512 B');
    expect(formatBytes(3 * 1048576 + 1), '3.0 MB');
  });

  group('calendar events', () {
    final m = sample();
    test('timed item → UTC instants in the trip zone, end from end_time', () {
      tzdata.initializeTimeZones();
      final e = TripEvent.fromItem(m, '2026-12-25', 0)!;
      expect(e.start.toIso8601String(), '2026-12-25T17:00:00.000Z');
      expect(e.end.toIso8601String(), '2026-12-25T18:00:00.000Z');
      expect(e.allDay, isFalse);
      final g = Uri.parse(e.googleUrl!);
      expect(g.queryParameters['dates'], '20261225T090000/20261225T100000');
      expect(g.queryParameters['ctz'], 'America/Los_Angeles');
    });
    test('no end_time → until the next item (max 3 h)', () {
      final e = TripEvent.fromItem(m, '2026-12-25', 1)!; // 12:00, next 15:00
      expect(e.end.difference(e.start), const Duration(hours: 3));
    });
    test(
      'missing item → null',
      () => expect(TripEvent.fromItem(m, '2026-12-25', 9), isNull),
    );
    test('.ics for the Mac: UTC instants, escaped text, folded lines', () {
      final e = TripEvent(
        title: 'Dinner; Beach House, table 4',
        start: DateTime.utc(2027, 1, 16, 2, 30),
        end: DateTime.utc(2027, 1, 16, 4, 0),
        allDay: false,
        location: 'Beach House, 1 Lake St, South Lake Tahoe, CA 96150, United States of America',
        notes: 'Line one\nLine two',
      );
      final ics = eventIcs(e, now: DateTime.utc(2026, 10, 4));
      expect(ics, contains('DTSTART:20270116T023000Z\r\n'));
      expect(ics, contains('DTEND:20270116T040000Z\r\n'));
      expect(ics, contains(r'SUMMARY:Dinner\; Beach House\, table 4'));
      expect(ics, contains(r'DESCRIPTION:Line one\nLine two'));
      for (final l in ics.split('\r\n')) {
        expect(utf8.encode(l).length, lessThanOrEqualTo(75));
      }
      expect(ics.replaceAll('\r\n ', ''), contains('United States of America'));
    });
    test('.ics all-day uses DATE values', () {
      final e = TripEvent(
        title: 'Drive day',
        start: DateTime.utc(2027, 1, 18),
        end: DateTime.utc(2027, 1, 19),
        allDay: true,
      );
      final ics = eventIcs(e, now: DateTime.utc(2026, 10, 4));
      expect(ics, contains('DTSTART;VALUE=DATE:20270118'));
      expect(ics, contains('DTEND;VALUE=DATE:20270119'));
    });
  });

  group('bookmarks', () {
    test('toggle and query bookmarks', () async {
      SharedPreferences.setMockInitialValues({});
      final temp = await Directory.systemTemp.createTemp('bookmarks_test');
      try {
        final store = TripStore(temp);
        final server = LocalServer(store);
        final state = AppState(store: store, server: server, api: Api());
        expect(state.isBookmarked('trip-1'), isFalse);
        await state.toggleBookmark('trip-1');
        expect(state.isBookmarked('trip-1'), isTrue);
        await state.toggleBookmark('trip-1');
        expect(state.isBookmarked('trip-1'), isFalse);
      } finally {
        await temp.delete(recursive: true);
      }
    });
  });

  group('cover image', () {
    test('manifest parses cover_image', () {
      final m1 = Manifest({
        'title': 'Trip',
        'start_date': '2026-10-10',
        'end_date': '2026-10-12',
        'cover_image': 'assets/cover.jpg',
      });
      expect(m1.coverImage, 'assets/cover.jpg');

      final m2 = Manifest({
        'title': 'Trip',
        'start_date': '2026-10-10',
        'end_date': '2026-10-12',
        'theme': {'cover_image': 'cover.png'},
      });
      expect(m2.coverImage, 'cover.png');
    });

    test('RemoteTrip and LocalTrip serialize cover image fields', () {
      final r = RemoteTrip(
        id: 'trip-1',
        title: 'Sequoia',
        version: 1,
        status: 'ready',
        bundleBytes: 100,
        tilesBytes: 200,
        tilesStatus: 'ready',
        coverImage: 'assets/cover.jpg',
        coverImageUrl: 'https://example.com/cover.jpg',
      );
      final json = r.toJson();
      expect(json['cover_image'], 'assets/cover.jpg');
      expect(json['cover_image_url'], 'https://example.com/cover.jpg');

      final r2 = RemoteTrip.fromJson(json);
      expect(r2.coverImage, 'assets/cover.jpg');
      expect(r2.coverImageUrl, 'https://example.com/cover.jpg');

      final l = LocalTrip(
        id: 'trip-1',
        title: 'Sequoia',
        version: 1,
        bundleSha256: 'sha',
        tiles: [],
        bytes: 300,
        downloadedAt: DateTime.parse('2026-10-08T12:00:00Z'),
        coverImage: 'cover.jpg',
      );
      final lJson = l.toJson();
      expect(lJson['cover_image'], 'cover.jpg');
      final l2 = LocalTrip.fromJson(lJson);
      expect(l2.coverImage, 'cover.jpg');
    });

    test('TripEntry resolves coverFile from trip store directory', () async {
      final temp = await Directory.systemTemp.createTemp('trip_cover_test');
      try {
        final store = TripStore(temp);
        final vDir = store.versionDir('trip-1', 1);
        await vDir.create(recursive: true);
        final testCover = File('${vDir.path}/cover.jpg');
        await testCover.writeAsString('fake-image');

        final entry = TripEntry(
          local: LocalTrip(
            id: 'trip-1',
            title: 'Sequoia',
            version: 1,
            bundleSha256: 'sha',
            tiles: [],
            bytes: 100,
            downloadedAt: DateTime.now(),
            coverImage: 'cover.jpg',
          ),
        );

        final resolved = entry.coverFile(store);
        expect(resolved, isNotNull);
        expect(resolved!.existsSync(), isTrue);
        expect(resolved.path, testCover.path);
      } finally {
        await temp.delete(recursive: true);
      }
    });
  });

  group('PDF export', () {
    test('sanitizes filename correctly', () {
      expect(PdfExportService.sanitizeFilename('Sequoia Winter Weekend 2026!'), 'Sequoia_Winter_Weekend_2026');
      expect(PdfExportService.sanitizeFilename('Trip / Plan & Fun @ Yosemite'), 'Trip_Plan_Fun_Yosemite');
    });

    test('generatePdf creates valid non-empty PDF bytes', () async {
      final m = sample();
      final entry = TripEntry(
        local: LocalTrip(
          id: 'sample-trip',
          title: m.title,
          version: 1,
          bundleSha256: 'abc',
          tiles: [],
          bytes: 1234,
          downloadedAt: DateTime.now(),
        ),
      );

      final pdfBytes = await PdfExportService.generatePdf(entry: entry, manifest: m);
      expect(pdfBytes, isNotEmpty);
      // PDF documents start with '%PDF'
      final header = utf8.decode(pdfBytes.sublist(0, 4), allowMalformed: true);
      expect(header, '%PDF');
    });
  });
}
