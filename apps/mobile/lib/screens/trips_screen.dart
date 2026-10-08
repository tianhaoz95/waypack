import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../state/app_state.dart';
import '../util/format.dart';
import '../widgets/scrapbook.dart';
import '../widgets/share_trip_sheet.dart';
import 'nearby_screens.dart';
import 'settings_screen.dart';
import 'trip_screen.dart';

/// "Scrapbook" home: trips are polaroids taped onto kraft paper, with handwritten captions.
/// Upcoming trips are a 2-up grid, past trips a smaller 3-up grid. Status lives in a stamp
/// in the photo corner; everything else (share, bookmark, delete) is on long-press.
class TripsScreen extends StatelessWidget {
  const TripsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final p = Paper.of(context);
    final upcoming = s.upcoming, past = s.past;
    final w = MediaQuery.sizeOf(context).width;
    // Centered, max ~1000px wide on iPad/desktop.
    final side = w > 1040 ? (w - 1000) / 2 : 18.0;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: Theme.of(context).brightness == Brightness.dark
          ? SystemUiOverlayStyle.light
          : SystemUiOverlayStyle.dark,
      child: Scaffold(
        backgroundColor: p.bg,
        body: CustomPaint(
          painter: DotsPainter(p.dots),
          child: SafeArea(
            bottom: false,
            child: RefreshIndicator(
              onRefresh: s.refresh,
              color: p.accent,
              child: ListView(
                padding: EdgeInsets.fromLTRB(side, 8, side, 44),
                children: [
                  _TopBar(upcoming: upcoming.length, past: past.length),
                  if (s.listError != null) _Note(text: s.listError!),
                  if (upcoming.isEmpty && past.isEmpty && s.loading)
                    Padding(
                      padding: const EdgeInsets.all(48),
                      child: Center(
                        child: CircularProgressIndicator(color: p.accent),
                      ),
                    ),
                  if (upcoming.isEmpty && past.isEmpty && !s.loading)
                    const _EmptyState(),
                  if (upcoming.isNotEmpty)
                    _PolaroidGrid(entries: upcoming, minWidth: 160),
                  if (past.isNotEmpty) ...[
                    _Header(upcoming.isEmpty ? 'Past trips' : 'Remember when…'),
                    _PolaroidGrid(entries: past, minWidth: 104, small: true),
                  ],
                  if (s.lastSynced != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 22),
                      child: Text(
                        'synced ${relativeTime(s.lastSynced!)}',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 12, color: p.muted),
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

class _TopBar extends StatelessWidget {
  const _TopBar({required this.upcoming, required this.past});
  final int upcoming, past;

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    final sub = [
      if (upcoming > 0) '$upcoming coming up',
      if (past > 0) '$past remembered',
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 4, 0, 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  header: true,
                  child: Text('Our trips', style: hand(44, p.ink)),
                ),
                if (sub.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      sub,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500,
                        color: p.muted,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          RoundButton(
            tooltip: 'Receive from a nearby phone',
            icon: Icons.qr_code_scanner,
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                settings: const RouteSettings(name: 'ReceiveNearby'),
                builder: (_) => const ReceiveNearbyScreen(),
              ),
            ),
          ),
          const SizedBox(width: 8),
          RoundButton(
            tooltip: 'Settings',
            icon: Icons.settings_outlined,
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                settings: const RouteSettings(name: 'Settings'),
                builder: (_) => const SettingsScreen(),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(2, 26, 2, 12),
    child: Semantics(
      header: true,
      child: Text(text, style: hand(29, Paper.of(context).ink)),
    ),
  );
}

/// A paper note for list-level errors (offline, session expired).
class _Note extends StatelessWidget {
  const _Note({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Transform.rotate(
        angle: -0.008,
        child: Container(
          padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
          decoration: BoxDecoration(
            color: const Color(0xFFFFF6C9),
            borderRadius: BorderRadius.circular(3),
            boxShadow: const [
              BoxShadow(
                color: Color(0x2E3C2814),
                blurRadius: 2,
                offset: Offset(0, 1),
              ),
            ],
          ),
          child: Row(
            children: [
              const Icon(
                Icons.cloud_off_outlined,
                size: 20,
                color: Paper.captionInk,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  text,
                  style: const TextStyle(fontSize: 14, color: Paper.captionInk),
                ),
              ),
              if (text == 'Session expired — sign in again.')
                TextButton(
                  onPressed: () => Supabase.instance.client.auth.signOut(),
                  style: TextButton.styleFrom(foregroundColor: p.accent),
                  child: const Text('Sign in'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Polaroids in as many columns as fit [minWidth] (2-up / 3-up on phones).
class _PolaroidGrid extends StatelessWidget {
  const _PolaroidGrid({
    required this.entries,
    required this.minWidth,
    this.small = false,
  });
  final List<TripEntry> entries;
  final double minWidth;
  final bool small;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, c) {
      final gap = small ? 12.0 : 14.0;
      final cols = math.max(
        small ? 3 : 2,
        ((c.maxWidth + gap) / (minWidth + gap)).floor(),
      );
      final w = (c.maxWidth - gap * (cols - 1)) / cols;
      return Wrap(
        spacing: gap,
        runSpacing: small ? 14 : 20,
        children: [
          for (final (i, e) in entries.indexed)
            SizedBox(
              width: w,
              child: _Polaroid(
                key: ValueKey('trip_${e.id}'),
                entry: e,
                index: small ? i + 1 : i,
                small: small,
              ),
            ),
        ],
      );
    },
  );
}

const _tilts = [-1.6, 1.3, 0.6, -0.9];

class _Polaroid extends StatelessWidget {
  const _Polaroid({
    super.key,
    required this.entry,
    required this.index,
    this.small = false,
  });
  final TripEntry entry;
  final int index;
  final bool small;

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final p = Paper.of(context);
    final e = entry;
    final r = e.remote;
    final err = s.errors[e.id];
    final bookmarked = s.isBookmarked(e.id);
    final accent = tripAccent(context, e);

    final meta = small
        ? _monthYear(e.startDate)
        : dateRange(e.startDate, e.endDate);
    final origin = small
        ? null
        : r?.isCompanion == true
        ? 'Shared by ${r!.ownerEmail?.split('@').first ?? 'a companion'}'
        : (r == null && e.local?.receivedNearby == true)
        ? 'From a nearby phone'
        : null;

    final photo = AspectRatio(
      aspectRatio: 1 / .8,
      child: Stack(
        fit: StackFit.expand,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(1.5),
            child: TripCover(entry: e, accent: accent),
          ),
          if (bookmarked)
            const Positioned(
              left: 3,
              top: 3,
              child: Icon(
                Icons.bookmark,
                size: 18,
                color: Colors.white,
                shadows: [Shadow(color: Color(0x66000000), blurRadius: 2)],
              ),
            ),
          if (!small || !e.isOffline || e.updateAvailable)
            Positioned(
              right: 5,
              bottom: 5,
              child: _Stamp(entry: e, small: small),
            ),
        ],
      ),
    );

    final card = Container(
      padding: small
          ? const EdgeInsets.fromLTRB(5, 5, 5, 7)
          : const EdgeInsets.fromLTRB(7, 7, 7, 9),
      decoration: BoxDecoration(
        color: p.paper,
        borderRadius: BorderRadius.circular(3),
        boxShadow: const [
          BoxShadow(
            color: Color(0x2E3C2814),
            blurRadius: 2,
            offset: Offset(0, 1),
          ),
          BoxShadow(
            color: Color(0x5A3C2814),
            blurRadius: 16,
            spreadRadius: -10,
            offset: Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          photo,
          SizedBox(height: small ? 5 : 7),
          Text(
            e.title,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: hand(small ? 17 : 22, Paper.captionInk),
          ),
          if (meta.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                meta,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: small ? 10 : 11,
                  fontWeight: FontWeight.w500,
                  color: Paper.captionMuted,
                ),
              ),
            ),
          if (origin != null)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Row(
                children: [
                  Icon(
                    r != null
                        ? Icons.group_outlined
                        : Icons.mobile_screen_share_outlined,
                    size: 12,
                    color: Paper.captionMuted,
                  ),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      origin,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                        color: Paper.captionMuted,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (!small && r?.tilesStatus == 'not_included' && !e.isOffline)
            const Padding(
              padding: EdgeInsets.only(top: 3),
              child: Text(
                'Map needs a connection',
                style: TextStyle(fontSize: 10.5, color: Paper.captionMuted),
              ),
            ),
          if (err != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                err,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Color(0xFFB3261E)),
              ),
            ),
        ],
      ),
    );

    return Semantics(
      button: true,
      label: e.title,
      hint: e.isOffline ? 'Open trip' : 'Long-press for options',
      child: GestureDetector(
        onTap: () => e.isOffline ? _open(context, e) : _showActions(context, e),
        onLongPress: () {
          HapticFeedback.mediumImpact();
          _showActions(context, e);
        },
        child: Transform.rotate(
          angle: _tilts[index % _tilts.length] * math.pi / 180,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Padding(
                padding: EdgeInsets.only(top: small ? 0 : 2),
                child: card,
              ),
              if (!small) Tape(index: index),
            ],
          ),
        ),
      ),
    );
  }
}

/// Status stamp in the photo corner: ✓ offline, Update, a progress ring, or Get.
class _Stamp extends StatelessWidget {
  const _Stamp({required this.entry, this.small = false});
  final TripEntry entry;
  final bool small;

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final p = Paper.of(context);
    final e = entry;
    final r = e.remote;
    const paper = Color(0xFFFFFDF8);
    const shadow = [
      BoxShadow(color: Color(0x33000000), blurRadius: 3, offset: Offset(0, 1)),
    ];

    Widget pill(String label, Color bg, Color fg, IconData? icon) => Container(
      height: 24,
      padding: const EdgeInsets.symmetric(horizontal: 9),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
        boxShadow: shadow,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 13, color: fg),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w800,
              color: fg,
            ),
          ),
        ],
      ),
    );

    if (s.isDownloading(e.id)) {
      final v = s.progress[e.id] ?? 0;
      return Tooltip(
        message:
            '${s.progressStage[e.id] ?? 'Downloading'} · ${(v * 100).round()}%',
        child: Container(
          width: 30,
          height: 30,
          padding: const EdgeInsets.all(2),
          decoration: const BoxDecoration(
            color: paper,
            shape: BoxShape.circle,
            boxShadow: shadow,
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              CircularProgressIndicator(
                value: v,
                strokeWidth: 3,
                color: p.accent,
                backgroundColor: p.accent.withValues(alpha: .18),
              ),
              Text(
                '${(v * 100).round()}',
                style: const TextStyle(
                  fontSize: 8.5,
                  fontWeight: FontWeight.w800,
                  color: Paper.captionInk,
                ),
              ),
            ],
          ),
        ),
      );
    }
    if (e.updateAvailable) {
      return Tooltip(
        message: 'Update available',
        child: _tap(
          () => s.download(e.id),
          pill('Update', paper, p.warn, Icons.refresh),
        ),
      );
    }
    if (e.isOffline) {
      return Tooltip(
        message: 'Available offline',
        child: Container(
          width: 26,
          height: 26,
          decoration: const BoxDecoration(
            color: paper,
            shape: BoxShape.circle,
            boxShadow: shadow,
          ),
          child: Icon(Icons.check, size: 15, color: p.ok),
        ),
      );
    }
    if (r?.status == 'processing') {
      return Tooltip(
        message: 'Preparing offline map…',
        child: pill(
          'Preparing',
          paper,
          Paper.captionMuted,
          Icons.hourglass_top,
        ),
      );
    }
    return Tooltip(
      message: 'Not downloaded',
      child: Semantics(
        button: true,
        label: 'Download',
        child: _tap(
          () => s.download(e.id),
          pill('Get', p.accent, Colors.white, null),
        ),
      ),
    );
  }

  // A generous hit target around a small stamp.
  Widget _tap(VoidCallback onTap, Widget child) => GestureDetector(
    behavior: HitTestBehavior.opaque,
    onTap: onTap,
    child: Padding(padding: const EdgeInsets.all(4), child: child),
  );
}

String _monthYear(String? date) {
  final d = date == null ? null : DateTime.tryParse(date);
  if (d == null) return '';
  const m = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${m[d.month - 1]} ’${(d.year % 100).toString().padLeft(2, '0')}';
}

void _open(BuildContext context, TripEntry e) => Navigator.push(
  context,
  MaterialPageRoute(
    settings: const RouteSettings(name: 'Trip'),
    builder: (_) => TripScreen(tripId: e.id),
  ),
);

/// Everything that used to be a button or swipe on the old card: the pressed polaroid
/// "peels off" into the sheet header, actions are rows below it.
Future<void> _showActions(BuildContext context, TripEntry e) async {
  final s = context.read<AppState>();
  final r = e.remote;
  final downloading = s.isDownloading(e.id);
  final processing = r?.status == 'processing';
  final bookmarked = s.isBookmarked(e.id);
  final size = r != null ? r.bundleBytes + r.tilesBytes : e.local?.bytes ?? 0;
  final accent = tripAccent(context, e);
  await showPaperSheet<void>(
    context,
    builder: (ctx) {
      final p = Paper.of(ctx);
      final (stamp, stampColor, stampIcon) = e.updateAvailable
          ? ('Update', p.warn, Icons.refresh)
          : e.isOffline
          ? ('Offline', p.ok, Icons.check)
          : processing
          ? ('Preparing', Paper.captionMuted, Icons.hourglass_top)
          : ('Not saved', p.accent, Icons.cloud_outlined);
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 4, 22, 16),
            child: Row(
              children: [
                SizedBox(
                  width: 92,
                  child: PaperObject(
                    tilt: -3,
                    padding: const EdgeInsets.fromLTRB(5, 5, 5, 6),
                    child: AspectRatio(
                      aspectRatio: 1 / .78,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(1),
                        child: TripCover(entry: e, accent: accent),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        e.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: hand(30, p.ink).copyWith(height: .95),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        [
                          dateRange(e.startDate, e.endDate),
                          if (size > 0) formatBytes(size),
                        ].where((x) => x.isNotEmpty).join(' · '),
                        style: TextStyle(fontSize: 12.5, color: p.muted),
                      ),
                      const SizedBox(height: 8),
                      Stamp(label: stamp, color: stampColor, icon: stampIcon),
                    ],
                  ),
                ),
              ],
            ),
          ),
          PaperCard(
            children: [
              if (e.isOffline)
                PaperRow(
                  icon: Icons.open_in_full,
                  chip: ChipColor.mint,
                  title: 'Open',
                  onTap: () {
                    Navigator.pop(ctx);
                    _open(context, e);
                  },
                ),
              if (r != null &&
                  !downloading &&
                  (!e.isOffline || e.updateAvailable))
                PaperRow(
                  enabled: !(processing && !e.isOffline),
                  icon: e.isOffline ? Icons.system_update_alt : Icons.download,
                  chip: ChipColor.yellow,
                  title: e.isOffline ? 'Update' : 'Download',
                  subtitle: e.isOffline
                      ? 'Version ${r.version} is ready'
                      : 'Save it for offline use',
                  onTap: () {
                    Navigator.pop(ctx);
                    s.download(e.id);
                  },
                ),
              PaperRow(
                icon: Icons.ios_share,
                chip: ChipColor.pink,
                title: 'Share travel plan',
                subtitle: 'PDF or web link',
                onTap: () {
                  Navigator.pop(ctx);
                  showShareTripSheet(context, e);
                },
              ),
              PaperRow(
                icon: bookmarked
                    ? Icons.bookmark_remove_outlined
                    : Icons.bookmark_add_outlined,
                chip: ChipColor.blue,
                title: bookmarked ? 'Remove bookmark' : 'Bookmark',
                onTap: () {
                  Navigator.pop(ctx);
                  s.toggleBookmark(e.id);
                  HapticFeedback.lightImpact();
                },
              ),
            ],
          ),
          const SizedBox(height: 12),
          PaperCard(
            children: [
              PaperRow(
                icon: Icons.delete_outline,
                destructive: true,
                title: e.isOffline ? 'Delete offline copy' : 'Delete trip',
                onTap: () {
                  Navigator.pop(ctx);
                  _confirmDelete(context, e);
                },
              ),
            ],
          ),
        ],
      );
    },
  );
}

Future<void> _confirmDelete(BuildContext context, TripEntry e) async {
  final s = context.read<AppState>();
  final offline = e.isOffline;
  final ok = await showPaperConfirm(
    context,
    title: offline ? 'Delete offline copy?' : 'Delete trip?',
    message: offline
        ? '"${e.title}" stays in your account. You can download it again when you\'re online.'
        : 'Delete "${e.title}"? This can\'t be undone.',
  );
  if (!ok || !context.mounted) return;
  if (offline) {
    await s.deleteLocal(e.id);
  } else {
    await s.deleteTrip(e.id);
  }
  if (!context.mounted) return;
  ScaffoldMessenger.of(context)
    ..removeCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(
          offline
              ? 'Deleted offline copy of "${e.title}"'
              : 'Deleted "${e.title}"',
        ),
        duration: const Duration(seconds: 2),
      ),
    );
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 16),
      child: Column(
        children: [
          Transform.rotate(
            angle: -0.03,
            child: Container(
              width: 150,
              padding: const EdgeInsets.fromLTRB(8, 8, 8, 12),
              decoration: BoxDecoration(
                color: p.paper,
                borderRadius: BorderRadius.circular(3),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x2E3C2814),
                    blurRadius: 2,
                    offset: Offset(0, 1),
                  ),
                ],
              ),
              child: Column(
                children: [
                  Container(
                    height: 100,
                    color: const Color(0xFFEDE3D3),
                    alignment: Alignment.center,
                    child: Icon(Icons.map_outlined, size: 44, color: p.accent),
                  ),
                  const SizedBox(height: 8),
                  Text('No trips yet', style: hand(22, Paper.captionInk)),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text(
            'Ask your AI agent to plan a trip "with Waypack". It will publish it here, ready to download for offline use.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 15, height: 1.35, color: p.ink),
          ),
          const SizedBox(height: 16),
          PaperButton(
            label: 'How to connect your agent',
            kind: PaperButtonKind.secondary,
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                settings: const RouteSettings(name: 'Settings'),
                builder: (_) => const SettingsScreen(scrollToConnect: true),
              ),
            ),
          ),
          const SizedBox(height: 6),
          TextButton.icon(
            style: TextButton.styleFrom(foregroundColor: p.accent),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                settings: const RouteSettings(name: 'ReceiveNearby'),
                builder: (_) => const ReceiveNearbyScreen(),
              ),
            ),
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('Receive a trip from a nearby phone'),
          ),
        ],
      ),
    );
  }
}
