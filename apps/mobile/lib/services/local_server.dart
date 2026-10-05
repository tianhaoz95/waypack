import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/services.dart' show rootBundle;

import 'trip_store.dart';

/// Runtime CSP for bundle HTML (design §4.4). Keep in sync with packages/cli/src/files.ts.
const kBundleCsp =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
    "worker-src 'self' blob:; frame-src 'none'; object-src 'none'";

const _types = {
  'html': 'text/html; charset=utf-8',
  'htm': 'text/html; charset=utf-8',
  'js': 'text/javascript; charset=utf-8',
  'mjs': 'text/javascript; charset=utf-8',
  'css': 'text/css; charset=utf-8',
  'json': 'application/json; charset=utf-8',
  'svg': 'image/svg+xml',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'webp': 'image/webp',
  'gif': 'image/gif',
  'avif': 'image/avif',
  'ico': 'image/x-icon',
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'ttf': 'font/ttf',
  'otf': 'font/otf',
  'pbf': 'application/x-protobuf',
  'pmtiles': 'application/octet-stream',
  'txt': 'text/plain; charset=utf-8',
  'geojson': 'application/geo+json',
  'gpx': 'application/gpx+xml',
  'mp4': 'video/mp4',
  'mp3': 'audio/mpeg',
};

String contentTypeFor(String path) =>
    _types[path.split('.').last.toLowerCase()] ?? 'application/octet-stream';

/// Loopback HTTP server that serves downloaded trips to the WebView (design §8.2).
///
/// - Bound to 127.0.0.1 on a random port.
/// - Every request needs the per-launch token: passed once as `?k=` on the first
///   navigation, then as an HttpOnly SameSite=Strict cookie. Other apps on the
///   device can't guess it.
/// - `/t/{trip}/…` bundle files (current local version), `/__waypack/sdk/v1/…` SDK,
///   `/__waypack/tiles/{trip}/…` PMTiles with Range support. CSP on HTML.
/// - `/__waypack/tiles/{trip}/online.pmtiles` proxies range reads to the online
///   basemap, so pages can show it under `connect-src 'self'`.
class LocalServer {
  LocalServer(this.store);
  final TripStore store;

  HttpServer? _server;
  late final String token = _randomToken();
  late Directory _sdkDir;

  /// Current version per trip (set by the app when trips load/download).
  final Map<String, int> versions = {};

  /// Tile files per trip.
  final Map<String, List<String>> tiles = {};

  /// Online basemap (.pmtiles URL from the server), shown when connected and
  /// [useOnlineMap] is on. Downloaded extracts still win where they cover.
  String? onlineMap;
  bool useOnlineMap = true;

  final HttpClient _upstream = HttpClient()
    ..connectionTimeout = const Duration(seconds: 8)
    ..autoUncompress = false;

  // Kept separately: HttpServer.port can throw once iOS has torn the socket down.
  int _port = 0;
  int get port => _port;
  String get origin => 'http://127.0.0.1:$port';

  /// URL that opens a trip's bundle (first navigation carries the token).
  String tripUrl(String tripId, {String page = 'index.html'}) =>
      '$origin/t/$tripId/$page?k=$token';

  static String _randomToken() {
    final r = Random.secure();
    return base64Url
        .encode(List<int>.generate(24, (_) => r.nextInt(256)))
        .replaceAll('=', '');
  }

  Future<void> start() async {
    _sdkDir = await store.ensureSdk();
    await _bind(0);
  }

  bool _listening = false;

  Future<void> _bind(int port) async {
    final server = await HttpServer.bind(
      InternetAddress.loopbackIPv4,
      port,
      shared: false,
    );
    server.autoCompress = false;
    _server = server;
    _port = server.port;
    _listening = true;
    server.listen(
      _handle,
      onError: (_) {},
      // iOS reclaims listening sockets while the app is suspended; the stream ends.
      onDone: () {
        if (identical(_server, server)) _listening = false;
      },
    );
  }

  /// Makes sure the server still accepts connections, rebinding if not.
  ///
  /// iOS tears down a suspended app's listening socket, so after the app comes
  /// back (e.g. from publishing a new trip version in another app) WebViews get
  /// "Could not connect to the server" (-1004) until it is rebound. Rebinds on
  /// the same port when possible so open pages keep their origin and cookie.
  /// Returns true if it had to rebind (callers should reload their pages).
  Future<bool> ensureRunning() async {
    if (_listening && await _answers(port)) return false;
    final old = _server;
    final oldPort = port;
    _listening = false;
    try {
      await old?.close(force: true);
    } catch (_) {}
    try {
      await _bind(oldPort);
    } on SocketException {
      await _bind(
        0,
      ); // the old port is taken; pages get the new origin on reload
    }
    return true;
  }

  /// Tests: close the listening socket behind the server's back, as iOS does
  /// to a suspended app.
  @visibleForTesting
  Future<void> debugDropSocket() async => _server?.close(force: true);

  /// Our server identifies itself with [_instance]; another process that took
  /// the port after iOS freed it must not be mistaken for it.
  final String _instance = _randomToken();

  Future<bool> _answers(int port) async {
    if (port == 0) return false;
    final c = HttpClient()..connectionTimeout = const Duration(seconds: 1);
    try {
      final req = await c.getUrl(
        Uri.parse('http://127.0.0.1:$port/__waypack/health'),
      );
      final res = await req.close().timeout(const Duration(seconds: 2));
      final body = await res.transform(utf8.decoder).join();
      return res.statusCode == 200 && body == _instance;
    } catch (_) {
      return false;
    } finally {
      c.close(force: true);
    }
  }

  Future<void> stop() async {
    _upstream.close(force: true);
    await _server?.close(force: true);
  }

  bool _authorized(HttpRequest req) {
    if (req.uri.queryParameters['k'] == token) return true;
    return req.cookies.any((c) => c.name == 'wp_k' && c.value == token);
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    try {
      res.headers.set('X-Content-Type-Options', 'nosniff');
      res.headers.set('Referrer-Policy', 'no-referrer');
      // Only accept requests addressed to our loopback origin (DNS-rebinding defense).
      final host = req.headers.host ?? '';
      if (host != '127.0.0.1' && host != 'localhost') {
        return await _status(res, 421);
      }
      if (req.method != 'GET' && req.method != 'HEAD') {
        return await _status(res, 405);
      }
      if (req.uri.path == '/__waypack/health') {
        res.headers.set('Cache-Control', 'no-store');
        res.write(_instance);
        return await res.close();
      }
      if (!_authorized(req)) return await _status(res, 403);

      // Swap the one-time ?k= for a cookie and redirect to the clean URL.
      if (req.uri.queryParameters.containsKey('k')) {
        final clean = req.uri.replace(
          queryParameters: Map.of(req.uri.queryParameters)..remove('k'),
        );
        res.headers.add(
          'Set-Cookie',
          'wp_k=$token; Path=/; HttpOnly; SameSite=Strict',
        );
        res.statusCode = HttpStatus.found;
        res.headers.set(
          'Location',
          clean.toString().replaceFirst(RegExp(r'\?$'), ''),
        );
        return await res.close();
      }

      final segs = req.uri.pathSegments; // already percent-decoded
      if (segs.length >= 2 && segs[0] == 't') {
        return await _serveBundle(req, segs[1], segs.sublist(2));
      }
      if (segs.length >= 3 &&
          segs[0] == '__waypack' &&
          segs[1] == 'sdk' &&
          segs[2] == 'v1') {
        return await _serveFile(req, _sdkDir, segs.sublist(3), cache: true);
      }
      if (segs.length >= 3 && segs[0] == '__waypack' && segs[1] == 'tiles') {
        return await _serveTiles(req, segs[2], segs.sublist(3));
      }
      return await _status(res, 404);
    } catch (e) {
      try {
        _status(res, 500);
      } catch (_) {}
    }
  }

  Future<void> _serveBundle(
    HttpRequest req,
    String tripId,
    List<String> rest,
  ) async {
    // Built-in native Map page for the overlay button (uses the trip's manifest + SDK).
    if (rest.length == 1 && rest[0] == '__waypack_map.html') {
      final html = await rootBundle.loadString('assets/app/map.html');
      final res = req.response;
      res.headers.set('Content-Type', 'text/html; charset=utf-8');
      res.headers.set('Content-Security-Policy', kBundleCsp);
      res.write(html);
      return res.close();
    }
    final v = versions[tripId];
    if (v == null) return _status(req.response, 404);
    final path = rest.isEmpty || rest.last.isEmpty
        ? [...rest.where((s) => s.isNotEmpty), 'index.html']
        : rest;
    return _serveFile(req, store.versionDir(tripId, v), path, csp: true);
  }

  Future<void> _serveTiles(
    HttpRequest req,
    String tripId,
    List<String> rest,
  ) async {
    final res = req.response;
    if (rest.length == 1 && rest[0] == 'index.json') {
      final files = tiles[tripId] ?? const [];
      res.headers.set('Content-Type', 'application/json');
      res.headers.set('Cache-Control', 'no-store');
      res.write(
        jsonEncode({
          'extracts': [
            for (final f in files) {'url': '/__waypack/tiles/$tripId/$f'},
          ],
          'online': useOnlineMap && onlineMap != null
              ? '/__waypack/tiles/$tripId/online.pmtiles'
              : null,
        }),
      );
      return res.close();
    }
    if (rest.length == 1 && rest[0] == 'online.pmtiles') {
      return _proxyOnline(req);
    }
    return _serveFile(req, store.tilesDir(tripId), rest);
  }

  /// Forwards one range read to the online basemap. Range is required: the
  /// planet is ~130 GB, so a plain GET is never passed through.
  Future<void> _proxyOnline(HttpRequest req) async {
    final res = req.response;
    final url = onlineMap;
    final range = req.headers.value(HttpHeaders.rangeHeader);
    if (!useOnlineMap || url == null) return _status(res, 404);
    if (range == null) return _status(res, 416);
    HttpClientResponse up;
    try {
      final r = await _upstream.openUrl(req.method, Uri.parse(url));
      r.headers.set(HttpHeaders.rangeHeader, range);
      up = await r.close().timeout(const Duration(seconds: 20));
    } catch (_) {
      return _status(
        res,
        502,
      ); // offline or captive network: the page skips the online map
    }
    res.statusCode = up.statusCode;
    for (final h in const [
      'content-range',
      'content-type',
      'content-encoding',
      'etag',
      'last-modified',
    ]) {
      final v = up.headers.value(h);
      if (v != null) res.headers.set(h, v);
    }
    if (up.contentLength >= 0) res.contentLength = up.contentLength;
    res.headers.set('Cache-Control', 'no-store');
    if (req.method == 'HEAD') {
      await up.drain<void>();
      return res.close();
    }
    try {
      await res.addStream(up);
    } catch (_) {
      // Upstream dropped mid-body; closing ends the response short.
    }
    return res.close();
  }

  Future<void> _serveFile(
    HttpRequest req,
    Directory root,
    List<String> segs, {
    bool csp = false,
    bool cache = false,
  }) async {
    final res = req.response;
    // Path traversal: reject dot segments and anything resolving outside root.
    if (segs.isEmpty ||
        segs.any(
          (s) =>
              s == '..' ||
              s == '.' ||
              s.isEmpty ||
              s.contains('/') ||
              s.contains('\\') ||
              s.contains('\u0000'),
        )) {
      return _status(res, 400);
    }
    final file = File('${root.path}/${segs.join('/')}');
    final rootPath = root.absolute.path;
    if (!file.absolute.path.startsWith('$rootPath/')) return _status(res, 400);
    if (!await file.exists()) return _status(res, 404);
    if ((await FileSystemEntity.type(file.path, followLinks: false)) !=
        FileSystemEntityType.file) {
      return _status(res, 404);
    }

    final size = await file.length();
    final type = contentTypeFor(file.path);
    res.headers.set('Content-Type', type);
    res.headers.set('Accept-Ranges', 'bytes');
    res.headers.set('Cache-Control', cache ? 'max-age=86400' : 'no-cache');
    if (csp && type.startsWith('text/html')) {
      res.headers.set('Content-Security-Policy', kBundleCsp);
    }

    final range = parseRange(req.headers.value(HttpHeaders.rangeHeader), size);
    if (range == null) {
      res.contentLength = size;
      if (req.method == 'HEAD') return res.close();
      await res.addStream(file.openRead());
      return res.close();
    }
    if (range.isEmpty) {
      res.statusCode = HttpStatus.requestedRangeNotSatisfiable;
      res.headers.set('Content-Range', 'bytes */$size');
      return res.close();
    }
    final (start, end) = (range[0], range[1]);
    res.statusCode = HttpStatus.partialContent;
    res.headers.set('Content-Range', 'bytes $start-$end/$size');
    res.contentLength = end - start + 1;
    if (req.method == 'HEAD') return res.close();
    await res.addStream(file.openRead(start, end + 1));
    return res.close();
  }

  Future<void> _status(HttpResponse res, int code) {
    res.statusCode = code;
    return res.close();
  }
}

/// Parses `bytes=a-b` / `bytes=a-` / `bytes=-n`. Returns null for no/unsupported
/// header (serve whole file), an empty list for unsatisfiable, else [start, end].
List<int>? parseRange(String? header, int size) {
  if (header == null) return null;
  final m = RegExp(r'^bytes=(\d*)-(\d*)$').firstMatch(header.trim());
  if (m == null) return null;
  final a = m.group(1)!, b = m.group(2)!;
  int start, end;
  if (a.isEmpty) {
    if (b.isEmpty) return null;
    start = max(0, size - int.parse(b));
    end = size - 1;
  } else {
    start = int.parse(a);
    end = b.isEmpty ? size - 1 : min(int.parse(b), size - 1);
  }
  if (start > end || start >= size) return const [];
  return [start, end];
}
