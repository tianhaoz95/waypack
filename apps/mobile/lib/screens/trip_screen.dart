import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../util/format.dart';
import '../widgets/bundle_webview.dart';
import 'today_screen.dart';

/// Full-screen trip bundle with a small native overlay button (design §8.1 #3).
class TripScreen extends StatelessWidget {
  const TripScreen({super.key, required this.tripId});
  final String tripId;

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final e = s.trip(tripId);
    if (e == null || e.local == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Center(child: Text('This trip is not on this device.')),
      );
    }
    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: BundleWebView(
              key: ValueKey('${tripId}_${e.local!.version}'),
              url: s.server.tripUrl(tripId),
              origin: s.server.origin,
            ),
          ),
          SafeArea(
            child: Align(
              alignment: Alignment.bottomRight,
              child: Padding(
                // Sit above typical bottom tab bars (64px) without covering them.
                padding: const EdgeInsets.only(right: 12, bottom: 76),
                child: FloatingActionButton.small(
                  heroTag: 'trip-menu',
                  tooltip: 'Waypack menu',
                  onPressed: () => _menu(context),
                  child: const Icon(Icons.more_horiz),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _menu(BuildContext context) {
    final s = context.read<AppState>();
    final e = s.trip(tripId)!;
    final l = e.local!;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.today_outlined),
              title: const Text('Today'),
              subtitle: const Text('What\'s next, from the trip data'),
              onTap: () async {
                Navigator.pop(ctx);
                final m = await s.manifestFor(tripId);
                if (m != null && context.mounted) {
                  Navigator.push(
                    context,
                    MaterialPageRoute(builder: (_) => TodayScreen(manifest: m)),
                  );
                }
              },
            ),
            ListTile(
              leading: const Icon(Icons.map_outlined),
              title: const Text('Map'),
              subtitle: Text(
                l.tiles.isEmpty
                    ? 'Needs a connection (no offline map)'
                    : 'Offline map with your location',
              ),
              onTap: () {
                Navigator.pop(ctx);
                Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => _MapScreen(tripId: tripId)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.info_outline),
              title: const Text('Info'),
              subtitle: Text(
                'Version ${l.version} · ${formatBytes(l.bytes)} · saved ${relativeTime(l.downloadedAt)}'
                '${s.lastSynced != null ? ' · synced ${relativeTime(s.lastSynced!)}' : ''}',
              ),
            ),
            ListTile(
              leading: const Icon(Icons.refresh),
              title: Text(
                e.updateAvailable ? 'Download update' : 'Re-download',
              ),
              enabled: e.remote != null,
              onTap: () {
                Navigator.pop(ctx);
                s.download(tripId);
                Navigator.pop(context);
              },
            ),
            ListTile(
              leading: Icon(
                Icons.delete_outline,
                color: Theme.of(ctx).colorScheme.error,
              ),
              title: Text(
                'Delete from this device',
                style: TextStyle(color: Theme.of(ctx).colorScheme.error),
              ),
              onTap: () async {
                Navigator.pop(ctx);
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (d) => AlertDialog(
                    title: const Text('Delete offline copy?'),
                    content: const Text(
                      'The trip stays in your account; you can download it again while online.',
                    ),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.pop(d, false),
                        child: const Text('Cancel'),
                      ),
                      FilledButton(
                        onPressed: () => Navigator.pop(d, true),
                        child: const Text('Delete'),
                      ),
                    ],
                  ),
                );
                if (ok == true && context.mounted) {
                  Navigator.pop(context);
                  await s.deleteLocal(tripId);
                }
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _MapScreen extends StatelessWidget {
  const _MapScreen({required this.tripId});
  final String tripId;
  @override
  Widget build(BuildContext context) {
    final s = context.read<AppState>();
    return Scaffold(
      appBar: AppBar(title: Text(s.trip(tripId)?.title ?? 'Map')),
      body: BundleWebView(
        url: s.server.tripUrl(tripId, page: '__waypack_map.html'),
        origin: s.server.origin,
      ),
    );
  }
}
