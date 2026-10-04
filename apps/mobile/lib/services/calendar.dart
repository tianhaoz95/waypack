import 'dart:convert';
import 'dart:io';

import 'package:add_2_calendar/add_2_calendar.dart' as cal;
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:timezone/timezone.dart' as tz;
import 'package:url_launcher/url_launcher.dart';

import '../models/manifest.dart';
import 'handoff.dart';

/// An event ready for a calendar: instants in UTC (or an all-day date).
class TripEvent {
  TripEvent({
    required this.title,
    required this.start,
    required this.end,
    required this.allDay,
    this.location,
    this.notes,
    this.googleUrl,
  });
  final String title;
  final DateTime start; // UTC
  final DateTime end; // UTC
  final bool allDay;
  final String? location;
  final String? notes;
  final String? googleUrl;

  /// From the SDK bridge payload (see packages/trip-sdk/src/index.ts addToCalendar).
  factory TripEvent.fromBridge(Map a) => TripEvent(
    title: '${a['title']}',
    start: DateTime.parse('${a['start']}'),
    end: DateTime.parse('${a['end']}'),
    allDay: a['allDay'] == true,
    location: a['location'] as String?,
    notes: a['notes'] as String?,
    googleUrl: a['googleUrl'] as String?,
  );

  /// Same rules as the SDK: end = end_time, else the next timed item (max 3 h), else 1 h;
  /// no time → all-day. Times are wall-clock in the trip's time zone.
  static TripEvent? fromItem(Manifest m, String date, int index) {
    final day = m.days.where((d) => d.date == date).firstOrNull;
    if (day == null || index >= day.items.length) return null;
    final it = day.items[index];
    final route = it.routeId == null ? null : m.routesById[it.routeId];
    final placeId = it.placeId ?? route?['to'] as String?;
    final p = placeId == null ? null : m.placesById[placeId];
    final notes = [
      it.notes,
      route?['notes'] as String?,
      p?.address,
      if (p?.phone != null) 'Phone: ${p!.phone}',
      'From your Waypack trip "${m.title}"',
    ].whereType<String>().join('\n');
    final location = p == null
        ? null
        : [p.name, p.address].whereType<String>().join(', ');
    final d = DateTime.parse(date);
    String gUrl({String? end}) => googleCalendarUrl(
      title: it.title,
      date: date,
      time: it.time,
      endTime: end,
      timezone: m.timezone,
      details: notes,
      location: location,
    );
    if (it.time == null) {
      final s = DateTime.utc(d.year, d.month, d.day);
      return TripEvent(
        title: it.title,
        start: s,
        end: s.add(const Duration(days: 1)),
        allDay: true,
        location: location,
        notes: notes,
        googleUrl: gUrl(),
      );
    }
    int mins(String hm) =>
        int.parse(hm.substring(0, 2)) * 60 + int.parse(hm.substring(3, 5));
    final startMin = mins(it.time!);
    var endMin = it.endTime != null ? mins(it.endTime!) : -1;
    if (endMin < 0) {
      final next = day.items
          .skip(index + 1)
          .where((x) => x.time != null && x.time!.compareTo(it.time!) > 0)
          .firstOrNull;
      endMin = next != null
          ? [mins(next.time!), startMin + 180].reduce((a, b) => a < b ? a : b)
          : startMin + 60;
    }
    if (endMin <= startMin) endMin = startMin + 60;
    DateTime at(int minute) {
      try {
        final loc = tz.getLocation(m.timezone);
        return tz.TZDateTime(
          loc,
          d.year,
          d.month,
          d.day,
          minute ~/ 60,
          minute % 60,
        ).toUtc();
      } catch (_) {
        return DateTime(
          d.year,
          d.month,
          d.day,
          minute ~/ 60,
          minute % 60,
        ).toUtc();
      }
    }

    String hm(int minute) =>
        '${(minute ~/ 60).toString().padLeft(2, '0')}:${(minute % 60).toString().padLeft(2, '0')}';
    return TripEvent(
      title: it.title,
      start: at(startMin),
      end: at(endMin),
      allDay: false,
      location: location,
      notes: notes,
      googleUrl: gUrl(end: hm(endMin)),
    );
  }
}

/// Google Calendar "create event" link with local wall-clock times + ctz (same as the SDK).
String googleCalendarUrl({
  required String title,
  required String date,
  String? time,
  String? endTime,
  required String timezone,
  String? details,
  String? location,
}) {
  String ymd(String d) => d.replaceAll('-', '');
  String nextDay(String d) {
    final x = DateTime.parse('${d}T12:00:00Z').add(const Duration(days: 1));
    return '${x.year.toString().padLeft(4, '0')}${x.month.toString().padLeft(2, '0')}${x.day.toString().padLeft(2, '0')}';
  }

  final params = <String, String>{'action': 'TEMPLATE', 'text': title};
  if (time == null) {
    params['dates'] = '${ymd(date)}/${nextDay(date)}';
  } else {
    params['dates'] =
        '${ymd(date)}T${time.replaceAll(':', '')}00/${ymd(date)}T${(endTime ?? time).replaceAll(':', '')}00';
    params['ctz'] = timezone;
  }
  if (details != null && details.isNotEmpty) params['details'] = details;
  if (location != null && location.isNotEmpty) params['location'] = location;
  return Uri.https(
    'calendar.google.com',
    '/calendar/render',
    params,
  ).toString();
}

/// A one-event iCalendar file (RFC 5545): UTC instants, or a DATE pair for all-day events.
String eventIcs(TripEvent e, {DateTime? now}) {
  String two(int n) => n.toString().padLeft(2, '0');
  String date(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}${two(d.month)}${two(d.day)}';
  String utc(DateTime d) {
    final u = d.toUtc();
    return '${date(u)}T${two(u.hour)}${two(u.minute)}${two(u.second)}Z';
  }

  String text(String s) => s
      .replaceAll(r'\', r'\\')
      .replaceAll(';', r'\;')
      .replaceAll(',', r'\,')
      .replaceAll(RegExp(r'\r?\n'), r'\n');
  // Lines longer than 75 octets are folded with CRLF + space.
  String fold(String line) {
    final bytes = utf8.encode(line);
    if (bytes.length <= 75) return line;
    final out = StringBuffer();
    var count = 0;
    for (final rune in line.runes) {
      final ch = String.fromCharCode(rune);
      final n = utf8.encode(ch).length;
      if (count + n > (out.isEmpty ? 75 : 74)) {
        out.write('\r\n ');
        count = 0;
      }
      out.write(ch);
      count += n;
    }
    return out.toString();
  }

  final lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Waypack//Trip//EN',
    'BEGIN:VEVENT',
    'UID:${e.start.millisecondsSinceEpoch}-${e.title.hashCode & 0x7fffffff}@waypack.app',
    'DTSTAMP:${utc(now ?? DateTime.now())}',
    if (e.allDay) ...[
      'DTSTART;VALUE=DATE:${date(e.start)}',
      'DTEND;VALUE=DATE:${date(e.end)}',
    ] else ...[
      'DTSTART:${utc(e.start)}',
      'DTEND:${utc(e.end)}',
    ],
    'SUMMARY:${text(e.title)}',
    if (e.location != null && e.location!.isNotEmpty)
      'LOCATION:${text(e.location!)}',
    if (e.notes != null && e.notes!.isNotEmpty) 'DESCRIPTION:${text(e.notes!)}',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return '${lines.map(fold).join('\r\n')}\r\n';
}

class CalendarHandoff {
  /// Adds to the device calendar with the system's own editor (works offline). On iPhone,
  /// app == "google" opens Google Calendar's add-event page instead (needs a connection).
  static Future<void> add(TripEvent e, {String app = 'auto'}) async {
    if ((Platform.isIOS || Platform.isMacOS) &&
        app == 'google' &&
        e.googleUrl != null) {
      await Handoff.openExternal(e.googleUrl!);
      return;
    }
    // Mac: no system "new event" sheet, so hand Calendar.app an .ics file (works offline).
    if (Platform.isMacOS) {
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/waypack-event.ics');
      await f.writeAsString(eventIcs(e));
      await launchUrl(Uri.file(f.path));
      return;
    }
    final start = e.allDay
        ? DateTime(e.start.year, e.start.month, e.start.day)
        : e.start.toLocal();
    final end = e.allDay
        ? DateTime(e.end.year, e.end.month, e.end.day)
        : e.end.toLocal();
    await cal.Add2Calendar.addEvent2Cal(
      cal.Event(
        title: e.title,
        description: e.notes,
        location: e.location,
        startDate: start,
        endDate: end,
        allDay: e.allDay,
        iosParams: const cal.IOSParams(reminder: Duration(minutes: 30)),
      ),
    );
  }

  /// iPhone/iPad/Mac: let the user pick Apple or Google. Android: the device calendar (Google Calendar) directly.
  static Future<void> choose(BuildContext context, TripEvent e) async {
    if (!Platform.isIOS && !Platform.isMacOS) return add(e);
    final app = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: Text(
                'Add "${e.title}"',
                style: Theme.of(ctx).textTheme.titleMedium,
              ),
            ),
            ListTile(
              leading: const Icon(Icons.event),
              title: const Text('Apple Calendar'),
              subtitle: const Text('Works offline'),
              onTap: () => Navigator.pop(ctx, 'apple'),
            ),
            if (e.googleUrl != null)
              ListTile(
                leading: const Icon(Icons.public),
                title: const Text('Google Calendar'),
                subtitle: const Text(
                  'Opens in the browser · needs a connection',
                ),
                onTap: () => Navigator.pop(ctx, 'google'),
              ),
          ],
        ),
      ),
    );
    if (app != null) await add(e, app: app);
  }
}
