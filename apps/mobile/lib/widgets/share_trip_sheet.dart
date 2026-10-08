import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../screens/nearby_screens.dart';
import '../services/handoff.dart';
import '../services/pdf_export.dart';
import '../state/app_state.dart';
import 'scrapbook.dart';

/// "Postcards": the ways to share, grouped by who receives them.
Future<void> showShareTripSheet(BuildContext context, TripEntry e) async {
  final s = context.read<AppState>();

  void snack(String text, [Duration? d]) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(text), duration: d ?? const Duration(seconds: 4)),
    );
  }

  Future<void> pdf() async {
    try {
      snack('Generating PDF…', const Duration(seconds: 1));
      await PdfExportService.shareAsPdf(entry: e, store: s.store, api: s.api);
    } catch (err) {
      snack('Couldn\'t generate PDF: $err');
    }
  }

  Future<void> webLink() async {
    try {
      final link = await s.api.shareTrip(e.id);
      await Handoff.share(
        'View our "${e.title}" travel plan on the web: $link',
      );
    } catch (err) {
      snack('Couldn\'t create share link: $err');
    }
  }

  Future<void> invite() async {
    try {
      final link = await s.api.inviteLink(e.id);
      await Handoff.share(
        'Join "${e.title}" in Waypack, our trip plan that works offline: $link',
      );
    } catch (err) {
      snack('Couldn\'t create invite link: $err');
    }
  }

  void handoff() => Navigator.push(
    context,
    MaterialPageRoute(
      settings: const RouteSettings(name: 'HandoffSend'),
      builder: (_) => HandoffSendScreen(tripId: e.id),
    ),
  );

  await showPaperSheet<void>(
    context,
    builder: (ctx) {
      final p = Paper.of(ctx);
      var n = 0;
      Widget card(
        VoidCallback action,
        IconData icon,
        Color color,
        String title,
        String subtitle,
      ) => _Postcard(
        icon: icon,
        color: color,
        title: title,
        subtitle: subtitle,
        tilt: (n++).isEven ? -1.2 : 1,
        onTap: () {
          Navigator.pop(ctx);
          action();
        },
      );
      final anyone = [
        card(
          pdf,
          Icons.picture_as_pdf_outlined,
          ChipColor.pink,
          'Send as PDF',
          'Printable, opens on any device',
        ),
        if (e.remote != null)
          card(
            webLink,
            Icons.link,
            ChipColor.yellow,
            'Web link',
            'Opens in any browser, no app',
          ),
      ];
      final waypackers = [
        if (e.remote != null && !e.remote!.isCompanion)
          card(
            invite,
            Icons.group_add_outlined,
            ChipColor.mint,
            'Invite',
            'The trip + offline maps in their app',
          ),
        if (e.isOffline)
          card(
            handoff,
            Icons.mobile_screen_share_outlined,
            ChipColor.blue,
            'Hand off',
            'Phone to phone, no signal needed',
          ),
      ];
      Widget group(String label, List<Widget> cards) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 10, 22, 10),
            child: Text(label, style: hand(21, p.muted)),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: _Grid(children: cards),
          ),
        ],
      );
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 0, 22, 4),
            child: Text(
              'Share "${e.title}"',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: hand(32, p.ink),
            ),
          ),
          group('For anyone, no app', anyone),
          if (waypackers.isNotEmpty) ...[
            const SizedBox(height: 8),
            group('For fellow Waypackers', waypackers),
          ],
        ],
      );
    },
  );
}

/// Two columns of equal-width postcards.
class _Grid extends StatelessWidget {
  const _Grid({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, c) {
      const gap = 12.0;
      final w = (c.maxWidth - gap) / 2;
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: [for (final x in children) SizedBox(width: w, child: x)],
      );
    },
  );
}

/// A postcard: a stamp-shaped icon in the corner, handwritten title, one line of explanation.
class _Postcard extends StatelessWidget {
  const _Postcard({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.onTap,
    required this.tilt,
  });
  final IconData icon;
  final Color color;
  final String title, subtitle;
  final VoidCallback onTap;
  final double tilt;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: title,
    child: GestureDetector(
      onTap: onTap,
      child: PaperObject(
        tilt: tilt,
        radius: 6,
        padding: const EdgeInsets.all(12),
        child: SizedBox(
          height: 108,
          child: Stack(
            children: [
              Align(
                alignment: Alignment.topRight,
                child: Container(
                  width: 38,
                  height: 44,
                  decoration: BoxDecoration(
                    color: color,
                    border: Border.all(
                      color: Paper.lightPaper,
                      width: 2,
                      strokeAlign: BorderSide.strokeAlignInside,
                    ),
                  ),
                  child: Icon(icon, size: 19),
                ),
              ),
              Align(
                alignment: Alignment.bottomLeft,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: hand(24, Paper.captionInk)),
                    const SizedBox(height: 3),
                    Text(
                      subtitle,
                      maxLines: 2,
                      style: const TextStyle(
                        fontSize: 11.5,
                        height: 1.3,
                        color: Paper.captionMuted,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
