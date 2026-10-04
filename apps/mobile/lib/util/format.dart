import 'package:intl/intl.dart';

String formatBytes(int b) {
  if (b < 1024) return '$b B';
  if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(0)} KB';
  if (b < 1024 * 1024 * 1024) return '${(b / 1048576).toStringAsFixed(1)} MB';
  return '${(b / 1073741824).toStringAsFixed(2)} GB';
}

DateTime? _d(String? s) => s == null ? null : DateTime.tryParse(s);

String dateRange(String? start, String? end) {
  final a = _d(start), b = _d(end);
  if (a == null) return '';
  final md = DateFormat.MMMd();
  if (b == null || a == b) return DateFormat.yMMMd().format(a);
  if (a.year != b.year) {
    return '${DateFormat.yMMMd().format(a)} – ${DateFormat.yMMMd().format(b)}';
  }
  return '${md.format(a)} – ${md.format(b)}, ${b.year}';
}

String relativeTime(DateTime t) {
  final d = DateTime.now().difference(t);
  if (d.inMinutes < 1) return 'just now';
  if (d.inHours < 1) return '${d.inMinutes} min ago';
  if (d.inDays < 1) return '${d.inHours} h ago';
  return DateFormat.yMMMd().add_jm().format(t);
}

/// "14:30" → locale time ("2:30 PM").
String formatHm(String? hm) {
  if (hm == null || !RegExp(r'^\d{2}:\d{2}$').hasMatch(hm)) return hm ?? '';
  final parts = hm.split(':');
  return DateFormat.jm().format(
    DateTime(2000, 1, 1, int.parse(parts[0]), int.parse(parts[1])),
  );
}
