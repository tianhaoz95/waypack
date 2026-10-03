import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../util/format.dart';
import 'settings_screen.dart';
import 'trip_screen.dart';

class TripsScreen extends StatelessWidget {
  const TripsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final t = Theme.of(context);
    final upcoming = s.upcoming, past = s.past;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Trips'),
        actions: [
          IconButton(
            tooltip: 'Settings',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen())),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: s.refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 32),
          children: [
            if (s.listError != null)
              Card(
                color: t.colorScheme.secondaryContainer,
                child: ListTile(leading: const Icon(Icons.cloud_off_outlined), title: Text(s.listError!)),
              ),
            if (upcoming.isEmpty && past.isEmpty && s.loading)
              const Padding(padding: EdgeInsets.all(48), child: Center(child: CircularProgressIndicator())),
            if (upcoming.isEmpty && past.isEmpty && !s.loading) const _EmptyState(),
            if (upcoming.isNotEmpty) _Header('Upcoming'),
            for (final e in upcoming) _TripCard(entry: e),
            if (past.isNotEmpty) _Header('Past'),
            for (final e in past) _TripCard(entry: e),
            if (s.lastSynced != null)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: Text('Last synced ${relativeTime(s.lastSynced!)}',
                    textAlign: TextAlign.center, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              ),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 16, 4, 8),
        child: Text(text, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
      );
}

class _TripCard extends StatelessWidget {
  const _TripCard({required this.entry});
  final TripEntry entry;

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final t = Theme.of(context);
    final e = entry;
    final downloading = s.isDownloading(e.id);
    final r = e.remote;
    final size = r != null ? r.bundleBytes + r.tilesBytes : e.local?.bytes ?? 0;
    final processing = r?.status == 'processing';

    Widget status;
    if (downloading) {
      final p = s.progress[e.id] ?? 0;
      status = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${s.progressStage[e.id]} · ${(p * 100).round()}%', style: t.textTheme.bodyMedium),
        const SizedBox(height: 6),
        LinearProgressIndicator(value: p),
      ]);
    } else if (e.updateAvailable) {
      status = _Chip(icon: Icons.system_update_alt, label: 'Update available', color: t.colorScheme.tertiary);
    } else if (e.isOffline) {
      status = _Chip(icon: Icons.offline_pin, label: 'Available offline', color: Colors.green.shade700);
    } else if (processing) {
      status = _Chip(icon: Icons.hourglass_top, label: 'Preparing offline map…', color: t.colorScheme.onSurfaceVariant);
    } else {
      status = _Chip(icon: Icons.cloud_outlined, label: 'Not downloaded', color: t.colorScheme.onSurfaceVariant);
    }

    final err = s.errors[e.id];
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: e.isOffline ? () => Navigator.push(context, MaterialPageRoute(builder: (_) => TripScreen(tripId: e.id))) : null,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(e.title, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text([dateRange(e.startDate, e.endDate), if (size > 0) formatBytes(size)].where((x) => x.isNotEmpty).join(' · '),
                style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
            const SizedBox(height: 12),
            status,
            if (r?.tilesStatus == 'not_included' && !downloading)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('Offline map needs Waypack Pro — the map will need a connection.',
                    style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              ),
            if (err != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(err, style: TextStyle(color: t.colorScheme.error))),
            const SizedBox(height: 12),
            Row(children: [
              if (e.isOffline)
                FilledButton.icon(
                  onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => TripScreen(tripId: e.id))),
                  icon: const Icon(Icons.open_in_full),
                  label: const Text('Open'),
                ),
              if (e.isOffline && e.updateAvailable) const SizedBox(width: 8),
              if (r != null && !downloading && (!e.isOffline || e.updateAvailable))
                (e.isOffline ? OutlinedButton.icon : FilledButton.icon)(
                  onPressed: processing && !e.isOffline ? null : () => s.download(e.id),
                  icon: Icon(e.isOffline ? Icons.system_update_alt : Icons.download),
                  label: Text(e.isOffline ? 'Update' : 'Download'),
                ),
            ]),
          ]),
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.label, required this.color});
  final IconData icon;
  final String label;
  final Color color;
  @override
  Widget build(BuildContext context) => Row(children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 6),
        Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w600)),
      ]);
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 16),
      child: Column(children: [
        Icon(Icons.map_outlined, size: 56, color: t.colorScheme.primary),
        const SizedBox(height: 16),
        Text('No trips yet', style: t.textTheme.titleLarge),
        const SizedBox(height: 8),
        Text(
          'Ask your AI agent to plan a trip "with Waypack". It will publish it here, ready to download for offline use.',
          textAlign: TextAlign.center,
          style: t.textTheme.bodyLarge?.copyWith(color: t.colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 16),
        OutlinedButton(
          onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen(scrollToConnect: true))),
          child: const Text('How to connect your agent'),
        ),
      ]),
    );
  }
}
