import 'dart:collection';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:geolocator/geolocator.dart';

import '../services/handoff.dart';

/// Renders a trip bundle from the local server with the SDK's native bridge (design §7.2, §8.2).
class BundleWebView extends StatefulWidget {
  const BundleWebView({super.key, required this.url, required this.origin, this.navApp});

  final String url;
  final String origin; // http://127.0.0.1:<port>
  final String? navApp;

  @override
  State<BundleWebView> createState() => _BundleWebViewState();
}

class _BundleWebViewState extends State<BundleWebView> {
  String? _error;

  @override
  void initState() {
    super.initState();
    _ensureLocationPermission();
  }

  Future<void> _ensureLocationPermission() async {
    // Integration tests can't tap system dialogs.
    if (const bool.fromEnvironment('NO_LOCATION_PROMPT')) return;
    try {
      var p = await Geolocator.checkPermission();
      if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
    } catch (_) {/* map still works without the blue dot */}
  }

  bool _isLocal(WebUri? u) => u != null && '${u.scheme}://${u.host}:${u.port}' == widget.origin;

  String get _hostScript {
    final platform = Platform.isIOS ? 'ios' : 'android';
    final nav = widget.navApp == null ? '' : ", navApp: '${widget.navApp}'";
    return "window.__WAYPACK_HOST__ = Object.freeze({ platform: '$platform'$nav });";
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center)));
    }
    return InAppWebView(
      initialUrlRequest: URLRequest(url: WebUri(widget.url)),
      initialSettings: InAppWebViewSettings(
        javaScriptEnabled: true,
        javaScriptCanOpenWindowsAutomatically: false,
        supportMultipleWindows: true, // so window.open reaches onCreateWindow (and goes to the browser)
        allowFileAccess: false,
        allowFileAccessFromFileURLs: false,
        allowUniversalAccessFromFileURLs: false,
        allowContentAccess: false,
        geolocationEnabled: true,
        mediaPlaybackRequiresUserGesture: true,
        allowsInlineMediaPlayback: true,
        useShouldOverrideUrlLoading: true,
        transparentBackground: true,
        isInspectable: const bool.fromEnvironment('dart.vm.product') == false,
        cacheEnabled: true,
        disableDefaultErrorPage: true,
        thirdPartyCookiesEnabled: false,
        upgradeKnownHostsToHTTPS: false,
      ),
      initialUserScripts: UnmodifiableListView([
        UserScript(source: _hostScript, injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START),
      ]),
      onWebViewCreated: (c) {
        c.addJavaScriptHandler(
          handlerName: 'openInMaps',
          callback: (args) async {
            final a = (args.isNotEmpty ? args.first : {}) as Map;
            await Handoff.openInMaps(
              lat: (a['lat'] as num).toDouble(),
              lon: (a['lon'] as num).toDouble(),
              label: a['label'] as String?,
              app: (a['app'] as String?) ?? 'auto',
              navigate: a['navigate'] != false,
              fallbackUrl: a['url'] as String?,
            );
            return true;
          },
        );
        c.addJavaScriptHandler(
          handlerName: 'openExternal',
          callback: (args) async {
            final a = (args.isNotEmpty ? args.first : {}) as Map;
            await Handoff.openExternal('${a['url']}');
            return true;
          },
        );
        c.addJavaScriptHandler(
          handlerName: 'share',
          callback: (args) async {
            final a = (args.isNotEmpty ? args.first : {}) as Map;
            await Handoff.share('${a['text']}');
            return true;
          },
        );
      },
      // Non-loopback navigations open in the system browser / native app.
      shouldOverrideUrlLoading: (c, action) async {
        final u = action.request.url;
        if (_isLocal(u) || u?.scheme == 'about' || u?.scheme == 'blob' || u?.scheme == 'data') return NavigationActionPolicy.ALLOW;
        if (u != null) await Handoff.openExternal(u.toString());
        return NavigationActionPolicy.CANCEL;
      },
      onCreateWindow: (c, action) async {
        final u = action.request.url;
        if (u != null && !_isLocal(u)) await Handoff.openExternal(u.toString());
        return false;
      },
      // Android: grant geolocation to our loopback origin only.
      onGeolocationPermissionsShowPrompt: (c, origin) async {
        final ok = origin.startsWith(widget.origin);
        return GeolocationPermissionShowPromptResponse(origin: origin, allow: ok, retain: ok);
      },
      onPermissionRequest: (c, req) async {
        final ok = _isLocal(req.origin) && req.resources.every((r) => r == PermissionResourceType.GEOLOCATION);
        return PermissionResponse(resources: req.resources, action: ok ? PermissionResponseAction.GRANT : PermissionResponseAction.DENY);
      },
      onReceivedError: (c, req, err) {
        if (req.isForMainFrame == true) setState(() => _error = 'This trip could not be opened (${err.description}). Try re-downloading it.');
      },
    );
  }
}
