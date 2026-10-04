import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:waypack/models/manifest.dart';
import 'package:waypack/services/calendar.dart';
import 'package:waypack/services/local_server.dart';
import 'package:waypack/services/trip_store.dart';
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
  });
}
