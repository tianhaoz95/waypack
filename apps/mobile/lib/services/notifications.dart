import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_timezone/flutter_timezone.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

/// Local reminder 72 h before a trip starts if it isn't downloaded (design §8.3).
class Reminders {
  static final _plugin = FlutterLocalNotificationsPlugin();
  static bool _ready = false;

  static Future<void> init() async {
    tzdata.initializeTimeZones();
    try {
      final local = await FlutterTimezone.getLocalTimezone();
      tz.setLocalLocation(tz.getLocation(local.identifier));
    } catch (_) {
      /* keep UTC */
    }
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
        ),
      ),
    );
    _ready = true;
  }

  static Future<void> requestPermission() async {
    await _plugin
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >()
        ?.requestPermissions(alert: true, sound: true);
    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.requestNotificationsPermission();
  }

  static int _id(String tripId) => tripId.hashCode & 0x7fffffff;

  /// Schedules (or cancels) the "download before you go" reminder for a trip.
  static Future<void> sync({
    required String tripId,
    required String title,
    required String? startDate,
    required bool downloaded,
  }) async {
    if (!_ready) return;
    final id = _id(tripId);
    await _plugin.cancel(id: id);
    if (downloaded || startDate == null) return;
    final start = DateTime.tryParse(startDate);
    if (start == null) return;
    final now = tz.TZDateTime.now(tz.local);
    // 9:00 local, three days before the start date.
    var when = tz.TZDateTime(
      tz.local,
      start.year,
      start.month,
      start.day,
      9,
    ).subtract(const Duration(hours: 72));
    final tripStart = tz.TZDateTime(
      tz.local,
      start.year,
      start.month,
      start.day,
    );
    if (!tripStart.isAfter(now)) return; // already started
    if (when.isBefore(now)) when = now.add(const Duration(minutes: 1));
    await _plugin.zonedSchedule(
      id: id,
      title: 'Download "$title" before you go',
      body: 'Your trip starts soon and isn\'t saved for offline use yet. Open Waypack and tap Download while you have signal.',
      scheduledDate: when,
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          'trip-reminders',
          'Trip reminders',
          importance: Importance.high,
        ),
        iOS: DarwinNotificationDetails(),
      ),
      androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
      payload: tripId,
    );
  }
}
