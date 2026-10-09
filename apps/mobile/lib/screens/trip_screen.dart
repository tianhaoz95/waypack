import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../util/format.dart';
import '../services/handoff.dart';
import '../widgets/bundle_webview.dart';
import '../widgets/scrapbook.dart';
import '../widgets/share_trip_sheet.dart';
import 'assistant_screen.dart';
import 'nearby_screens.dart';
import 'today_screen.dart';

/// The trip bundle, full screen. Its one top bar is drawn by the page (trip SDK ≥ 1.1: back, ☰,
/// title, ⋯), so nothing native floats over trip content; the bar's buttons call back into here.
/// Pages without the bar (no SDK, broken page) get the old floating ⋯ button as a fallback.
class TripScreen extends StatefulWidget {
  const TripScreen({super.key, required this.tripId});
  final String tripId;

  @override
  State<TripScreen> createState() => TripScreenState();
}

class TripScreenState extends State<TripScreen> {
  bool _barReady = false;
  bool _showFallback = false;
  Timer? _fallbackTimer;

  String get tripId => widget.tripId;

  @override
  void initState() {
    super.initState();
    // Even if the page never finishes loading, don't leave the user without the menu.
    _armFallback(const Duration(seconds: 6));
  }

  @override
  void dispose() {
    _fallbackTimer?.cancel();
    super.dispose();
  }

  void _armFallback(Duration after) {
    _fallbackTimer?.cancel();
    _fallbackTimer = Timer(after, () {
      if (mounted && !_barReady) setState(() => _showFallback = true);
    });
  }

  void _onBarReady() {
    _fallbackTimer?.cancel();
    if (!_barReady || _showFallback) {
      setState(() {
        _barReady = true;
        _showFallback = false;
      });
    }
  }

  /// Opens the trip menu (the page's ⋯ button; also used by integration tests).
  void openMenu() => _menu(context);

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final e = s.trip(tripId);
    if (e == null || e.local == null) {
      return const KraftScaffold(
        title: 'Trip',
        body: Padding(
          padding: EdgeInsets.all(24),
          child: Align(
            alignment: Alignment.topCenter,
            child: StickyNote(child: Text('This trip is not on this device.')),
          ),
        ),
      );
    }
    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: BundleWebView(
              // Reload on a new version or after the local server was rebound.
              key: ValueKey(
                '${tripId}_${e.local!.version}_${s.serverGeneration}',
              ),
              url: s.server.tripUrl(tripId),
              origin: s.server.origin,
              onRecover: s.ensureServer,
              onBack: () => Navigator.maybePop(context),
              onMenu: openMenu,
              onBarReady: _onBarReady,
              onLoaded: () {
                if (!_barReady) {
                  _armFallback(const Duration(milliseconds: 1500));
                }
              },
            ),
          ),
          if (_showFallback)
            SafeArea(
              child: Align(
                alignment: Alignment.bottomRight,
                child: Padding(
                  padding: const EdgeInsets.only(right: 12, bottom: 76),
                  child: _MenuButton(onPressed: openMenu),
                ),
              ),
            ),
        ],
      ),
    );
  }

  void _push(BuildContext context, String name, WidgetBuilder builder) =>
      Navigator.push(
        context,
        MaterialPageRoute(
          settings: RouteSettings(name: name),
          builder: builder,
        ),
      );

  /// "Sticker tiles": the four everyday tools up top, the rest in a short list.
  void _menu(BuildContext context) {
    final s = context.read<AppState>();
    final e = s.trip(tripId)!;
    final l = e.local!;
    showPaperSheet<void>(
      context,
      builder: (ctx) {
        final p = Paper.of(ctx);
        void go(VoidCallback f) {
          Navigator.pop(ctx);
          f();
        }

        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 0, 22, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    e.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: hand(32, p.ink),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Version ${l.version} · ${formatBytes(l.bytes)} · saved ${relativeTime(l.downloadedAt)}'
                    '${s.lastSynced != null ? ' · synced ${relativeTime(s.lastSynced!)}' : ''}',
                    style: TextStyle(fontSize: 12, color: p.muted),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: GridView.count(
                crossAxisCount: 2,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 1.55,
                children: [
                  _Tile(
                    icon: Icons.today_outlined,
                    color: ChipColor.yellow,
                    title: 'Today',
                    subtitle: 'What\'s next',
                    tilt: -1.2,
                    onTap: () => go(() async {
                      final m = await s.manifestFor(tripId);
                      if (m != null && context.mounted) {
                        _push(
                          context,
                          'Today',
                          (_) => TodayScreen(manifest: m),
                        );
                      }
                    }),
                  ),
                  _Tile(
                    icon: Icons.map_outlined,
                    color: ChipColor.mint,
                    title: 'Map',
                    subtitle: l.tiles.isEmpty
                        ? 'Needs a connection'
                        : 'Offline, with you on it',
                    tilt: 1,
                    onTap: () => go(
                      () => _push(
                        context,
                        'Map',
                        (_) => _MapScreen(tripId: tripId),
                      ),
                    ),
                  ),
                  _Tile(
                    icon: Icons.auto_awesome_outlined,
                    color: ChipColor.lilac,
                    title: 'Ask',
                    subtitle: 'On-device, no signal',
                    tilt: 1,
                    onTap: () => go(
                      () => _push(
                        context,
                        'Assistant',
                        (_) => AssistantScreen(tripId: tripId),
                      ),
                    ),
                  ),
                  _Tile(
                    icon: Icons.ios_share,
                    color: ChipColor.pink,
                    title: 'Share',
                    subtitle: 'PDF or web link',
                    tilt: -1.2,
                    onTap: () => go(() => showShareTripSheet(context, e)),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            PaperCard(
              children: [
                PaperRow(
                  icon: Icons.mobile_screen_share_outlined,
                  chip: ChipColor.blue,
                  title: 'Hand off to a nearby phone',
                  subtitle: 'No signal needed',
                  chevron: true,
                  onTap: () => go(
                    () => _push(
                      context,
                      'HandoffSend',
                      (_) => HandoffSendScreen(tripId: tripId),
                    ),
                  ),
                ),
                if (e.remote != null && !e.remote!.isCompanion)
                  PaperRow(
                    icon: Icons.group_add_outlined,
                    chip: ChipColor.mint,
                    title: 'Invite travel companions',
                    subtitle: 'Needs a connection',
                    chevron: true,
                    onTap: () => go(() async {
                      try {
                        final link = await s.api.inviteLink(tripId);
                        await Handoff.share(
                          'Join "${e.title}" in Waypack, our trip plan that works offline: $link',
                        );
                      } catch (err) {
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(
                                'Couldn\'t create an invite link: $err',
                              ),
                            ),
                          );
                        }
                      }
                    }),
                  ),
                PaperRow(
                  icon: Icons.refresh,
                  chip: ChipColor.yellow,
                  title: e.updateAvailable ? 'Download update' : 'Re-download',
                  enabled: e.remote != null,
                  onTap: () => go(() {
                    s.download(tripId);
                    Navigator.pop(context);
                  }),
                ),
                PaperRow(
                  icon: Icons.delete_outline,
                  destructive: true,
                  title: 'Delete from this device',
                  onTap: () => go(() async {
                    final ok = await showPaperConfirm(
                      context,
                      title: 'Delete offline copy?',
                      message: 'The trip stays in your account; you can download it again while online.',
                    );
                    if (ok && context.mounted) {
                      Navigator.pop(context);
                      await s.deleteLocal(tripId);
                    }
                  }),
                ),
              ],
            ),
          ],
        );
      },
    );
  }
}

/// The only native control over the trip's own page: a round light-paper button with tape.
class _MenuButton extends StatelessWidget {
  const _MenuButton({required this.onPressed});
  final VoidCallback onPressed;
  @override
  Widget build(BuildContext context) => Stack(
    clipBehavior: Clip.none,
    children: [
      Material(
        color: Paper.lightPaper,
        shape: const CircleBorder(),
        elevation: 4,
        shadowColor: const Color(0x993C2814),
        child: IconButton(
          tooltip: 'Waypack menu',
          onPressed: onPressed,
          icon: const Icon(Icons.more_horiz, color: Paper.captionInk),
          style: IconButton.styleFrom(fixedSize: const Size(50, 50)),
        ),
      ),
      const Positioned(
        top: -6,
        left: 0,
        right: 0,
        child: IgnorePointer(
          child: Center(child: TapeStrip(width: 30, height: 11, angle: -8)),
        ),
      ),
    ],
  );
}

class _Tile extends StatelessWidget {
  const _Tile({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.tilt,
    required this.onTap,
  });
  final IconData icon;
  final Color color;
  final String title, subtitle;
  final double tilt;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    child: GestureDetector(
      onTap: onTap,
      child: PaperObject(
        tilt: tilt,
        radius: 6,
        padding: const EdgeInsets.fromLTRB(14, 12, 12, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            IconChip(icon: icon, color: color),
            const Spacer(),
            Text(title, style: hand(25, Paper.captionInk)),
            const SizedBox(height: 2),
            Text(
              subtitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11.5, color: Paper.captionMuted),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Full-bleed map with the trip name on a floating paper pill (map controls stay top-right).
class _MapScreen extends StatelessWidget {
  const _MapScreen({required this.tripId});
  final String tripId;
  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final p = Paper.of(context);
    final e = s.trip(tripId);
    final offline = e?.local?.tiles.isNotEmpty ?? false;
    return Scaffold(
      backgroundColor: p.bg,
      body: Kraft(
        child: SafeArea(
          bottom: false,
          child: Stack(
            children: [
              Positioned.fill(
                child: BundleWebView(
                  key: ValueKey('map_${tripId}_${s.serverGeneration}'),
                  url: s.server.tripUrl(tripId, page: '__waypack_map.html'),
                  origin: s.server.origin,
                  onRecover: s.ensureServer,
                ),
              ),
              Positioned(
                left: 12,
                top: 10,
                right: 64,
                child: Row(
                  children: [
                    RoundButton(
                      tooltip: 'Back',
                      icon: Icons.arrow_back_ios_new,
                      iconSize: 17,
                      onPressed: () => Navigator.maybePop(context),
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Container(
                        height: 44,
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        decoration: BoxDecoration(
                          color: p.card,
                          borderRadius: BorderRadius.circular(22),
                          boxShadow: const [
                            BoxShadow(
                              color: Color(0x333C2814),
                              blurRadius: 4,
                              offset: Offset(0, 1),
                            ),
                          ],
                        ),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              e?.title ?? 'Map',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: hand(22, p.ink).copyWith(height: .9),
                            ),
                            Text(
                              offline ? 'Offline map' : 'Needs a connection',
                              style: TextStyle(
                                fontSize: 10.5,
                                fontWeight: FontWeight.w600,
                                color: p.muted,
                              ),
                            ),
                          ],
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
    );
  }
}
