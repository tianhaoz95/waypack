import 'package:timezone/timezone.dart' as tz;

import '../dev_flags.dart';
import '../models/manifest.dart';

enum TripPhase { before, during, after }

class TodayView {
  TodayView({required this.phase, required this.today, required this.nowTime, this.day, this.dayNumber = 0, this.nowIndex = -1, this.nextIndex = -1, this.daysUntil = 0});
  final TripPhase phase;
  final String today; // YYYY-MM-DD in the trip's time zone
  final String nowTime; // HH:MM in the trip's time zone
  final Day? day; // today's day (during) or day 1 (before)
  final int dayNumber;
  final int nowIndex;
  final int nextIndex;
  final int daysUntil;

  DayItem? get focus => day == null
      ? null
      : nowIndex >= 0
          ? day!.items[nowIndex]
          : nextIndex >= 0
              ? day!.items[nextIndex]
              : null;
  bool get focusIsNow => nowIndex >= 0;

  /// Item is finished if its end (or the next item's start) has passed.
  bool isDone(int i) {
    if (phase != TripPhase.during || day == null) return phase == TripPhase.after;
    final it = day!.items[i];
    if (it.time == null) return false;
    final end = it.endTime ?? (i + 1 < day!.items.length ? day!.items[i + 1].time : null) ?? '23:59';
    return end.compareTo(nowTime) <= 0;
  }
}

String _two(int n) => n.toString().padLeft(2, '0');

/// "Now" in the trip's time zone (falls back to device time if the zone is unknown).
(String, String) nowIn(String timezone, {DateTime? at}) {
  DateTime t;
  try {
    t = tz.TZDateTime.from(at ?? DevFlags.fakeNowTime ?? DateTime.now(), tz.getLocation(timezone));
  } catch (_) {
    t = at ?? DateTime.now();
  }
  return ('${t.year}-${_two(t.month)}-${_two(t.day)}', '${_two(t.hour)}:${_two(t.minute)}');
}

TodayView computeToday(Manifest m, {required String today, required String nowTime}) {
  int daysBetween(String a, String b) => DateTime.parse(b).difference(DateTime.parse(a)).inDays;
  if (today.compareTo(m.startDate) < 0) {
    return TodayView(phase: TripPhase.before, today: today, nowTime: nowTime, day: m.days.isEmpty ? null : m.days.first, dayNumber: 1, daysUntil: daysBetween(today, m.startDate));
  }
  if (today.compareTo(m.endDate) > 0) return TodayView(phase: TripPhase.after, today: today, nowTime: nowTime);
  final day = m.days.where((d) => d.date == today).firstOrNull;
  var nowIdx = -1, nextIdx = -1;
  if (day != null) {
    for (var i = 0; i < day.items.length; i++) {
      final it = day.items[i];
      if (it.time == null) continue;
      final end = it.endTime ?? (i + 1 < day.items.length ? day.items[i + 1].time : null) ?? '23:59';
      if (it.time!.compareTo(nowTime) <= 0 && nowTime.compareTo(end) < 0) nowIdx = i;
      if (nextIdx < 0 && it.time!.compareTo(nowTime) > 0) nextIdx = i;
    }
  }
  return TodayView(phase: TripPhase.during, today: today, nowTime: nowTime, day: day, dayNumber: daysBetween(m.startDate, today) + 1, nowIndex: nowIdx, nextIndex: nextIdx);
}
