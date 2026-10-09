import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config.dart';
import '../models/template.dart';
import '../services/api.dart';
import '../state/app_state.dart';
import '../widgets/postcard.dart';
import '../widgets/scrapbook.dart';

/// Trip gallery (DECISIONS #66): Discover is a magazine (trip of the week, collections, most
/// planned); search shows the same results as postcards or on a map; a template page is the
/// postcard, the travelers' notes, the route and a "Plan this trip" hand-off to the user's agent.

Api _api(BuildContext context) => context.read<AppState>().api;

void openTemplate(BuildContext context, TripTemplate t) => Navigator.push(
  context,
  MaterialPageRoute(
    settings: RouteSettings(name: 'Template', arguments: t.slug),
    builder: (_) => TemplateScreen(slug: t.slug, initial: t),
  ),
);

void openSearch(
  BuildContext context, {
  Map<String, String> query = const {},
  bool map = false,
  String? title,
}) => Navigator.push(
  context,
  MaterialPageRoute(
    settings: const RouteSettings(name: 'TemplateSearch'),
    builder: (_) => TemplateSearchScreen(
      initialQuery: query,
      startOnMap: map,
      title: title,
    ),
  ),
);

// ───────────────────────────── Discover home (magazine)

class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key});
  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  DiscoverHome? _home;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final h = await _api(context).discoverHome();
      if (mounted) setState(() => _home = h);
    } catch (e) {
      if (mounted) {
        setState(
          () => _error =
              "The gallery couldn't load. Check your connection and try again.",
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    final h = _home;
    return KraftScaffold(
      title: 'The Waypack Journal',
      subtitle: h == null
          ? 'Trips people actually took'
          : '${h.month} · trips people actually took',
      maxWidth: 900,
      body: _error != null
          ? _Retry(message: _error!, onRetry: _load)
          : h == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.only(bottom: 40),
                children: [
                  _SearchPill(
                    onTap: () => openSearch(context),
                    onMap: () => openSearch(context, map: true),
                  ),
                  if (h.total == 0)
                    const _Welcome()
                  else ...[
                    if (h.featured != null) _Hero(t: h.featured!),
                    if (h.inSeason.isNotEmpty)
                      _Row(
                        title: 'Good in ${h.month}',
                        items: h.inSeason,
                        onAll: () => openSearch(
                          context,
                          query: {'month': '${DateTime.now().month}'},
                          title: 'Good in ${h.month}',
                        ),
                      ),
                    for (final c in h.collections)
                      _Row(
                        title: c.name,
                        items: c.items,
                        onAll: () =>
                            openSearch(context, query: c.query, title: c.name),
                      ),
                    if (h.mostPlanned.isNotEmpty) ...[
                      const SectionTitle('Most planned'),
                      PaperCard(
                        children: [
                          for (final (i, t) in h.mostPlanned.indexed)
                            InkWell(
                              onTap: () => openTemplate(context, t),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 14,
                                  vertical: 11,
                                ),
                                child: Row(
                                  children: [
                                    SizedBox(
                                      width: 26,
                                      child: Text(
                                        '${i + 1}',
                                        style: hand(26, p.accent),
                                      ),
                                    ),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            t.title,
                                            style: const TextStyle(
                                              fontSize: 15,
                                              fontWeight: FontWeight.w600,
                                            ),
                                          ),
                                          Text(
                                            t.facts,
                                            style: TextStyle(
                                              fontSize: 12,
                                              color: p.muted,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    Text(
                                      '${t.remixCount}',
                                      style: TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.w700,
                                        color: p.muted,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      ),
                    ],
                    Padding(
                      padding: const EdgeInsets.fromLTRB(18, 22, 18, 0),
                      child: PaperButton(
                        key: const Key('discover-browse-all'),
                        label: 'Browse all ${h.total} trips',
                        kind: PaperButtonKind.secondary,
                        expand: true,
                        onPressed: () => openSearch(context),
                      ),
                    ),
                    const _ShareNote(),
                  ],
                ],
              ),
            ),
    );
  }
}

class _SearchPill extends StatelessWidget {
  const _SearchPill({required this.onTap, required this.onMap});
  final VoidCallback onTap, onMap;
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 2, 18, 6),
      child: Material(
        color: p.card,
        shape: const StadiumBorder(),
        elevation: 1,
        shadowColor: const Color(0x553C2814),
        child: InkWell(
          key: const Key('discover-search'),
          customBorder: const StadiumBorder(),
          onTap: onTap,
          child: SizedBox(
            height: 48,
            child: Row(
              children: [
                const SizedBox(width: 16),
                Icon(Icons.search, size: 20, color: p.muted),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    "Search places, seasons, who's going",
                    style: TextStyle(fontSize: 14.5, color: p.muted),
                  ),
                ),
                IconButton(
                  tooltip: 'Map',
                  onPressed: onMap,
                  icon: Icon(Icons.map_outlined, color: p.muted),
                ),
                const SizedBox(width: 4),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.t});
  final TripTemplate t;
  @override
  Widget build(BuildContext context) {
    final quote = t.notes('kept').isNotEmpty
        ? '“${t.notes('kept').first}”'
        : t.tagline;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 0),
      child: Semantics(
        button: true,
        label: 'Trip of the week: ${t.title}',
        child: GestureDetector(
          onTap: () => openTemplate(context, t),
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(4),
              boxShadow: paperShadow,
            ),
            clipBehavior: Clip.antiAlias,
            child: AspectRatio(
              aspectRatio: 1 / .9,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  CustomPaint(painter: TemplateScenePainter(t.scene, t.accent)),
                  const DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment(0, .1),
                        end: Alignment.bottomCenter,
                        colors: [Color(0x00000000), Color(0xB31E140C)],
                      ),
                    ),
                  ),
                  Positioned(
                    left: 18,
                    right: 18,
                    bottom: 16,
                    child: ExcludeSemantics(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'TRIP OF THE WEEK',
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 11,
                              fontWeight: FontWeight.w900,
                              letterSpacing: 1.3,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(t.title, style: hand(40, Colors.white)),
                          const SizedBox(height: 6),
                          Text(
                            '$quote · ${t.author ?? 'a Waypacker'}, ${t.traveledLabel}',
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                              height: 1.35,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.title, required this.items, required this.onAll});
  final String title;
  final List<TripTemplate> items;
  final VoidCallback onAll;
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 24, 12, 8),
          child: Row(
            children: [
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(title, style: hand(28, p.ink)),
                ),
              ),
              TextButton(onPressed: onAll, child: const Text('See all')),
            ],
          ),
        ),
        SizedBox(
          height: 192,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(18, 4, 18, 4),
            itemCount: items.length,
            separatorBuilder: (_, _) => const SizedBox(width: 14),
            itemBuilder: (_, i) => SizedBox(
              width: 172,
              child: PostcardTile(
                t: items[i],
                tilt: i.isOdd ? 1 : -1,
                titleLines: 1,
                onTap: () => openTemplate(context, items[i]),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _ShareNote extends StatelessWidget {
  const _ShareNote();
  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.fromLTRB(22, 28, 22, 0),
    child: StickyNote(
      tape: 1,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'After a trip you loved…',
            style: TextStyle(
              fontFamily: 'Caveat',
              fontSize: 24,
              fontWeight: FontWeight.w700,
              height: 1,
            ),
          ),
          SizedBox(height: 6),
          Text(
            'Ask your agent to "turn my Waypack trip into a template". It asks what you\'d keep, cut and what surprised you, removes dates and names, and shows you the draft before anything is public.',
            style: TextStyle(fontSize: 13.5, height: 1.45),
          ),
        ],
      ),
    ),
  );
}

class _Welcome extends StatelessWidget {
  const _Welcome();
  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.fromLTRB(22, 24, 22, 0),
    child: StickyNote(
      tape: 0,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'The gallery is just opening',
            style: TextStyle(
              fontFamily: 'Caveat',
              fontSize: 28,
              fontWeight: FontWeight.w700,
              height: 1,
            ),
          ),
          SizedBox(height: 8),
          Text(
            "Plans appear here when travelers share a trip they took, with what worked, what they'd cut and what surprised them. After your next trip, ask your agent to \"turn my Waypack trip into a template\".",
            style: TextStyle(fontSize: 14, height: 1.45),
          ),
        ],
      ),
    ),
  );
}

class _Retry extends StatelessWidget {
  const _Retry({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 14),
          PaperButton(
            label: 'Try again',
            icon: Icons.refresh,
            onPressed: onRetry,
          ),
        ],
      ),
    ),
  );
}

// ───────────────────────────── Search: postcards ⇄ map

class TemplateSearchScreen extends StatefulWidget {
  const TemplateSearchScreen({
    super.key,
    this.initialQuery = const {},
    this.startOnMap = false,
    this.title,
  });
  final Map<String, String> initialQuery;
  final bool startOnMap;
  final String? title;
  @override
  State<TemplateSearchScreen> createState() => _TemplateSearchScreenState();
}

/// Filter chips: [key, value, label]. One value per key at a time.
const _filters = [
  ['season', 'winter', 'Winter'],
  ['season', 'spring', 'Spring'],
  ['season', 'summer', 'Summer'],
  ['season', 'autumn', 'Autumn'],
  ['length', 'weekend', 'Weekend'],
  ['length', 'mid', '4–6 days'],
  ['length', 'long', 'A week+'],
  ['who', 'kids', 'With kids'],
  ['who', 'couple', 'Couple'],
  ['who', 'friends', 'Friends'],
  ['who', 'dog', 'Dog OK'],
  ['move', 'nocar', 'No car'],
];

class _TemplateSearchScreenState extends State<TemplateSearchScreen> {
  late final Map<String, String> _q = {...widget.initialQuery};
  late bool _map = widget.startOnMap;
  late final _text = TextEditingController(
    text: widget.initialQuery['q'] ?? '',
  );
  List<TripTemplate>? _results;
  String? _error;
  String? _selected;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _search();
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    final seq = ++_seq;
    setState(() => _error = null);
    try {
      final r = await _api(context).searchTemplates(_q);
      if (mounted && seq == _seq) setState(() => _results = r);
    } catch (e) {
      if (mounted && seq == _seq) {
        setState(
          () => _error = "Search failed. Check your connection and try again.",
        );
      }
    }
  }

  void _toggle(String k, String v) {
    setState(() => _q[k] == v ? _q.remove(k) : _q[k] = v);
    _search();
  }

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    final r = _results;
    return Scaffold(
      backgroundColor: p.bg,
      body: Kraft(
        child: SafeArea(
          bottom: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
                child: Row(
                  children: [
                    RoundButton(
                      tooltip: 'Back',
                      icon: Icons.arrow_back_ios_new,
                      iconSize: 17,
                      onPressed: () => Navigator.maybePop(context),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Material(
                        color: p.card,
                        shape: StadiumBorder(
                          side: BorderSide(
                            color: p.accent.withValues(alpha: .45),
                            width: 2,
                          ),
                        ),
                        child: TextField(
                          key: const Key('template-search-field'),
                          controller: _text,
                          textInputAction: TextInputAction.search,
                          onSubmitted: (v) {
                            v.trim().isEmpty
                                ? _q.remove('q')
                                : _q['q'] = v.trim();
                            _search();
                          },
                          decoration: InputDecoration(
                            hintText:
                                widget.title ??
                                "Search places, seasons, who's going",
                            prefixIcon: const Icon(Icons.search, size: 20),
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            filled: false,
                            contentPadding: const EdgeInsets.symmetric(
                              vertical: 12,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
                child: Row(
                  children: [
                    // Both shrink rather than overflow with large text.
                    Flexible(
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: _ViewSwitch(
                          map: _map,
                          onChanged: (m) => setState(() => _map = m),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerRight,
                        child: TextButton.icon(
                          key: const Key('template-sort'),
                          onPressed: () {
                            setState(
                              () => _q['sort'] == 'new'
                                  ? _q.remove('sort')
                                  : _q['sort'] = 'new',
                            );
                            _search();
                          },
                          icon: const Icon(Icons.swap_vert, size: 18),
                          label: Text(
                            _q['sort'] == 'new' ? 'Newest' : 'Most planned',
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              SizedBox(
                height: 40,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 18),
                  children: [
                    if (_q['month'] != null)
                      _FilterChip(
                        label:
                            '${TripTemplate.months[int.parse(_q['month']!) - 1]} ✕',
                        on: true,
                        index: 0,
                        onTap: () => _toggle('month', _q['month']!),
                      ),
                    for (final (i, f) in _filters.indexed)
                      _FilterChip(
                        label: f[2],
                        on: _q[f[0]] == f[1],
                        index: i,
                        onTap: () => _toggle(f[0], f[1]),
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 6),
                child: Text(
                  r == null
                      ? ''
                      : '${r.length} trip${r.length == 1 ? '' : 's'}',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: p.muted,
                  ),
                ),
              ),
              Expanded(
                child: _error != null
                    ? _Retry(message: _error!, onRetry: _search)
                    : r == null
                    ? const Center(child: CircularProgressIndicator())
                    : r.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(28),
                          child: Text(
                            'Nothing matches. Try fewer filters or another place.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: p.muted),
                          ),
                        ),
                      )
                    : _map
                    ? _MapView(
                        results: r,
                        selected: _selected,
                        onSelect: (s) => setState(() => _selected = s),
                      )
                    : GridView.builder(
                        key: const Key('template-grid'),
                        padding: const EdgeInsets.fromLTRB(18, 8, 18, 40),
                        gridDelegate:
                            const SliverGridDelegateWithMaxCrossAxisExtent(
                              maxCrossAxisExtent: 220,
                              mainAxisSpacing: 18,
                              crossAxisSpacing: 14,
                              childAspectRatio: .86,
                            ),
                        itemCount: r.length,
                        itemBuilder: (_, i) => PostcardTile(
                          t: r[i],
                          tilt: const [-1.4, 1.2, .8, -.9][i % 4],
                          showPlanned: true,
                          onTap: () => openTemplate(context, r[i]),
                        ),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ViewSwitch extends StatelessWidget {
  const _ViewSwitch({required this.map, required this.onChanged});
  final bool map;
  final ValueChanged<bool> onChanged;
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    Widget seg(String label, IconData icon, bool on, bool value, Key key) =>
        Semantics(
          button: true,
          selected: on,
          child: GestureDetector(
            key: key,
            onTap: () => onChanged(value),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 150),
              height: 34,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                color: on ? p.card : Colors.transparent,
                borderRadius: BorderRadius.circular(17),
                boxShadow: on
                    ? const [
                        BoxShadow(
                          color: Color(0x333C2814),
                          blurRadius: 3,
                          offset: Offset(0, 1),
                        ),
                      ]
                    : null,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, size: 16, color: on ? p.ink : p.muted),
                  const SizedBox(width: 6),
                  Text(
                    label,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      color: on ? p.ink : p.muted,
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: p.ink.withValues(alpha: .08),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          seg(
            'Postcards',
            Icons.grid_view_rounded,
            !map,
            false,
            const Key('view-postcards'),
          ),
          seg('Map', Icons.map_outlined, map, true, const Key('view-map')),
        ],
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.label,
    required this.on,
    required this.onTap,
    required this.index,
  });
  final String label;
  final bool on;
  final int index;
  final VoidCallback onTap;
  static const _colors = [ChipColor.pink, ChipColor.mint, ChipColor.yellow];
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(right: 6),
    child: Semantics(
      button: true,
      selected: on,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 13),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _colors[index % 3],
            borderRadius: BorderRadius.circular(2),
            border: on
                ? Border.all(color: const Color(0x733C2814), width: 2)
                : null,
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 13,
              fontWeight: on ? FontWeight.w800 : FontWeight.w600,
              color: Paper.captionInk,
            ),
          ),
        ),
      ),
    ),
  );
}

/// Map mode: pan/zoom the stylised world map; pins and a postcard carousel stay in sync.
class _MapView extends StatefulWidget {
  const _MapView({
    required this.results,
    required this.selected,
    required this.onSelect,
  });
  final List<TripTemplate> results;
  final String? selected;
  final ValueChanged<String?> onSelect;
  @override
  State<_MapView> createState() => _MapViewState();
}

class _MapViewState extends State<_MapView> {
  List<List<double>>? _land;
  Rect? _view;
  Rect? _startView;
  Offset? _startFocal;
  Size _size = Size.zero;
  final _carousel = ScrollController();

  @override
  void initState() {
    super.initState();
    LandData.load().then((l) {
      if (mounted) setState(() => _land = l);
    });
  }

  @override
  void didUpdateWidget(_MapView old) {
    super.didUpdateWidget(old);
    if (old.results != widget.results) _view = null;
  }

  @override
  void dispose() {
    _carousel.dispose();
    super.dispose();
  }

  Rect _fit(Size size) {
    final pts = widget.results
        .where((t) => t.lat != null && t.lon != null)
        .toList();
    var x0 = -170.0, y0 = -75.0, x1 = 190.0, y1 = 60.0;
    if (pts.isNotEmpty) {
      x0 = pts.map((t) => t.lon!).reduce(math.min);
      x1 = pts.map((t) => t.lon!).reduce(math.max);
      y0 = pts.map((t) => -t.lat!).reduce(math.min);
      y1 = pts.map((t) => -t.lat!).reduce(math.max);
    }
    var w = math.max(x1 - x0, 12) * 1.25 + 6,
        h = math.max(y1 - y0, 8) * 1.25 + 6;
    final asp = size.width / math.max(1, size.height);
    if (w / h < asp) {
      w = h * asp;
    } else {
      h = w / asp;
    }
    return Rect.fromCenter(
      center: Offset((x0 + x1) / 2, (y0 + y1) / 2),
      width: w,
      height: h,
    );
  }

  void _zoom(double f, Offset focal) {
    final v = _view!;
    final m = Offset(
      v.left + focal.dx / _size.width * v.width,
      v.top + focal.dy / _size.height * v.height,
    );
    final w = (v.width * f).clamp(1.5, 400.0), k = w / v.width;
    setState(
      () => _view = Rect.fromLTWH(
        m.dx - (m.dx - v.left) * k,
        m.dy - (m.dy - v.top) * k,
        w,
        v.height * k,
      ),
    );
  }

  void _tapAt(Offset pos) {
    final v = _view!;
    String? best;
    var bestD = 26.0;
    for (final t in widget.results) {
      if (t.lat == null || t.lon == null) continue;
      final o = Offset(
        (t.lon! - v.left) / v.width * _size.width,
        (-t.lat! - v.top) / v.height * _size.height,
      );
      final d = (o - pos).distance;
      if (d < bestD) {
        bestD = d;
        best = t.slug;
      }
    }
    widget.onSelect(best);
    if (best != null) {
      final i = widget.results.indexWhere((t) => t.slug == best);
      if (_carousel.hasClients) {
        _carousel.animateTo(
          (i * 184.0).clamp(0, _carousel.position.maxScrollExtent),
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Column(
      children: [
        Expanded(
          child: LayoutBuilder(
            builder: (context, c) {
              _size = c.biggest;
              _view ??= _fit(_size);
              return ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Stack(
                  children: [
                    GestureDetector(
                      key: const Key('template-map'),
                      onTapUp: (d) => _tapAt(d.localPosition),
                      onScaleStart: (d) {
                        _startView = _view;
                        _startFocal = d.localFocalPoint;
                      },
                      onScaleUpdate: (d) {
                        final s = _startView!, f0 = _startFocal!;
                        final w = (s.width / d.scale).clamp(1.5, 400.0),
                            k = w / s.width;
                        final m = Offset(
                          s.left + f0.dx / _size.width * s.width,
                          s.top + f0.dy / _size.height * s.height,
                        );
                        final moved = d.localFocalPoint - f0;
                        setState(
                          () => _view = Rect.fromLTWH(
                            m.dx -
                                (m.dx - s.left) * k -
                                moved.dx / _size.width * w,
                            m.dy -
                                (m.dy - s.top) * k -
                                moved.dy / _size.height * s.height * k,
                            w,
                            s.height * k,
                          ),
                        );
                      },
                      child: CustomPaint(
                        size: _size,
                        painter: WorldMapPainter(
                          rings: _land ?? const [],
                          view: _view!,
                          pins: widget.results,
                          selected: widget.selected,
                          dark: dark,
                        ),
                      ),
                    ),
                    Positioned(
                      right: 12,
                      top: 12,
                      child: Column(
                        children: [
                          RoundButton(
                            tooltip: 'Zoom in',
                            icon: Icons.add,
                            onPressed: () =>
                                _zoom(1 / 1.6, _size.center(Offset.zero)),
                          ),
                          const SizedBox(height: 8),
                          RoundButton(
                            tooltip: 'Zoom out',
                            icon: Icons.remove,
                            onPressed: () =>
                                _zoom(1.6, _size.center(Offset.zero)),
                          ),
                        ],
                      ),
                    ),
                    Positioned(
                      right: 8,
                      bottom: 4,
                      child: Text(
                        'Natural Earth',
                        style: TextStyle(
                          fontSize: 10,
                          color: Paper.of(context).muted,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
        SizedBox(
          height: 200,
          child: ListView.separated(
            key: const Key('template-carousel'),
            controller: _carousel,
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
            itemCount: widget.results.length,
            separatorBuilder: (_, _) => const SizedBox(width: 14),
            itemBuilder: (_, i) {
              final t = widget.results[i];
              return SizedBox(
                width: 170,
                child: PostcardTile(
                  t: t,
                  selected: t.slug == widget.selected,
                  titleLines: 1,
                  onTap: () => openTemplate(context, t),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

// ───────────────────────────── Template page

class TemplateScreen extends StatefulWidget {
  const TemplateScreen({super.key, required this.slug, this.initial});
  final String slug;
  final TripTemplate? initial;
  @override
  State<TemplateScreen> createState() => _TemplateScreenState();
}

class _TemplateScreenState extends State<TemplateScreen> {
  late TripTemplate? _t = widget.initial;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final t = await _api(context).template(widget.slug);
      if (mounted) setState(() => _t = t);
    } on ApiException catch (e) {
      if (mounted && _t == null) {
        setState(
          () => _error = e.status == 404
              ? "This trip isn't in the gallery anymore."
              : e.message,
        );
      }
    } catch (_) {
      if (mounted && _t == null) {
        setState(
          () => _error = "This trip couldn't load. Check your connection.",
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = _t;
    final p = Paper.of(context);
    return KraftScaffold(
      title: t?.title ?? '',
      subtitle: t == null ? null : '${t.region} · ${t.facts}',
      actions: [
        if (t != null && t.url.isNotEmpty)
          RoundButton(
            tooltip: 'Share',
            icon: Icons.ios_share,
            onPressed: () => SharePlus.instance.share(
              ShareParams(uri: Uri.parse(t.url), subject: t.title),
            ),
          ),
      ],
      body: _error != null
          ? _Retry(
              message: _error!,
              onRetry: () {
                setState(() => _error = null);
                _load();
              },
            )
          : t == null
          ? const Center(child: CircularProgressIndicator())
          : Stack(
              children: [
                ListView(
                  padding: const EdgeInsets.only(bottom: 120),
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                      child: Postcard(t: t, big: true, tilt: -1.2),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
                      child: Wrap(
                        spacing: 14,
                        runSpacing: 8,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Stamp(
                            label: 'Traveled ${t.traveledLabel}',
                            color: p.ok,
                            icon: Icons.check,
                          ),
                          Text(
                            '✦ ${t.plannedLabel}',
                            style: TextStyle(
                              fontSize: 13,
                              color: p.muted,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
                      child: Text(
                        t.tagline,
                        style: TextStyle(
                          fontSize: 16,
                          height: 1.4,
                          color: p.muted,
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(18, 18, 18, 0),
                      child: _PostcardBack(t: t),
                    ),
                    if (RouteMapPainter.canDraw(t)) ...[
                      SectionTitle('The route', note: '${t.places} places'),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 18),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: AspectRatio(
                            aspectRatio: 1.8,
                            child: CustomPaint(
                              painter: RouteMapPainter(
                                t,
                                dark:
                                    Theme.of(context).brightness ==
                                    Brightness.dark,
                              ),
                            ),
                          ),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
                        child: Wrap(
                          spacing: 14,
                          children: [
                            for (var i = 0; i < t.plan.length; i++)
                              Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Container(
                                    width: 18,
                                    height: 4,
                                    decoration: BoxDecoration(
                                      color: dayColor(i),
                                      borderRadius: BorderRadius.circular(2),
                                    ),
                                  ),
                                  const SizedBox(width: 5),
                                  Text(
                                    'Day ${i + 1}',
                                    style: const TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                ],
                              ),
                          ],
                        ),
                      ),
                    ],
                    const SectionTitle('Day by day'),
                    PaperCard(
                      children: [
                        for (final (i, d) in t.plan.indexed)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                SizedBox(
                                  width: 52,
                                  child: Text(
                                    'Day ${i + 1}',
                                    style: TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w800,
                                      color: dayColor(i),
                                    ),
                                  ),
                                ),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        d.title,
                                        style: const TextStyle(
                                          fontSize: 15,
                                          fontWeight: FontWeight.w700,
                                        ),
                                      ),
                                      const SizedBox(height: 3),
                                      Text(
                                        d.stops.map((s) => s.name).join(' · '),
                                        style: TextStyle(
                                          fontSize: 13,
                                          height: 1.45,
                                          color: p.muted,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                    if (t.recheck.isNotEmpty) ...[
                      const SectionTitle('Your agent re-checks'),
                      for (final r in t.recheck)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(22, 3, 22, 3),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(
                                Icons.refresh,
                                size: 16,
                                color: Color(0xFF3E7A8C),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  r,
                                  style: const TextStyle(fontSize: 14),
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ],
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [p.bg.withValues(alpha: 0), p.bg],
                        stops: const [0, .3],
                      ),
                    ),
                    child: SafeArea(
                      top: false,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(20, 22, 20, 12),
                        child: PaperButton(
                          key: const Key('plan-this-trip'),
                          label: 'Plan this trip',
                          icon: Icons.auto_awesome,
                          expand: true,
                          onPressed: () => showPaperSheet<void>(
                            context,
                            builder: (_) => PlanSheet(t: t),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}

/// The back of the postcard: the travelers' notes in handwriting, the facts as address lines.
class _PostcardBack extends StatelessWidget {
  const _PostcardBack({required this.t});
  final TripTemplate t;
  @override
  Widget build(BuildContext context) {
    const kinds = [
      ('kept', 'KEPT', Color(0xFF4F8A62)),
      ('cut', 'WOULD CUT', Color(0xFFC0432B)),
      ('surprise', 'SURPRISED US', Color(0xFFB87810)),
    ];
    Widget line(String k, String v) => Container(
      width: double.infinity,
      padding: const EdgeInsets.only(top: 4, bottom: 5),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0x4D785A3C))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            k,
            style: const TextStyle(
              fontSize: 9.5,
              fontWeight: FontWeight.w800,
              letterSpacing: .8,
              color: Paper.captionMuted,
            ),
          ),
          Text(
            v,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
              height: 1.3,
            ),
          ),
        ],
      ),
    );
    final notes = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Dear future traveler,', style: hand(21, Paper.captionInk)),
        for (final (k, label, color) in kinds)
          for (final n in t.notes(k))
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(
                      text: '$label  ',
                      style: TextStyle(
                        fontSize: 9.5,
                        fontWeight: FontWeight.w800,
                        letterSpacing: .8,
                        color: color,
                      ),
                    ),
                    TextSpan(
                      text: n,
                      style: hand(19, Paper.captionInk).copyWith(height: 1.1),
                    ),
                  ],
                ),
              ),
            ),
        Align(
          alignment: Alignment.centerRight,
          child: Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              '— ${t.author ?? 'a Waypacker'}',
              style: hand(19, Paper.captionInk),
            ),
          ),
        ),
      ],
    );
    final address = Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Postmark(t: t, size: 54),
        const SizedBox(height: 4),
        line('WHO', t.crewLabel),
        line('WHEN', '${t.season}, ${t.days} days'),
        line('PACE', '${t.paceLabel} · ${t.moveLabel}'),
        if (t.startsFrom != null) line('FROM', t.startsFrom!),
        line('WOULD GO AGAIN', t.wouldGoAgain ? 'Yes' : 'Not sure'),
      ],
    );
    return PaperObject(
      tilt: .6,
      tape: 1,
      padding: const EdgeInsets.fromLTRB(14, 16, 14, 14),
      child: LayoutBuilder(
        builder: (context, c) => c.maxWidth < 330
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [notes, const SizedBox(height: 14), address],
              )
            : Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(flex: 5, child: notes),
                  Container(
                    width: 1.5,
                    height: 220,
                    margin: const EdgeInsets.symmetric(horizontal: 12),
                    color: const Color(0x40785A3C),
                  ),
                  Expanded(flex: 4, child: address),
                ],
              ),
      ),
    );
  }
}

/// "Plan this trip": the prompt for the user's own agent (Claude, or copy for any MCP agent).
class PlanSheet extends StatefulWidget {
  const PlanSheet({super.key, required this.t});
  final TripTemplate t;
  @override
  State<PlanSheet> createState() => _PlanSheetState();
}

class _PlanSheetState extends State<PlanSheet> {
  final _when = TextEditingController(),
      _who = TextEditingController(),
      _changes = TextEditingController();

  @override
  void dispose() {
    _when.dispose();
    _who.dispose();
    _changes.dispose();
    super.dispose();
  }

  String get _prompt => widget.t.prompt(
    when: _when.text.trim(),
    who: _who.text.trim(),
    changes: _changes.text.trim(),
  );

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    InputDecoration dec(String label, String hint) =>
        InputDecoration(labelText: label, hintText: hint);
    return Padding(
      padding: EdgeInsets.fromLTRB(
        22,
        0,
        22,
        MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Plan this trip', style: hand(34, p.ink)),
          const SizedBox(height: 6),
          Text(
            'Your AI agent adapts it to your dates and group, follows the travelers\' notes, re-checks hours and conditions, and sends it here for offline use.',
            style: TextStyle(fontSize: 13.5, height: 1.45, color: p.muted),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _when,
            onChanged: (_) => setState(() {}),
            decoration: dec('When', 'e.g. Feb 13–15'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _who,
            onChanged: (_) => setState(() {}),
            decoration: dec("Who's going", 'e.g. 2 adults, a 7-year-old'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _changes,
            onChanged: (_) => setState(() {}),
            decoration: dec(
              'Anything to change? (optional)',
              'e.g. no drives over 2 hours',
            ),
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFF2B231D),
              borderRadius: BorderRadius.circular(8),
            ),
            child: SelectableText(
              _prompt,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 12,
                height: 1.5,
                color: Color(0xFFF3EADB),
              ),
            ),
          ),
          const SizedBox(height: 14),
          PaperButton(
            key: const Key('open-in-claude'),
            label: 'Open in Claude',
            icon: Icons.auto_awesome,
            expand: true,
            onPressed: () => launchUrl(
              Uri.parse(
                'https://claude.ai/new?q=${Uri.encodeComponent(_prompt)}',
              ),
              mode: LaunchMode.externalApplication,
            ),
          ),
          const SizedBox(height: 10),
          PaperButton(
            key: const Key('copy-prompt'),
            label: 'Copy prompt',
            icon: Icons.copy,
            kind: PaperButtonKind.secondary,
            expand: true,
            onPressed: () {
              Clipboard.setData(ClipboardData(text: _prompt));
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text('Prompt copied. Paste it into your agent.'),
                ),
              );
            },
          ),
          const SizedBox(height: 12),
          Text(
            'First time? Connect Waypack to your agent at ${Config.apiUrl}/account (free).',
            style: TextStyle(fontSize: 12, color: p.muted),
          ),
        ],
      ),
    );
  }
}
