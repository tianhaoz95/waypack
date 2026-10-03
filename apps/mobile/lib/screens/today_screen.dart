import 'dart:async';

import 'package:flutter/material.dart';

import '../models/manifest.dart';
import '../services/handoff.dart';
import '../util/format.dart';
import '../util/today.dart';

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
    Handoff.openInMaps(lat: p.lat, lon: p.lon, label: p.name, app: widget.manifest.navApp ?? 'auto');
  }

  String? _placeFor(DayItem it) => it.placeId ?? (it.routeId == null ? null : widget.manifest.routesById[it.routeId]?['to'] as String?);

  @override
  Widget build(BuildContext context) {
    final m = widget.manifest;
    final t = Theme.of(context);
    final (today, now) = nowIn(m.timezone);
    final v = computeToday(m, today: today, nowTime: now);

    final children = <Widget>[];
    Widget hero(String label, String title, String? sub, {String? placeId, String? notes}) => Card(
          color: t.colorScheme.primary,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label.toUpperCase(), style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.onPrimary.withValues(alpha: .85), letterSpacing: 1)),
              const SizedBox(height: 6),
              Text(title, style: t.textTheme.headlineSmall?.copyWith(color: t.colorScheme.onPrimary, fontWeight: FontWeight.w700)),
              if (sub != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(sub, style: TextStyle(color: t.colorScheme.onPrimary, fontWeight: FontWeight.w600))),
              if (notes != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(notes, style: TextStyle(color: t.colorScheme.onPrimary))),
              if (placeId != null && m.placesById.containsKey(placeId))
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: FilledButton.tonalIcon(onPressed: () => _navigate(placeId), icon: const Icon(Icons.navigation_outlined), label: const Text('Navigate')),
                ),
            ]),
          ),
        );

    switch (v.phase) {
      case TripPhase.before:
        children.add(hero('Coming up', v.daysUntil == 1 ? 'Tomorrow' : '${v.daysUntil} days to go', dateRange(m.startDate, m.endDate), notes: m.summary));
        if (v.day != null) {
          children.add(_dayHeader(context, 'Day 1 · ${v.day!.title ?? ''}', v.day!.date));
          children.addAll([for (var i = 0; i < v.day!.items.length; i++) _item(context, v.day!.items[i], false, false)]);
        }
      case TripPhase.after:
        children.add(hero('Trip complete', m.title, dateRange(m.startDate, m.endDate)));
      case TripPhase.during:
        final f = v.focus;
        if (v.day == null || v.day!.items.isEmpty) {
          children.add(hero('Day ${v.dayNumber}', v.day?.title ?? 'Free day', 'Nothing scheduled'));
        } else if (f != null) {
          final p = _placeFor(f);
          children.add(hero('${v.focusIsNow ? 'Now' : 'Next up'} · Day ${v.dayNumber}', f.title,
              [formatHm(f.time), if (f.endTime != null) '– ${formatHm(f.endTime)}', if (p != null && m.placesById[p] != null) '· ${m.placesById[p]!.name}'].join(' '),
              placeId: p, notes: f.notes));
        } else {
          children.add(hero('Day ${v.dayNumber}', 'All done for today', v.day!.title));
        }
        if (v.day != null && v.day!.items.isNotEmpty) {
          children.add(_dayHeader(context, v.day!.title ?? 'Today', v.day!.date));
          children.addAll([for (var i = 0; i < v.day!.items.length; i++) _item(context, v.day!.items[i], i == v.nowIndex, v.isDone(i))]);
        }
    }

    final lodging = m.places.where((p) => p.category == 'lodging');
    if (lodging.isNotEmpty) {
      children.add(_dayHeader(context, 'Where you\'re staying', null));
      for (final p in lodging) {
        children.add(Card(
          child: ListTile(
            title: Text(p.name),
            subtitle: Text([p.address, p.notes].whereType<String>().join('\n')),
            isThreeLine: p.notes != null,
            trailing: IconButton(tooltip: 'Navigate', icon: const Icon(Icons.navigation_outlined), onPressed: () => _navigate(p.id)),
          ),
        ));
      }
    }
    final nums = m.emergencyNumbers;
    if (nums.isNotEmpty) {
      children.add(_dayHeader(context, 'Emergency', null));
      children.add(Card(
        child: Column(children: [
          for (final n in nums)
            ListTile(
              leading: const Icon(Icons.phone_outlined),
              title: Text(n['label']!),
              trailing: Text(n['value']!, style: const TextStyle(fontWeight: FontWeight.w700)),
              onTap: () => Handoff.openExternal('tel:${n['value']!.replaceAll(RegExp(r'[^+\d]'), '')}'),
            ),
        ]),
      ));
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Today')),
      body: ListView(padding: const EdgeInsets.all(12), children: children),
    );
  }

  Widget _dayHeader(BuildContext context, String title, String? date) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 20, 4, 8),
      child: Row(children: [
        Expanded(child: Text(title, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700))),
        if (date != null) Text(dateRange(date, date), style: TextStyle(color: t.colorScheme.onSurfaceVariant)),
      ]),
    );
  }

  Widget _item(BuildContext context, DayItem it, bool now, bool done) {
    final t = Theme.of(context);
    final p = _placeFor(it);
    return Opacity(
      opacity: done ? .55 : 1,
      child: Card(
        shape: now ? RoundedRectangleBorder(side: BorderSide(color: t.colorScheme.primary, width: 2.5), borderRadius: BorderRadius.circular(12)) : null,
        child: ListTile(
          leading: SizedBox(width: 64, child: Text(formatHm(it.time), style: const TextStyle(fontWeight: FontWeight.w700))),
          title: Text(it.title),
          subtitle: it.notes == null ? null : Text(it.notes!, maxLines: 3, overflow: TextOverflow.ellipsis),
          trailing: p != null && widget.manifest.placesById.containsKey(p)
              ? IconButton(tooltip: 'Navigate', icon: const Icon(Icons.navigation_outlined), onPressed: () => _navigate(p))
              : null,
        ),
      ),
    );
  }
}
