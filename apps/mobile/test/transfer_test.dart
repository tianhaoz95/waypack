import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:waypack/models/trip.dart';
import 'package:waypack/services/transfer.dart';
import 'package:waypack/services/trip_store.dart';

const tripId = '7c31bd4b-a04f-4c94-b876-5bf298833fbf';

/// A store with one downloaded trip (v3, one map extract).
Future<(TripStore, LocalTrip)> senderStore() async {
  final store = TripStore(await Directory.systemTemp.createTemp('wp-send-'));
  final v = store.versionDir(tripId, 3);
  await Directory('${v.path}/assets').create(recursive: true);
  await File('${v.path}/index.html')
      .writeAsString('<html><body>Tahoe</body></html>');
  await File('${v.path}/manifest.json').writeAsString('{"title":"Tahoe"}');
  await File('${v.path}/assets/app.js').writeAsString('console.log(1)');
  final tiles = File('${store.tilesDir(tripId).path}/abc123.pmtiles');
  await tiles.parent.create(recursive: true);
  final data = List.generate(300000, (i) => i % 251);
  await tiles.writeAsBytes(data);
  final trip = LocalTrip(
    id: tripId,
    title: 'Tahoe',
    version: 3,
    startDate: '2027-01-16',
    endDate: '2027-01-18',
    bundleSha256: 'server-sha',
    tiles: [
      LocalTiles(
        areaHash: 'abc123',
        file: 'abc123.pmtiles',
        sha256: sha256.convert(data).toString(),
        bytes: data.length,
        bbox: [-120.1, 38.9, -119.9, 39.2],
        maxZoom: 15,
      ),
    ],
    bytes: 300100,
    downloadedAt: DateTime.now(),
    owner: 'sender-user',
    accent: '#1e6fa8',
  );
  await store.saveMeta(trip);
  return (store, trip);
}

Future<TransferServer> serve(TripStore store, LocalTrip trip) =>
    TransferServer.start(
      store,
      trip,
      bindAddress: InternetAddress.loopbackIPv4,
      advertise: ['127.0.0.1'],
    );

void main() {
  group('transfer ticket', () {
    test('QR round trip', () {
      final t = TransferTicket(
        hosts: ['192.168.1.5:51234', '172.20.10.1:51234'],
        code: 'AB12CD34',
        offerSha: 'f' * 64,
      );
      final back = TransferTicket.parse(t.toUri());
      expect(back.hosts, t.hosts);
      expect(back.code, 'AB12CD34');
      expect(back.offerSha, 'f' * 64);
    });
    test('typed address and code (lenient about case, dashes, O/I/L)', () {
      final t = TransferTicket.parse(
        ' 192.168.1.5:51234 ',
        typedCode: 'ab12-cd3o',
      );
      expect(t.hosts, ['192.168.1.5:51234']);
      expect(t.code, 'AB12CD30');
      expect(t.offerSha, isNull);
      expect(formatCode('AB12CD30'), 'AB12-CD30');
    });
    test('rejects junk', () {
      expect(
        () => TransferTicket.parse('https://example.com'),
        throwsA(isA<TransferException>()),
      );
      expect(
        () => TransferTicket.parse('192.168.1.5:51234', typedCode: 'short'),
        throwsA(isA<TransferException>()),
      );
      expect(
        () =>
            TransferTicket.parse('waypack://receive?h=evil.com:80&k=AB12CD34'),
        throwsA(isA<TransferException>()),
      );
    });
    test('codes use the unambiguous alphabet', () {
      final c = newTransferCode(Random(1));
      expect(c, matches(RegExp(r'^[0-9A-HJKMNP-TV-Z]{8}$')));
    });
  });

  group('handoff over a real socket', () {
    test(
      'copies the trip, verifies it and installs it like a download',
      () async {
        final (sendStore, trip) = await senderStore();
        final server = await serve(sendStore, trip);
        final recvStore = TripStore(
          await Directory.systemTemp.createTemp('wp-recv-'),
        );
        final client = TransferClient(recvStore);
        try {
          final ticket = TransferTicket.parse(server.ticket.toUri());
          final (host, offer) = await client.connect(ticket);
          expect(offer.title, 'Tahoe');
          expect(
            offer.trip.containsKey('owner'),
            isFalse,
            reason: 'the sender\'s account id is not shared',
          );
          final stages = <String>{};
          final got = await client.receive(
            host,
            ticket,
            offer,
            owner: 'receiver-user',
            onProgress: (_, s) => stages.add(s),
          );
          expect(stages, containsAll(['Trip', 'Offline map', 'Unpacking']));
          expect(got.version, 3);
          expect(got.owner, 'receiver-user');
          expect(got.receivedNearby, isTrue);
          expect(got.accent, '#1e6fa8');
          expect(
            await File('${recvStore.versionDir(tripId, 3).path}/assets/app.js')
                .readAsString(),
            'console.log(1)',
          );
          expect(
            await File('${recvStore.tilesDir(tripId).path}/abc123.pmtiles')
                .length(),
            300000,
          );
          expect(
            (await recvStore.loadAll())[tripId]?.title,
            'Tahoe',
            reason: 'installed trips show up like downloads',
          );
          expect(
            await Directory(
              '${recvStore.tripDir(tripId).path}/.incoming-nearby',
            ).exists(),
            isFalse,
          );
          expect(server.completed, 1);
        } finally {
          client.close();
          await server.stop();
        }
      },
    );

    test('a wrong code is refused', () async {
      final (store, trip) = await senderStore();
      final server = await serve(store, trip);
      final client = TransferClient(
        TripStore(await Directory.systemTemp.createTemp('wp-recv-')),
      );
      try {
        final bad = TransferTicket(
          hosts: server.ticket.hosts,
          code: server.ticket.code == '00000000' ? '11111111' : '00000000',
        );
        await expectLater(
          client.connect(bad),
          throwsA(
            isA<TransferException>().having(
              (e) => e.message,
              'message',
              contains('wrong code'),
            ),
          ),
        );
      } finally {
        client.close();
        await server.stop();
      }
    });

    test('an offer that doesn\'t match the QR code is refused', () async {
      final (store, trip) = await senderStore();
      final server = await serve(store, trip);
      final client = TransferClient(
        TripStore(await Directory.systemTemp.createTemp('wp-recv-')),
      );
      try {
        final forged = TransferTicket(
          hosts: server.ticket.hosts,
          code: server.ticket.code,
          offerSha: '0' * 64,
        );
        await expectLater(
          client.connect(forged),
          throwsA(
            isA<TransferException>().having(
              (e) => e.message,
              'message',
              contains('didn\'t match'),
            ),
          ),
        );
      } finally {
        client.close();
        await server.stop();
      }
    });

    test(
      'a file damaged on the way is caught and nothing is installed',
      () async {
        final (store, trip) = await senderStore();
        final server = await serve(store, trip);
        final recv = TripStore(
          await Directory.systemTemp.createTemp('wp-recv-'),
        );
        final client = TransferClient(recv);
        try {
          final ticket = TransferTicket.parse(server.ticket.toUri());
          final (host, offer) = await client.connect(ticket);
          // Corrupt the map on the sender after the offer was made.
          final f = File('${store.tilesDir(tripId).path}/abc123.pmtiles');
          await f.writeAsBytes(List.filled(300000, 7));
          await expectLater(
            client.receive(host, ticket, offer),
            throwsA(
              isA<TransferException>().having(
                (e) => e.message,
                'message',
                contains('damaged'),
              ),
            ),
          );
          expect(await recv.loadAll(), isEmpty);
        } finally {
          client.close();
          await server.stop();
        }
      },
    );

    test('stops answering after repeated wrong codes', () async {
      final (store, trip) = await senderStore();
      final server = await serve(store, trip);
      final http = HttpClient();
      try {
        for (var i = 0; i < 20; i++) {
          try {
            final r = await (await http.getUrl(
              Uri.parse(
                'http://${server.ticket.hosts.first}/t/ZZZZZZZZ/offer.json',
              ),
            )).close();
            expect(r.statusCode, HttpStatus.forbidden);
            await r.drain<void>();
          } on IOException {
            // The 20th wrong code shuts the server down mid-response.
          }
        }
        await Future<void>.delayed(const Duration(milliseconds: 100));
        await expectLater(
          http
              .getUrl(
                Uri.parse(
                  'http://${server.ticket.hosts.first}/t/${server.ticket.code}/offer.json',
                ),
              )
              .then((r) => r.close()),
          throwsA(isA<IOException>()),
        );
      } finally {
        http.close(force: true);
        await server.stop();
      }
    });
  });
}
