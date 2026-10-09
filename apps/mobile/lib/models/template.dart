import 'dart:ui' show Color;

/// A trip template from the public gallery (services/mcp/src/lib/templates.ts, `TemplateCard`).
/// Dateless by design: only the month it was traveled, the crew's shape and the travelers' notes.
class TripTemplate {
  TripTemplate(this.raw);
  final Map<String, dynamic> raw;

  static const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  String get slug => raw['slug'] as String;
  String get title => raw['title'] as String? ?? '';
  String get tagline => raw['tagline'] as String? ?? '';
  String get region => raw['region'] as String? ?? '';
  double? get lat => (raw['lat'] as num?)?.toDouble();
  double? get lon => (raw['lon'] as num?)?.toDouble();
  int get days => (raw['days'] as num?)?.toInt() ?? 0;
  int get places => (raw['places'] as num?)?.toInt() ?? 0;

  /// YYYY-MM.
  String get traveled => raw['traveled'] as String? ?? '';
  int get travelMonth => int.tryParse(traveled.length >= 7 ? traveled.substring(5, 7) : '') ?? 1;
  String get traveledLabel =>
      '${months[(travelMonth - 1).clamp(0, 11)]} ${traveled.length >= 4 ? traveled.substring(0, 4) : ''}';
  List<int> get goodMonths =>
      ((raw['months'] as List?) ?? const []).map((e) => (e as num).toInt()).toList();
  String get season => raw['season'] as String? ?? '';
  String get pace => raw['pace'] as String? ?? '';
  String get gettingAround => raw['getting_around'] as String? ?? '';
  int get adults => ((raw['crew'] as Map?)?['adults'] as num?)?.toInt() ?? 2;
  List<int> get kids => (((raw['crew'] as Map?)?['kids'] as List?) ?? const [])
      .map((e) => (e as num).toInt())
      .toList();
  int get pets => ((raw['crew'] as Map?)?['pets'] as num?)?.toInt() ?? 0;
  List<String> get tags => ((raw['tags'] as List?) ?? const []).cast<String>();
  String? get startsFrom => raw['starts_from'] as String?;
  String? get author => raw['author'] as String?;
  bool get wouldGoAgain => raw['would_go_again'] as bool? ?? true;
  int get remixCount => (raw['remix_count'] as num?)?.toInt() ?? 0;
  String get url => raw['url'] as String? ?? '';
  List<String> get recheck => ((raw['recheck'] as List?) ?? const []).cast<String>();
  List<String> get reasons => ((raw['reasons'] as List?) ?? const []).cast<String>();
  Map<String, dynamic> get scene =>
      (raw['scene'] as Map?)?.cast<String, dynamic>() ?? const {};

  List<String> notes(String kind) =>
      (((raw['notes'] as Map?)?[kind] as List?) ?? const []).cast<String>();

  List<TemplateDay> get plan => ((raw['plan'] as List?) ?? const [])
      .map((d) => TemplateDay(d as Map<String, dynamic>))
      .toList();

  Color get accent {
    final a = raw['accent'] as String?;
    if (a != null && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(a)) {
      return Color(int.parse('FF${a.substring(1)}', radix: 16));
    }
    return const Color(0xFFC2562D);
  }

  String get crewLabel => [
    '$adults adult${adults == 1 ? '' : 's'}',
    if (kids.isNotEmpty) 'kids ${kids.join(' & ')}',
    if (pets > 0) 'dog',
  ].join(' · ');

  String get paceLabel =>
      pace.isEmpty ? '' : pace[0].toUpperCase() + pace.substring(1);

  String get moveLabel => switch (gettingAround) {
    'car' => 'Car',
    'transit' => 'Transit',
    'walking' => 'On foot',
    'bike' => 'Bike',
    'mixed' => 'Mixed',
    _ => gettingAround,
  };

  /// "3 days · Jan · Easy"
  String get facts => '$days days · ${months[travelMonth - 1]} · $paceLabel';
  String get plannedLabel =>
      remixCount == 0 ? 'New' : '$remixCount planned from it';

  /// What "Plan this trip" hands the user's agent (same wording as site/gallery.js).
  String prompt({String when = '', String who = '', String changes = ''}) => [
    'Using Waypack, plan a trip based on the template "$title": $url',
    'Start by reading it with get_template, then adapt it for me:',
    '- When: ${when.isEmpty ? 'ask me' : when}',
    "- Who's going: ${who.isEmpty ? 'ask me' : who}",
    if (changes.isNotEmpty) '- Changes: $changes',
    "Follow the travelers' notes, re-check what they flagged for my dates, and send me a live preview link while you work.",
  ].join('\n');
}

class TemplateDay {
  TemplateDay(this.raw);
  final Map<String, dynamic> raw;
  String get title => raw['title'] as String? ?? '';
  List<TemplateStop> get stops => ((raw['stops'] as List?) ?? const [])
      .map((s) => TemplateStop(s as Map<String, dynamic>))
      .toList();
}

class TemplateStop {
  TemplateStop(this.raw);
  final Map<String, dynamic> raw;
  String get name => raw['name'] as String? ?? '';
  double? get lat => (raw['lat'] as num?)?.toDouble();
  double? get lon => (raw['lon'] as num?)?.toDouble();
}

/// The magazine home: trip of the week, collections and the most planned.
class DiscoverHome {
  DiscoverHome(this.raw);
  final Map<String, dynamic> raw;
  int get total => (raw['total'] as num?)?.toInt() ?? 0;
  String get month => (raw['issue'] as Map?)?['month'] as String? ?? '';
  TripTemplate? get featured => raw['featured'] == null
      ? null
      : TripTemplate(raw['featured'] as Map<String, dynamic>);
  List<TripTemplate> _list(String k) => ((raw[k] as List?) ?? const [])
      .map((t) => TripTemplate(t as Map<String, dynamic>))
      .toList();
  List<TripTemplate> get inSeason => _list('in_season');
  List<TripTemplate> get mostPlanned => _list('most_planned');
  List<TripTemplate> get newest => _list('newest');
  List<DiscoverCollection> get collections =>
      ((raw['collections'] as List?) ?? const [])
          .map((c) => DiscoverCollection(c as Map<String, dynamic>))
          .toList();
}

class DiscoverCollection {
  DiscoverCollection(this.raw);
  final Map<String, dynamic> raw;
  String get name => raw['name'] as String? ?? '';
  Map<String, String> get query => ((raw['query'] as Map?) ?? const {})
      .map((k, v) => MapEntry(k as String, '$v'));
  List<TripTemplate> get items => ((raw['items'] as List?) ?? const [])
      .map((t) => TripTemplate(t as Map<String, dynamic>))
      .toList();
}
