import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:waypack/services/pmtiles.dart';

class MemorySource implements RangeSource {
  MemorySource(this.bytes);
  final Uint8List bytes;
  int requests = 0;
  @override
  Future<Uint8List> read(int offset, int length) async {
    requests++;
    final end = (offset + length).clamp(0, bytes.length);
    return Uint8List.sublistView(bytes, offset, end);
  }
}

/// Builds a gzip-directory PMTiles archive with a root + leaves (leafSize entries each).
Uint8List buildArchive(
  Map<int, Uint8List> tiles, {
  int leafSize = 50,
  int maxZoom = 6,
}) {
  final ids = tiles.keys.toList()..sort();
  final data = BytesBuilder();
  final offsetOf = <String, int>{}; // dedupe identical contents
  final entries = <PmEntry>[];
  for (final id in ids) {
    final t = tiles[id]!;
    final key = base64.encode(t);
    final off = offsetOf.putIfAbsent(key, () {
      final o = data.length;
      data.add(t);
      return o;
    });
    final last = entries.isEmpty ? null : entries.last;
    if (last != null &&
        last.tileId + last.runLength == id &&
        last.offset == off) {
      last.runLength++;
    } else {
      entries.add(PmEntry(id, off, t.length, 1));
    }
  }
  final leaves = BytesBuilder();
  final rootEntries = <PmEntry>[];
  for (var i = 0; i < entries.length; i += leafSize) {
    final chunk = entries.sublist(i, (i + leafSize).clamp(0, entries.length));
    final b = gzip.encode(encodeDirectory(chunk));
    rootEntries.add(PmEntry(chunk.first.tileId, leaves.length, b.length, 0));
    leaves.add(b);
  }
  final root = gzip.encode(encodeDirectory(rootEntries));
  final meta = gzip.encode(utf8.encode('{"name":"test"}'));
  final leafBytes = leaves.takeBytes();
  final tileBytes = data.takeBytes();
  final h = PmHeader(
    rootOffset: kHeaderBytes,
    rootLength: root.length,
    metadataOffset: kHeaderBytes + root.length,
    metadataLength: meta.length,
    leafOffset: kHeaderBytes + root.length + meta.length,
    leafLength: leafBytes.length,
    tileDataOffset: kHeaderBytes + root.length + meta.length + leafBytes.length,
    tileDataLength: tileBytes.length,
    addressedTiles: ids.length,
    tileEntries: entries.length,
    tileContents: offsetOf.length,
    clustered: true,
    internalCompression: 2,
    tileCompression: 2,
    tileType: 1,
    minZoom: 0,
    maxZoom: maxZoom,
    minLonE7: -1800000000,
    minLatE7: -850511287,
    maxLonE7: 1800000000,
    maxLatE7: 850511287,
    centerZoom: 0,
    centerLonE7: 0,
    centerLatE7: 0,
  );
  return (BytesBuilder()
        ..add(h.serialize())
        ..add(root)
        ..add(meta)
        ..add(leafBytes)
        ..add(tileBytes))
      .takeBytes();
}

/// Reads one tile from an archive (root → leaves → data), or null.
Uint8List? getTile(Uint8List a, int id) {
  final h = PmHeader.parse(a);
  var dir = decodeDirectory(
    Uint8List.fromList(
      gzip.decode(a.sublist(h.rootOffset, h.rootOffset + h.rootLength)),
    ),
  );
  for (var depth = 0; depth < 4; depth++) {
    PmEntry? hit;
    for (final e in dir) {
      if (e.tileId <= id) hit = e;
    }
    if (hit == null) return null;
    if (hit.runLength == 0) {
      final o = h.leafOffset + hit.offset;
      dir = decodeDirectory(
        Uint8List.fromList(gzip.decode(a.sublist(o, o + hit.length))),
      );
      continue;
    }
    if (id >= hit.tileId + hit.runLength) return null;
    final o = h.tileDataOffset + hit.offset;
    return a.sublist(o, o + hit.length);
  }
  return null;
}

void main() {
  test('Hilbert tile ids match the PMTiles spec', () {
    expect(zxyToTileId(0, 0, 0), 0);
    expect(zxyToTileId(1, 0, 0), 1);
    expect(zxyToTileId(1, 0, 1), 2);
    expect(zxyToTileId(1, 1, 1), 3);
    expect(zxyToTileId(1, 1, 0), 4);
    expect(zxyToTileId(2, 0, 0), 5);
    expect(zxyToTileId(3, 0, 0), 21);
    expect(zxyToTileId(20, 0, 0), 366503875925);
    // Every id at z0..5 is distinct and inside its zoom's id range.
    for (var z = 0; z <= 5; z++) {
      final n = 1 << z, base = ((1 << 2 * z) - 1) ~/ 3;
      final seen = <int>{};
      for (var x = 0; x < n; x++) {
        for (var y = 0; y < n; y++) {
          final id = zxyToTileId(z, x, y);
          expect(id >= base && id < base + n * n, isTrue);
          seen.add(id);
        }
      }
      expect(seen.length, n * n);
    }
  });

  test('directory encoding round-trips', () {
    final e = [
      PmEntry(0, 0, 10, 1),
      PmEntry(5, 10, 20, 3),
      PmEntry(9, 100, 7, 0),
    ];
    final d = decodeDirectory(encodeDirectory(e));
    expect(
      [
        for (final x in d) [x.tileId, x.offset, x.length, x.runLength],
      ],
      [
        [0, 0, 10, 1],
        [5, 10, 20, 3],
        [9, 100, 7, 0],
      ],
    );
  });

  test('extract cuts exactly the bbox tiles from a leafy archive', () async {
    // World z0..6; "ocean" tiles in the west half share one content (run-length + dedupe).
    final ocean = Uint8List.fromList(utf8.encode('ocean'));
    final tiles = <int, Uint8List>{};
    for (var z = 0; z <= 6; z++) {
      final n = 1 << z;
      for (var x = 0; x < n; x++) {
        for (var y = 0; y < n; y++) {
          tiles[zxyToTileId(z, x, y)] = (z >= 3 && x < n ~/ 2)
              ? ocean
              : Uint8List.fromList(utf8.encode('$z/$x/$y'));
        }
      }
    }
    final src = MemorySource(buildArchive(tiles));
    final bbox = [-20.0, 30.0, 25.0, 60.0]; // straddles the ocean/land split
    final ex = PmtilesExtractor(src, concurrency: 3);
    final plan = await ex.plan(bbox, 5);
    final want = tileIdsForBbox(bbox, 0, 5);
    expect(plan.tiles, want.length);

    final dir = await Directory.systemTemp.createTemp('pmtiles_test');
    addTearDown(() => dir.delete(recursive: true));
    final out = File('${dir.path}/out.pmtiles');
    var progress = 0;
    await ex.write(plan, out, onBytes: (b) => progress = b);
    expect(progress, plan.tileBytes);

    final a = await out.readAsBytes();
    final h = PmHeader.parse(a);
    expect(h.maxZoom, 5);
    expect(h.addressedTiles, want.length);
    expect(h.tileDataOffset + h.tileDataLength, a.length);
    for (final id in want) {
      expect(getTile(a, id), tiles[id], reason: 'tile $id');
    }
    // A tile outside the bbox is absent; the z6 level wasn't requested.
    expect(getTile(a, zxyToTileId(5, 31, 31)), isNull);
    expect(getTile(a, zxyToTileId(6, 40, 20)), isNull);
    // Ocean content stored once.
    expect(h.tileContents, lessThan(h.addressedTiles));
  });

  test(
    'large extracts spill into leaf directories',
    () async {
      final tiles = <int, Uint8List>{};
      final rnd = Random(7);
      for (var z = 0; z <= 8; z++) {
        final n = 1 << z;
        for (var x = 0; x < n; x++) {
          for (var y = 0; y < n; y++) {
            // Varied lengths and gaps so the directory doesn't gzip down to nothing.
            if (rnd.nextInt(5) == 0) continue;
            tiles[zxyToTileId(z, x, y)] = Uint8List.fromList(
              utf8.encode('$z/$x/$y${'.' * rnd.nextInt(200)}'),
            );
          }
        }
      }
      final src = MemorySource(buildArchive(tiles, leafSize: 4000, maxZoom: 8));
      final ex = PmtilesExtractor(src);
      final plan = await ex.plan([-180, -85, 180, 85], 8);
      final dir = await Directory.systemTemp.createTemp('pmtiles_test');
      addTearDown(() => dir.delete(recursive: true));
      final out = File('${dir.path}/out.pmtiles');
      await ex.write(plan, out);
      final a = await out.readAsBytes();
      final h = PmHeader.parse(a);
      expect(h.leafLength, greaterThan(0));
      expect(h.addressedTiles, tiles.length);
      for (final id in tiles.keys) {
        expect(getTile(a, id), tiles[id], reason: 'tile $id');
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  ); // ~90k tiles; slow on a busy machine
}
