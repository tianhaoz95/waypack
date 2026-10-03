import 'dart:io';

import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

/// Native hand-offs used by the SDK bridge and native screens (design §7.2).
class Handoff {
  /// Opens Google Maps / Apple Maps for a coordinate. Prefers the installed app.
  static Future<void> openInMaps({required double lat, required double lon, String? label, String app = 'auto', bool navigate = true, String? fallbackUrl}) async {
    final ll = '$lat,$lon';
    final q = label == null ? '' : Uri.encodeComponent(label);
    final useApple = app == 'apple' || (app == 'auto' && Platform.isIOS);
    final candidates = <Uri>[];
    if (useApple && Platform.isIOS) {
      candidates.add(Uri.parse(navigate ? 'maps://?daddr=$ll${q.isEmpty ? '' : '&q=$q'}' : 'maps://?ll=$ll&q=${q.isEmpty ? ll : q}'));
    } else if (Platform.isIOS) {
      candidates.add(Uri.parse(navigate ? 'comgooglemaps://?daddr=$ll&directionsmode=driving' : 'comgooglemaps://?q=$ll&center=$ll'));
    } else if (Platform.isAndroid) {
      candidates.add(Uri.parse(navigate ? 'google.navigation:q=$ll' : 'geo:$ll?q=$ll${q.isEmpty ? '' : '($q)'}'));
    }
    candidates.add(Uri.parse(fallbackUrl ??
        (useApple
            ? 'https://maps.apple.com/?${navigate ? 'daddr' : 'll'}=$ll${q.isEmpty ? '' : '&q=$q'}'
            : navigate
                ? 'https://www.google.com/maps/dir/?api=1&destination=$ll'
                : 'https://www.google.com/maps/search/?api=1&query=$ll')));
    for (final u in candidates) {
      try {
        if (await launchUrl(u, mode: LaunchMode.externalApplication)) return;
      } catch (_) {/* try next */}
    }
  }

  static Future<void> openExternal(String url) async {
    final u = Uri.tryParse(url);
    if (u == null || !const {'http', 'https', 'tel', 'mailto', 'sms', 'maps', 'geo'}.contains(u.scheme)) return;
    await launchUrl(u, mode: LaunchMode.externalApplication);
  }

  static Future<void> share(String text) => SharePlus.instance.share(ShareParams(text: text));
}
