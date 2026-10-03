/// Subset of manifest.json (schema v1) used by native features.
class Manifest {
  Manifest(this.raw);
  final Map<String, dynamic> raw;

  String get title => raw['title'] as String? ?? 'Trip';
  String? get summary => raw['summary'] as String?;
  String get timezone => raw['timezone'] as String? ?? 'UTC';
  String get startDate => raw['start_date'] as String;
  String get endDate => raw['end_date'] as String;
  String? get navApp => raw['nav_app'] as String?;

  late final List<Place> places =
      ((raw['places'] as List?) ?? const []).map((p) => Place(p as Map<String, dynamic>)).toList();
  late final Map<String, Place> placesById = {for (final p in places) p.id: p};
  late final List<Day> days = ((raw['days'] as List?) ?? const []).map((d) => Day(d as Map<String, dynamic>)).toList()
    ..sort((a, b) => a.date.compareTo(b.date));
  late final Map<String, Map<String, dynamic>> routesById = {
    for (final r in ((raw['routes'] as List?) ?? const []).cast<Map<String, dynamic>>()) r['id'] as String: r,
  };
  List<Map<String, String>> get emergencyNumbers => (((raw['emergency'] as Map?)?['numbers'] as List?) ?? const [])
      .map((e) => {'label': '${e['label']}', 'value': '${e['value']}'})
      .toList();
}

class Place {
  Place(this.raw);
  final Map<String, dynamic> raw;
  String get id => raw['id'] as String;
  String get name => raw['name'] as String;
  String get category => raw['category'] as String? ?? 'other';
  double get lat => (raw['lat'] as num).toDouble();
  double get lon => (raw['lon'] as num).toDouble();
  String? get address => raw['address'] as String?;
  String? get phone => raw['phone'] as String?;
  String? get notes => raw['notes'] as String?;
}

class Day {
  Day(this.raw);
  final Map<String, dynamic> raw;
  String get date => raw['date'] as String;
  String? get title => raw['title'] as String?;
  late final List<DayItem> items = ((raw['items'] as List?) ?? const []).map((i) => DayItem(i as Map<String, dynamic>)).toList();
}

class DayItem {
  DayItem(this.raw);
  final Map<String, dynamic> raw;
  String? get time => raw['time'] as String?;
  String? get endTime => raw['end_time'] as String?;
  String get title => raw['title'] as String;
  String? get placeId => raw['place_id'] as String?;
  String? get routeId => raw['route_id'] as String?;
  String? get kind => raw['kind'] as String?;
  String? get notes => raw['notes'] as String?;
}
