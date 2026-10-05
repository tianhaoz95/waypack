import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:waypack/services/local_server.dart';
import 'package:waypack/services/trip_store.dart';

void main() {
  // The binding is for rootBundle (the server unpacks the SDK); its HttpClient
  // stub (every request → 400) would hide the real sockets these tests use.
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;

  late HttpServer upstream;
  late LocalServer server;
  late Directory root;
  final planet = List<int>.generate(1000, (i) => i % 256);
  final seen = <String?>[];

  setUp(() async {
    seen.clear();
    // Stand-in for build.protomaps.com: serves ranges of a 1000-byte "planet".
    upstream = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    upstream.listen((req) async {
      final range = req.headers.value(HttpHeaders.rangeHeader);
      seen.add(range);
      final r = parseRange(range, planet.length)!;
      req.response
        ..statusCode = HttpStatus.partialContent
        ..headers.set('Content-Range', 'bytes ${r[0]}-${r[1]}/${planet.length}')
        ..headers.set('ETag', '"build-1"')
        ..add(planet.sublist(r[0], r[1] + 1));
      await req.response.close();
    });
    root = await Directory.systemTemp.createTemp('online_map_test');
    server = LocalServer(TripStore(root));
    await server.start();
    server.onlineMap = 'http://127.0.0.1:${upstream.port}/planet.pmtiles';
  });

  tearDown(() async {
    await server.stop();
    await upstream.close(force: true);
    await root.delete(recursive: true);
  });

  Future<HttpClientResponse> get(String path, {String? range}) async {
    final c = HttpClient();
    final req = await c.getUrl(Uri.parse('${server.origin}$path'));
    req.headers.set('Cookie', 'wp_k=${server.token}');
    if (range != null) req.headers.set(HttpHeaders.rangeHeader, range);
    final res = await req.close();
    c.close();
    return res;
  }

  Future<Map<String, dynamic>> index() async => jsonDecode(
    await utf8.decodeStream(await get('/__waypack/tiles/trip1/index.json')),
  );

  test(
    'index names the same-origin online map, and the proxy forwards ranges',
    () async {
      expect(
        (await index())['online'],
        '/__waypack/tiles/trip1/online.pmtiles',
      );
      final res = await get(
        '/__waypack/tiles/trip1/online.pmtiles',
        range: 'bytes=10-19',
      );
      expect(res.statusCode, 206);
      expect(res.headers.value('content-range'), 'bytes 10-19/1000');
      expect(res.headers.value('etag'), '"build-1"');
      final body = await res.fold<List<int>>([], (a, b) => a..addAll(b));
      expect(body, planet.sublist(10, 20));
      expect(seen, ['bytes=10-19']);
    },
  );

  test('a plain GET is never passed through (the planet is ~130 GB)', () async {
    final res = await get('/__waypack/tiles/trip1/online.pmtiles');
    expect(res.statusCode, 416);
    await res.drain<void>();
    expect(seen, isEmpty);
  });

  test('turning the setting off hides and blocks the online map', () async {
    server.useOnlineMap = false;
    expect((await index())['online'], isNull);
    final res = await get(
      '/__waypack/tiles/trip1/online.pmtiles',
      range: 'bytes=0-9',
    );
    expect(res.statusCode, 404);
    await res.drain<void>();
    expect(seen, isEmpty);
  });

  test('no connection → 502, so the page carries on without it', () async {
    server.onlineMap = 'http://127.0.0.1:1/planet.pmtiles';
    final res = await get(
      '/__waypack/tiles/trip1/online.pmtiles',
      range: 'bytes=0-9',
    );
    expect(res.statusCode, 502);
    await res.drain<void>();
  });
}
