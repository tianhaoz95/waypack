import 'dart:async';

import 'package:flutter/material.dart';

import 'assistant_screen.dart';

import '../models/manifest.dart';
import '../services/calendar.dart';
import '../services/handoff.dart';
import '../util/colors.dart';
import '../util/format.dart';
import '../util/today.dart';
import '../widgets/scrapbook.dart';

/// Native Today view from manifest.json — works even if the bundle's own UI is broken (§8.1).
class TodayScreen extends StatefulWidget {
  const TodayScreen({super.key, required this.manifest});
  final Manifest manifest;

  @override
  State<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends State<TodayScreen> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(minutes: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _navigate(String? placeId) {
    final p = placeId == null ? null : widget.manifest.placesById[placeId];
    if (p == null) return;
    Handoff.openInMaps(
      lat: p.lat,
      lon: p.lon,
      label: p.name,
      app: widget.manifest.navApp ?? 'auto',
    );
  }

  void _calendar(String date, int index) {
    final e = TripEvent.fromItem(widget.manifest, date, index);
    if (e != null) CalendarHandoff.choose(context, e);
  }

  String? _placeFor(DayItem it) =>
      it.placeId ??
      (it.routeId == null
          ? null
          : widget.manifest.routesById[it.routeId]?['to'] as String?);

  @override
  Widget build(BuildContext context) {
    final m = widget.manifest;
    final p = Paper.of(context);
    final (today, now) = nowIn(m.timezone);
    final v = computeToday(m, today: today, nowTime: now);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final accent =
        hexColor(dark ? (m.accentDark ?? m.accent) : m.accent) ?? p.accent;
    final seed = (m.raw['trip_id'] as String? ?? m.title).hashCode;

    final children = <Widget>[];
    Widget hero(
      String stamp,
      String title,
      String? sub, {
      String? placeId,
      String? notes,
      (String, int)? cal,
    }) => Padding(
      padding: const EdgeInsets.fromLTRB(22, 8, 22, 4),
      child: PaperObject(
        tilt: -1,
        tape: 0,
        padding: const EdgeInsets.fromLTRB(9, 9, 9, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AspectRatio(
              aspectRatio: 2.1,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(1),
                    child: CustomPaint(painter: ScenePainter(accent, seed)),
                  ),
                  Positioned(
                    right: 10,
                    top: 10,
                    child: Stamp(
                      label: stamp,
                      color: Paper.light.accent,
                      background: Paper.lightPaper,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 9),
            Text(title, style: hand(31, Paper.captionInk)),
            if (sub != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  sub,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Paper.captionMuted,
                  ),
                ),
              ),
            if (notes != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  notes,
                  style: const TextStyle(fontSize: 13.5, height: 1.4),
                ),
              ),
            if ((placeId != null && m.placesById.containsKey(placeId)) ||
                cal != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    if (placeId != null && m.placesById.containsKey(placeId))
                      PaperButton(
                        small: true,
                        icon: Icons.navigation_outlined,
                        label: 'Navigate',
                        onPressed: () => _navigate(placeId),
                      ),
                    if (cal != null)
                      PaperButton(
                        small: true,
                        onPaper: true,
                        kind: PaperButtonKind.secondary,
                        icon: Icons.event_available_outlined,
                        label: 'Calendar',
                        onPressed: () => _calendar(cal.$1, cal.$2),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );

    Widget trail(List<Widget> tickets) => Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 18, 0),
      child: Stack(
        children: [
          Positioned(
            left: 0,
            top: 6,
            bottom: 6,
            width: 12,
            child: DashedLine(color: p.accent.withValues(alpha: .55)),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final (i, t) in tickets.indexed) ...[
                  if (i > 0) const SizedBox(height: 12),
                  t,
                ],
              ],
            ),
          ),
        ],
      ),
    );

    var title = 'Today';
    switch (v.phase) {
      case TripPhase.before:
        children.add(
          hero(
            'Coming up',
            v.daysUntil == 1 ? 'Tomorrow' : '${v.daysUntil} days to go',
            dateRange(m.startDate, m.endDate),
            notes: m.summary,
          ),
        );
        if (v.day != null) {
          children.add(
            _dayHeader(context, 'Day 1 · ${v.day!.title ?? ''}', v.day!.date),
          );
          children.add(
            trail([
              for (var i = 0; i < v.day!.items.length; i++)
                _item(context, v.day!.items[i], false, false, v.day!.date, i),
            ]),
          );
        }
      case TripPhase.after:
        children.add(
          hero('Trip complete', m.title, dateRange(m.startDate, m.endDate)),
        );
      case TripPhase.during:
        title = 'Day ${v.dayNumber}';
        final f = v.focus;
        if (v.day == null || v.day!.items.isEmpty) {
          children.add(
            hero(
              'Day ${v.dayNumber}',
              v.day?.title ?? 'Free day',
              'Nothing scheduled',
            ),
          );
        } else if (f != null) {
          final pl = _placeFor(f);
          children.add(
            hero(
              v.focusIsNow
                  ? (f.endTime != null
                        ? 'Now · till ${formatHm(f.endTime)}'
                        : 'Now')
                  : 'Next up · ${formatHm(f.time)}',
              f.title,
              [
                formatHm(f.time),
                if (f.endTime != null) '– ${formatHm(f.endTime)}',
                if (pl != null && m.placesById[pl] != null)
                  '· ${m.placesById[pl]!.name}',
              ].join(' '),
              placeId: pl,
              notes: f.notes,
              cal: (v.day!.date, v.focusIsNow ? v.nowIndex : v.nextIndex),
            ),
          );
        } else {
          children.add(
            hero('Day ${v.dayNumber}', 'All done for today', v.day!.title),
          );
        }
        if (v.day != null && v.day!.items.isNotEmpty) {
          children.add(
            _dayHeader(context, v.day!.title ?? 'Today', v.day!.date),
          );
          children.add(
            trail([
              for (var i = 0; i < v.day!.items.length; i++)
                _item(
                  context,
                  v.day!.items[i],
                  i == v.nowIndex,
                  v.isDone(i),
                  v.day!.date,
                  i,
                ),
            ]),
          );
        }
    }

    final lodging = m.places.where((pl) => pl.category == 'lodging');
    if (lodging.isNotEmpty) {
      children.add(_dayHeader(context, 'Where you\'re staying', null));
      children.add(
        PaperCard(
          children: [
            for (final pl in lodging)
              PaperRow(
                icon: Icons.bed_outlined,
                chip: ChipColor.lilac,
                title: pl.name,
                subtitle: [pl.address, pl.notes].whereType<String>().join('\n'),
                trailing: RoundButton(
                  tooltip: 'Navigate',
                  icon: Icons.navigation_outlined,
                  iconSize: 18,
                  accent: true,
                  onPressed: () => _navigate(pl.id),
                ),
              ),
          ],
        ),
      );
    }
    final nums = m.emergencyNumbers;
    if (nums.isNotEmpty) {
      children.add(_dayHeader(context, 'If something goes wrong', null));
      children.add(
        Padding(
          padding: const EdgeInsets.fromLTRB(22, 4, 22, 0),
          child: StickyNote(
            color: Paper.stickyPink,
            tilt: .8,
            tape: 2,
            padding: const EdgeInsets.fromLTRB(6, 10, 6, 6),
            child: Column(
              children: [
                for (final n in nums)
                  InkWell(
                    onTap: () => Handoff.openExternal(
                      'tel:${n['value']!.replaceAll(RegExp(r'[^+\d]'), '')}',
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 9,
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.phone_outlined, size: 17),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              n['label']!,
                              style: const TextStyle(fontSize: 14.5),
                            ),
                          ),
                          Text(
                            n['value']!,
                            style: const TextStyle(
                              fontSize: 14.5,
                              fontWeight: FontWeight.w800,
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
      );
    }

    final tripId = m.raw['trip_id'];
    return KraftScaffold(
      title: title,
      subtitle: m.title,
      maxWidth: 760,
      actions: [
        if (tripId is String)
          RoundButton(
            tooltip: 'Ask about this trip',
            icon: Icons.auto_awesome_outlined,
            iconSize: 19,
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                settings: const RouteSettings(name: 'Assistant'),
                builder: (_) => AssistantScreen(tripId: tripId),
              ),
            ),
          ),
      ],
      body: ListView(
        padding: const EdgeInsets.only(bottom: 40),
        children: children,
      ),
    );
  }

  Widget _dayHeader(BuildContext context, String title, String? date) =>
      SectionTitle(
        title,
        note: date == null ? null : dateRange(date, date),
        padding: const EdgeInsets.fromLTRB(20, 26, 20, 12),
      );

  /// A ticket stub: time on the stub, the activity on the ticket, actions on the right.
  Widget _item(
    BuildContext context,
    DayItem it,
    bool now,
    bool done,
    String date,
    int index,
  ) {
    final p = Paper.of(context);
    final place = _placeFor(it);
    final hasPlace =
        place != null && widget.manifest.placesById.containsKey(place);
    final time = formatHm(it.time);
    final cut = time.lastIndexOf(RegExp(r'[\s\u00A0\u202F]'));
    final clock = cut > 0 ? time.substring(0, cut) : time;
    final meridiem = cut > 0 ? time.substring(cut + 1) : '';
    final placeName = hasPlace ? widget.manifest.placesById[place]!.name : null;
    Widget act(String tip, IconData icon, VoidCallback f) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: IconButton(
        tooltip: tip,
        onPressed: f,
        icon: Icon(icon, size: 16),
        style: IconButton.styleFrom(
          backgroundColor: const Color(0xFFF3EADB),
          foregroundColor: Paper.captionInk,
          fixedSize: const Size(34, 34),
          minimumSize: const Size(34, 34),
        ),
      ),
    );
    final ticket = Container(
      decoration: BoxDecoration(
        color: Paper.lightPaper,
        borderRadius: BorderRadius.circular(6),
        boxShadow: [
          if (now) BoxShadow(color: p.accent, spreadRadius: 2.5),
          ...paperShadow,
        ],
      ),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              width: 64,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Column(
                  children: [
                    // "4:35 PM": the clock big and handwritten, AM/PM small underneath.
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        clock,
                        maxLines: 1,
                        style: hand(23, Paper.captionInk).copyWith(
                          decoration: done ? TextDecoration.lineThrough : null,
                          decorationThickness: 2,
                        ),
                      ),
                    ),
                    if (meridiem.isNotEmpty)
                      Text(
                        meridiem,
                        style: const TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w800,
                          letterSpacing: .5,
                          color: Paper.captionMuted,
                        ),
                      ),
                    if (it.endTime != null && !done)
                      Text(
                        'to ${formatHm(it.endTime)}',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          color: Paper.captionMuted,
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(
              width: 2,
              child: DashedLine(color: Color(0x40785A3C), width: 2),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 11, 8, 11),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      it.title,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        color: Paper.captionInk,
                      ),
                    ),
                    if (it.notes != null && !done)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                          it.notes!,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 12.5,
                            height: 1.4,
                            color: Paper.captionMuted,
                          ),
                        ),
                      ),
                    if (placeName != null && !done)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Row(
                          children: [
                            const Icon(
                              Icons.place_outlined,
                              size: 13,
                              color: Color(0xFFA9583F),
                            ),
                            const SizedBox(width: 3),
                            Flexible(
                              child: Text(
                                placeName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w700,
                                  color: Color(0xFFA9583F),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (hasPlace)
                    act(
                      'Navigate',
                      Icons.navigation_outlined,
                      () => _navigate(place),
                    ),
                  act(
                    'Add to calendar',
                    Icons.event_available_outlined,
                    () => _calendar(date, index),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    return Opacity(
      opacity: done ? .55 : 1,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          ticket,
          if (now)
            Positioned(
              left: -20,
              top: 0,
              bottom: 0,
              child: Center(
                child: Container(
                  width: 12,
                  height: 12,
                  decoration: BoxDecoration(
                    color: p.accent,
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                        color: p.accent.withValues(alpha: .25),
                        spreadRadius: 4,
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
