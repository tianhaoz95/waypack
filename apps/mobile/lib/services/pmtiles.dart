import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// On-device `pmtiles extract`: cuts a trip's offline map straight out of a remote
/// PMTiles v3 planet with HTTP range requests and writes a standalone archive.
///
/// Used when the server runs in device-map mode (no tiler container, DECISIONS #54).
/// Output is a normal clustered PMTiles v3 file, the same as the container produces,
/// so the local server, the map page and companion handoff treat both alike.
/// Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md

class PmtilesException implements Exception {
  PmtilesException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Byte ranges of a PMTiles archive.
abstract class RangeSource {
  /// Bytes `[offset, offset + length)`. May return fewer only at end of file.
  Future<Uint8List> read(int offset, int length);
}

/// Range reads over HTTPS, with retries for transient failures. Fails if the
/// file changes mid-extract (ETag changes), so a new planet build can't mix in.
class HttpRangeSource implements RangeSource {
  HttpRangeSource(this.url, {http.Client? client})
    : _client = client ?? http.Client();
  final String url;
  final http.Client _client;
  String? _etag;

  @override
  Future<Uint8List> read(int offset, int length) async {
    for (var attempt = 0; ; attempt++) {
      try {
        final res = await _client
            .get(
              Uri.parse(url),
              headers: {'Range': 'bytes=$offset-${offset + length - 1}'},
            )
            .timeout(const Duration(seconds: 60));
        if (res.statusCode == 206) {
          final etag = res.headers['etag'];
          if (etag != null) {
            if (_etag != null && _etag != etag) {
              throw PmtilesException(
                'The map source changed during the download. Try again.',
              );
            }
            _etag = etag;
          }
          return res.bodyBytes;
        }
        if (res.statusCode == 200) {
          throw PmtilesException(
            'The map source doesn\'t support partial downloads.',
          );
        }
        if (res.statusCode >= 500 || res.statusCode == 429) {
          throw _Transient('HTTP ${res.statusCode}');
        }
        throw PmtilesException(
          'The map source is unavailable (HTTP ${res.statusCode}).',
        );
      } on PmtilesException {
        rethrow;
      } catch (e) {
        // Timeouts, socket errors, 5xx: back off and retry a few times.
        if (attempt >= 4) {
          throw PmtilesException(
            'Lost connection while downloading the map. Try again.',
          );
        }
        await Future<void>.delayed(Duration(milliseconds: 500 << attempt));
      }
    }
  }

  void close() => _client.close();
}

class _Transient implements Exception {
  _Transient(this.why);
  final String why;
}

// ------------------------------------------------------------------ format

const kHeaderBytes = 127;
const _rootFetchBytes = 16384;
const _compressionNone = 1;
const _compressionGzip = 2;

class PmHeader {
  PmHeader({
    required this.rootOffset,
    required this.rootLength,
    required this.metadataOffset,
    required this.metadataLength,
    required this.leafOffset,
    required this.leafLength,
    required this.tileDataOffset,
    required this.tileDataLength,
    required this.addressedTiles,
    required this.tileEntries,
    required this.tileContents,
    required this.clustered,
    required this.internalCompression,
    required this.tileCompression,
    required this.tileType,
    required this.minZoom,
    required this.maxZoom,
    required this.minLonE7,
    required this.minLatE7,
    required this.maxLonE7,
    required this.maxLatE7,
    required this.centerZoom,
    required this.centerLonE7,
    required this.centerLatE7,
  });

  final int rootOffset, rootLength, metadataOffset, metadataLength;
  final int leafOffset, leafLength, tileDataOffset, tileDataLength;
  final int addressedTiles, tileEntries, tileContents;
  final bool clustered;
  final int internalCompression, tileCompression, tileType;
  final int minZoom, maxZoom;
  final int minLonE7, minLatE7, maxLonE7, maxLatE7;
  final int centerZoom, centerLonE7, centerLatE7;

  static PmHeader parse(Uint8List b) {
    if (b.length < kHeaderBytes ||
        String.fromCharCodes(b.sublist(0, 7)) != 'PMTiles') {
      throw PmtilesException('The map source is not a PMTiles archive.');
    }
    if (b[7] != 3) {
      throw PmtilesException('Unsupported PMTiles version ${b[7]}.');
    }
    final d = ByteData.sublistView(b);
    int u64(int o) => d.getUint64(o, Endian.little);
    int i32(int o) => d.getInt32(o, Endian.little);
    return PmHeader(
      rootOffset: u64(8),
      rootLength: u64(16),
      metadataOffset: u64(24),
      metadataLength: u64(32),
      leafOffset: u64(40),
      leafLength: u64(48),
      tileDataOffset: u64(56),
      tileDataLength: u64(64),
      addressedTiles: u64(72),
      tileEntries: u64(80),
      tileContents: u64(88),
      clustered: b[96] == 1,
      internalCompression: b[97],
      tileCompression: b[98],
      tileType: b[99],
      minZoom: b[100],
      maxZoom: b[101],
      minLonE7: i32(102),
      minLatE7: i32(106),
      maxLonE7: i32(110),
      maxLatE7: i32(114),
      centerZoom: b[118],
      centerLonE7: i32(119),
      centerLatE7: i32(123),
    );
  }

  Uint8List serialize() {
    final b = Uint8List(kHeaderBytes);
    b.setAll(0, 'PMTiles'.codeUnits);
    b[7] = 3;
    final d = ByteData.sublistView(b);
    void u64(int o, int v) => d.setUint64(o, v, Endian.little);
    void i32(int o, int v) => d.setInt32(o, v, Endian.little);
    u64(8, rootOffset);
    u64(16, rootLength);
    u64(24, metadataOffset);
    u64(32, metadataLength);
    u64(40, leafOffset);
    u64(48, leafLength);
    u64(56, tileDataOffset);
    u64(64, tileDataLength);
    u64(72, addressedTiles);
    u64(80, tileEntries);
    u64(88, tileContents);
    b[96] = clustered ? 1 : 0;
    b[97] = internalCompression;
    b[98] = tileCompression;
    b[99] = tileType;
    b[100] = minZoom;
    b[101] = maxZoom;
    i32(102, minLonE7);
    i32(106, minLatE7);
    i32(110, maxLonE7);
    i32(114, maxLatE7);
    b[118] = centerZoom;
    i32(119, centerLonE7);
    i32(123, centerLatE7);
    return b;
  }
}

/// One directory entry. `runLength == 0` points at a leaf directory.
class PmEntry {
  PmEntry(this.tileId, this.offset, this.length, this.runLength);
  final int tileId;
  final int offset;
  final int length;
  int runLength;
}

List<PmEntry> decodeDirectory(Uint8List b) {
  var pos = 0;
  int varint() {
    var result = 0, shift = 0;
    while (true) {
      if (pos >= b.length) throw PmtilesException('Corrupt map directory.');
      final byte = b[pos++];
      result |= (byte & 0x7f) << shift;
      if (byte < 0x80) return result;
      shift += 7;
      if (shift > 63) throw PmtilesException('Corrupt map directory.');
    }
  }

  final n = varint();
  final ids = List<int>.filled(n, 0);
  final runs = List<int>.filled(n, 0);
  final lens = List<int>.filled(n, 0);
  final offs = List<int>.filled(n, 0);
  var last = 0;
  for (var i = 0; i < n; i++) {
    last += varint();
    ids[i] = last;
  }
  for (var i = 0; i < n; i++) {
    runs[i] = varint();
  }
  for (var i = 0; i < n; i++) {
    lens[i] = varint();
  }
  for (var i = 0; i < n; i++) {
    final v = varint();
    offs[i] = (v == 0 && i > 0) ? offs[i - 1] + lens[i - 1] : v - 1;
  }
  return [
    for (var i = 0; i < n; i++) PmEntry(ids[i], offs[i], lens[i], runs[i]),
  ];
}

Uint8List encodeDirectory(List<PmEntry> entries) {
  final out = BytesBuilder(copy: false);
  void varint(int v) {
    while (v >= 0x80) {
      out.addByte((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.addByte(v);
  }

  varint(entries.length);
  var last = 0;
  for (final e in entries) {
    varint(e.tileId - last);
    last = e.tileId;
  }
  for (final e in entries) {
    varint(e.runLength);
  }
  for (final e in entries) {
    varint(e.length);
  }
  for (var i = 0; i < entries.length; i++) {
    final e = entries[i];
    final contiguous =
        i > 0 && e.offset == entries[i - 1].offset + entries[i - 1].length;
    varint(contiguous ? 0 : e.offset + 1);
  }
  return out.takeBytes();
}

Uint8List _decompress(Uint8List b, int compression) => switch (compression) {
  _compressionNone => b,
  _compressionGzip => Uint8List.fromList(gzip.decode(b)),
  _ => throw PmtilesException(
    'Unsupported map directory compression ($compression).',
  ),
};

Uint8List _compress(Uint8List b, int compression) => switch (compression) {
  _compressionNone => b,
  _compressionGzip => Uint8List.fromList(gzip.encode(b)),
  _ => throw PmtilesException(
    'Unsupported map directory compression ($compression).',
  ),
};

/// Hilbert tile id of (z, x, y), as defined by the PMTiles v3 spec.
int zxyToTileId(int z, int x, int y) {
  if (z > 26) throw ArgumentError('zoom $z too large');
  final n = 1 << z;
  if (x < 0 || y < 0 || x >= n || y >= n) {
    throw RangeError('tile $z/$x/$y out of range');
  }
  final acc = ((1 << (2 * z)) - 1) ~/ 3;
  var tx = x, ty = y, d = 0;
  for (var s = n >> 1; s > 0; s >>= 1) {
    final rx = (tx & s) > 0 ? 1 : 0;
    final ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry == 0) {
      if (rx == 1) {
        tx = n - 1 - tx;
        ty = n - 1 - ty;
      }
      final t = tx;
      tx = ty;
      ty = t;
    }
  }
  return acc + d;
}

int _lonToX(double lon, int n) =>
    ((lon + 180) / 360 * n).floor().clamp(0, n - 1);

int _latToY(double lat, int n) {
  final r = lat.clamp(-85.0511, 85.0511) * math.pi / 180;
  final y = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n;
  return y.floor().clamp(0, n - 1);
}

/// Sorted tile ids covering [bbox] (`[minLon, minLat, maxLon, maxLat]`) at zooms
/// [minZoom]..[maxZoom].
List<int> tileIdsForBbox(List<double> bbox, int minZoom, int maxZoom) {
  final ids = <int>[];
  for (var z = minZoom; z <= maxZoom; z++) {
    final n = 1 << z;
    final x0 = _lonToX(bbox[0], n), x1 = _lonToX(bbox[2], n);
    final y0 = _latToY(bbox[3], n), y1 = _latToY(bbox[1], n);
    for (var x = x0; x <= x1; x++) {
      for (var y = y0; y <= y1; y++) {
        ids.add(zxyToTileId(z, x, y));
      }
    }
  }
  ids.sort();
  return ids;
}

/// First index in `a[lo, hi)` with `a[i] >= v`.
int _lowerBound(List<int> a, int v, int lo, int hi) {
  while (lo < hi) {
    final mid = (lo + hi) >> 1;
    if (a[mid] < v) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/// Runs [f] over [items] with at most [n] in flight; stops at the first error.
Future<void> _pool<T>(
  Iterable<T> items,
  int n,
  Future<void> Function(T) f,
) async {
  final it = items.iterator;
  Object? error;
  StackTrace? trace;
  Future<void> worker() async {
    while (error == null && it.moveNext()) {
      try {
        await f(it.current);
      } catch (e, s) {
        error ??= e;
        trace ??= s;
      }
    }
  }

  await Future.wait(List.generate(n, (_) => worker()));
  if (error != null) Error.throwWithStackTrace(error!, trace!);
}

class _Range {
  _Range(this.offset, this.length);
  final int offset;
  final int length;
}

class _Chunk {
  _Chunk(this.offset);
  final int offset;
  int end = 0;
  final ranges = <_Range>[];
}

/// Groups sorted, non-overlapping ranges into fewer requests: neighbours closer
/// than [maxGap] share a request, up to [maxChunk] bytes per request.
List<_Chunk> _chunks(
  List<_Range> sorted, {
  int maxGap = 64 << 10,
  int maxChunk = 4 << 20,
}) {
  final out = <_Chunk>[];
  for (final r in sorted) {
    final last = out.isEmpty ? null : out.last;
    if (last != null &&
        r.offset - last.end <= maxGap &&
        r.offset + r.length - last.offset <= maxChunk) {
      last.ranges.add(r);
      last.end = math.max(last.end, r.offset + r.length);
    } else {
      out.add(
        _Chunk(r.offset)
          ..end = r.offset + r.length
          ..ranges.add(r),
      );
    }
  }
  return out;
}

// ----------------------------------------------------------------- extract

/// What an extract will download: known after reading only the directories.
class ExtractPlan {
  ExtractPlan._(
    this._header,
    this._metadata,
    this._ids,
    this._srcOffsets,
    this._lengths,
    this._blobs,
    this.bbox,
    this.minZoom,
    this.maxZoom,
  );

  final PmHeader _header;
  final Uint8List _metadata;
  final List<int> _ids, _srcOffsets, _lengths; // per tile, sorted by tile id
  final List<_Range> _blobs; // unique tile contents, sorted by source offset
  final List<double> bbox;
  final int minZoom, maxZoom;

  int get tiles => _ids.length;

  /// Bytes of tile data to download (the output is this plus a few KB).
  int get tileBytes => _blobs.fold(0, (n, b) => n + b.length);
}

class PmtilesExtractor {
  PmtilesExtractor(this.source, {this.concurrency = 6});
  final RangeSource source;
  final int concurrency;

  /// Reads the header and the directories that cover [bbox] up to [maxZoom].
  Future<ExtractPlan> plan(List<double> bbox, int maxZoom) async {
    final head = await source.read(0, _rootFetchBytes);
    final h = PmHeader.parse(head);
    if (h.internalCompression != _compressionNone &&
        h.internalCompression != _compressionGzip) {
      throw PmtilesException(
        'Unsupported map directory compression (${h.internalCompression}).',
      );
    }
    final minZ = h.minZoom;
    final maxZ = math.min(maxZoom, h.maxZoom);
    if (maxZ < minZ) {
      throw PmtilesException(
        'The map source has no tiles at these zoom levels.',
      );
    }
    final wanted = tileIdsForBbox(bbox, minZ, maxZ);

    final rootBytes = h.rootOffset + h.rootLength <= head.length
        ? Uint8List.sublistView(head, h.rootOffset, h.rootOffset + h.rootLength)
        : await source.read(h.rootOffset, h.rootLength);
    final metadata = h.metadataLength == 0
        ? Uint8List(0)
        : await source.read(h.metadataOffset, h.metadataLength);

    final hitIds = <int>[], hitOffsets = <int>[], hitLengths = <int>[];

    // Walk the directory tree, one level at a time; only descend into leaves
    // whose tile-id span contains a wanted tile.
    var level = <(Uint8List, int, int)>[(rootBytes, 0, wanted.length)];
    for (var depth = 0; level.isNotEmpty; depth++) {
      if (depth > 4) {
        throw PmtilesException('Corrupt map directory (too deep).');
      }
      final leaves = <(_Range, int, int)>[];
      for (final (bytes, lo, hi) in level) {
        final entries = decodeDirectory(
          _decompress(bytes, h.internalCompression),
        );
        for (var i = 0; i < entries.length; i++) {
          final e = entries[i];
          final end = e.runLength > 0
              ? e.tileId + e.runLength
              : (i + 1 < entries.length ? entries[i + 1].tileId : 1 << 62);
          final a = _lowerBound(wanted, e.tileId, lo, hi);
          final b = _lowerBound(wanted, end, a, hi);
          if (a == b) continue;
          if (e.runLength > 0) {
            for (var j = a; j < b; j++) {
              hitIds.add(wanted[j]);
              hitOffsets.add(e.offset);
              hitLengths.add(e.length);
            }
          } else {
            leaves.add((_Range(h.leafOffset + e.offset, e.length), a, b));
          }
        }
      }
      // Fetch the next level's leaves, merging neighbours into shared requests.
      final byOffset = <int, Uint8List>{};
      final ranges = leaves.map((l) => l.$1).toList()
        ..sort((x, y) => x.offset.compareTo(y.offset));
      await _pool(_chunks(_dedupe(ranges)), concurrency, (c) async {
        final data = await source.read(c.offset, c.end - c.offset);
        for (final r in c.ranges) {
          byOffset[r.offset] = Uint8List.sublistView(
            data,
            r.offset - c.offset,
            r.offset - c.offset + r.length,
          );
        }
      });
      level = [for (final (r, a, b) in leaves) (byOffset[r.offset]!, a, b)];
    }

    // Sort hits by tile id; collect unique contents in source order.
    final order = List<int>.generate(hitIds.length, (i) => i)
      ..sort((x, y) => hitIds[x].compareTo(hitIds[y]));
    final ids = [for (final i in order) hitIds[i]];
    final offs = [for (final i in order) hitOffsets[i]];
    final lens = [for (final i in order) hitLengths[i]];
    final seen = <int, int>{};
    for (var i = 0; i < offs.length; i++) {
      seen[offs[i]] = lens[i];
    }
    final blobs = [for (final e in seen.entries) _Range(e.key, e.value)]
      ..sort((x, y) => x.offset.compareTo(y.offset));
    return ExtractPlan._(h, metadata, ids, offs, lens, blobs, bbox, minZ, maxZ);
  }

  /// Downloads the planned tiles and writes a complete archive to [dest].
  /// [onBytes] reports tile bytes written so far (out of [ExtractPlan.tileBytes]).
  Future<void> write(
    ExtractPlan p,
    File dest, {
    void Function(int bytes)? onBytes,
  }) async {
    final h = p._header;
    final c = h.internalCompression;

    // New layout: tile contents packed in source order (= tile-id order for a
    // clustered source), so the output stays clustered.
    final newOffset = <int, int>{};
    var tileDataLength = 0;
    for (final b in p._blobs) {
      newOffset[b.offset] = tileDataLength;
      tileDataLength += b.length;
    }
    final entries = <PmEntry>[];
    for (var i = 0; i < p._ids.length; i++) {
      final id = p._ids[i],
          off = newOffset[p._srcOffsets[i]]!,
          len = p._lengths[i];
      final last = entries.isEmpty ? null : entries.last;
      if (last != null &&
          last.tileId + last.runLength == id &&
          last.offset == off &&
          last.length == len) {
        last.runLength++;
      } else {
        entries.add(PmEntry(id, off, len, 1));
      }
    }
    final (root, leaves) = _buildDirectories(entries, c);

    final rootOffset = kHeaderBytes;
    final metadataOffset = rootOffset + root.length;
    final leafOffset = metadataOffset + p._metadata.length;
    final tileDataOffset = leafOffset + leaves.length;
    final b = p.bbox;
    int e7(double v) => (v * 1e7).round();
    final minLon = math.max(b[0], h.minLonE7 / 1e7),
        maxLon = math.min(b[2], h.maxLonE7 / 1e7);
    final minLat = math.max(b[1], h.minLatE7 / 1e7),
        maxLat = math.min(b[3], h.maxLatE7 / 1e7);
    final header = PmHeader(
      rootOffset: rootOffset,
      rootLength: root.length,
      metadataOffset: metadataOffset,
      metadataLength: p._metadata.length,
      leafOffset: leafOffset,
      leafLength: leaves.length,
      tileDataOffset: tileDataOffset,
      tileDataLength: tileDataLength,
      addressedTiles: p._ids.length,
      tileEntries: entries.length,
      tileContents: p._blobs.length,
      clustered: h.clustered,
      internalCompression: c,
      tileCompression: h.tileCompression,
      tileType: h.tileType,
      minZoom: p.minZoom,
      maxZoom: p.maxZoom,
      minLonE7: e7(minLon),
      minLatE7: e7(minLat),
      maxLonE7: e7(maxLon),
      maxLatE7: e7(maxLat),
      centerZoom: h.centerZoom.clamp(p.minZoom, p.maxZoom),
      centerLonE7: e7((minLon + maxLon) / 2),
      centerLatE7: e7((minLat + maxLat) / 2),
    );

    final raf = await dest.open(mode: FileMode.write);
    try {
      await raf.writeFrom(header.serialize());
      await raf.writeFrom(root);
      await raf.writeFrom(p._metadata);
      await raf.writeFrom(leaves);
      await raf.truncate(tileDataOffset + tileDataLength);

      // Fetch tile data in merged chunks; writes are serialized on one file handle.
      var written = 0;
      var writing = Future<void>.value();
      await _pool(_chunks(p._blobs), concurrency, (chunk) async {
        // Directory offsets are relative to the source's tile-data section.
        final data = await source.read(
          h.tileDataOffset + chunk.offset,
          chunk.end - chunk.offset,
        );
        if (data.length < chunk.end - chunk.offset) {
          throw PmtilesException('The map download was cut short. Try again.');
        }
        writing = writing.then((_) async {
          for (final r in chunk.ranges) {
            await raf.setPosition(tileDataOffset + newOffset[r.offset]!);
            await raf.writeFrom(
              data,
              r.offset - chunk.offset,
              r.offset - chunk.offset + r.length,
            );
            written += r.length;
          }
          onBytes?.call(written);
        });
        await writing;
      });
      await writing;
      await raf.flush();
    } finally {
      await raf.close();
    }
  }
}

List<_Range> _dedupe(List<_Range> sorted) {
  final out = <_Range>[];
  for (final r in sorted) {
    if (out.isEmpty || out.last.offset != r.offset) out.add(r);
  }
  return out;
}

/// Root directory plus (if the root alone would exceed 16 KiB with the header)
/// one level of leaf directories, like go-pmtiles' optimizeDirectories.
(Uint8List, Uint8List) _buildDirectories(
  List<PmEntry> entries,
  int compression,
) {
  const rootLimit = _rootFetchBytes - kHeaderBytes;
  final root = _compress(encodeDirectory(entries), compression);
  if (root.length <= rootLimit) return (root, Uint8List(0));
  var leafSize = 4096;
  while (true) {
    final leaves = BytesBuilder(copy: false);
    final rootEntries = <PmEntry>[];
    for (var i = 0; i < entries.length; i += leafSize) {
      final chunk = entries.sublist(i, math.min(i + leafSize, entries.length));
      final bytes = _compress(encodeDirectory(chunk), compression);
      rootEntries.add(
        PmEntry(chunk.first.tileId, leaves.length, bytes.length, 0),
      );
      leaves.add(bytes);
    }
    final r = _compress(encodeDirectory(rootEntries), compression);
    if (r.length <= rootLimit) return (r, leaves.takeBytes());
    leafSize = (leafSize * 1.2).ceil();
  }
}
