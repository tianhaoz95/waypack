import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:waypack/services/local_server.dart';
import 'package:waypack/services/trip_store.dart';

/// iOS closes a suspended app's listening socket; WebViews then fail with
/// "Could not connect to the server" (-1004) until the server is rebound.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized(); // rootBundle for the SDK
  HttpOverrides.global = null; // real sockets

  late Directory root;
  late LocalServer server;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('local_server_test');
    server = LocalServer(TripStore(root));
    await server.start();
  });
  tearDown(() async {
    await server.stop();
    await root.delete(recursive: true);
  });

  Future<int?> status(String origin, String token) async {
    final c = HttpClient();
    try {
      final req = await c.getUrl(
        Uri.parse('$origin/__waypack/tiles/t/index.json'),
      );
      req.headers.set('Cookie', 'wp_k=$token');
      final res = await req.close();
      await res.drain<void>();
      return res.statusCode;
    } on SocketException {
      return null; // connection refused, like WKWebView's -1004
    } finally {
      c.close(force: true);
    }
  }

  test('a healthy server is left alone', () async {
    final port = server.port;
    expect(await server.ensureRunning(), isFalse);
    expect(server.port, port);
  });

  test(
    'after the socket is torn down, ensureRunning rebinds on the same port',
    () async {
      final origin = server.origin;
      expect(await status(origin, server.token), 200);

      await server.debugDropSocket();
      expect(await status(origin, server.token), isNull); // the bug

      expect(await server.ensureRunning(), isTrue);
      expect(server.origin, origin); // open pages keep their origin and cookie
      expect(await status(origin, server.token), 200);
      expect(await server.ensureRunning(), isFalse);
    },
  );

  test('if the old port was taken meanwhile, it moves to a new one', () async {
    final oldPort = server.port;
    await server.debugDropSocket();
    final squatter = await HttpServer.bind(
      InternetAddress.loopbackIPv4,
      oldPort,
    );
    try {
      expect(await server.ensureRunning(), isTrue);
      expect(server.port, isNot(oldPort));
      expect(await status(server.origin, server.token), 200);
    } finally {
      await squatter.close(force: true);
    }
  });
}
