import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../screens/nearby_screens.dart';
import '../services/handoff.dart';
import '../services/pdf_export.dart';
import '../state/app_state.dart';

Future<void> showShareTripSheet(BuildContext context, TripEntry e) async {
  final s = context.read<AppState>();
  showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: Text(
              'Share "${e.title}"',
              style: Theme.of(ctx).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
          ),
          ListTile(
            leading: const Icon(Icons.picture_as_pdf_outlined),
            title: const Text('Send as PDF'),
            subtitle: const Text(
              'Shareable PDF document — opens on any device, printable, no app needed',
            ),
            onTap: () async {
              Navigator.pop(ctx);
              try {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Generating PDF…'),
                      duration: Duration(seconds: 1),
                    ),
                  );
                }
                await PdfExportService.shareAsPdf(
                  entry: e,
                  store: s.store,
                  api: s.api,
                );
              } catch (err) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Couldn\'t generate PDF: $err')),
                  );
                }
              }
            },
          ),
          if (e.remote != null)
            ListTile(
              leading: const Icon(Icons.link),
              title: const Text('Send public web link'),
              subtitle: const Text(
                'Opens in any web browser without installing an app',
              ),
              onTap: () async {
                Navigator.pop(ctx);
                try {
                  final link = await s.api.shareTrip(e.id);
                  await Handoff.share(
                    'View our "${e.title}" travel plan on the web: $link',
                  );
                } catch (err) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Couldn\'t create share link: $err')),
                    );
                  }
                }
              },
            ),
          if (e.remote != null && !e.remote!.isCompanion)
            ListTile(
              leading: const Icon(Icons.group_add_outlined),
              title: const Text('Invite travel companions'),
              subtitle: const Text(
                'They get this trip in their Waypack app with offline maps',
              ),
              onTap: () async {
                Navigator.pop(ctx);
                try {
                  final link = await s.api.inviteLink(e.id);
                  await Handoff.share(
                    'Join "${e.title}" in Waypack, our trip plan that works offline: $link',
                  );
                } catch (err) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Couldn\'t create invite link: $err')),
                    );
                  }
                }
              },
            ),
          if (e.isOffline)
            ListTile(
              leading: const Icon(Icons.mobile_screen_share_outlined),
              title: const Text('Hand off to a nearby phone'),
              subtitle: const Text(
                'Copy offline to a companion\'s phone, no signal needed',
              ),
              onTap: () {
                Navigator.pop(ctx);
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    settings: const RouteSettings(name: 'HandoffSend'),
                    builder: (_) => HandoffSendScreen(tripId: e.id),
                  ),
                );
              },
            ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}
