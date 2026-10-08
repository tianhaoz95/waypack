import 'dart:async';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:crypto/crypto.dart';

import '../models/trip.dart';
import 'api.dart';
import 'pmtiles.dart';
import 'trip_store.dart';

typedef Progress = void Function(double fraction, String stage);

class DownloadException implements Exception {
  DownloadException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Downloads a trip (bundle + map extracts), verifies SHA-256, unzips and swaps it in
/// atomically. The previous version stays usable until the new one is complete (§8.3).
/// In device-map mode the extracts are cut here from the planet instead of downloaded.
class TripDownloader {
  TripDownloader(this.api, this.store);
  final Api api;
  final TripStore store;

  Future<LocalTrip> download(
    String tripId, {
    required String? owner,
    LocalTrip? existing,
    Progress? onProgress,
  }) async {
    final info = await api.downloadInfo(tripId);
    if (info.tilesStatus == 'processing') {
      throw DownloadException(
        'The offline map is still being prepared. Try again in a minute.',
      );
    }
    var total = info.totalBytes; // grows once device-cut maps are planned
    var done = 0;
    void report(int bytes, String stage) => onProgress?.call(
      ((done + bytes) / total.clamp(1, 1 << 62)).clamp(0, 1).toDouble(),
      stage,
    );

    final work = Directory(
      '${store.tripDir(tripId).path}/.incoming-v${info.version}',
    );
    if (await work.exists()) await work.delete(recursive: true);
    await work.create(recursive: true);

    // 1. Bundle
    final zip = File('${work.path}/bundle.zip');
    await _fetch(
      info.bundleUrl,
      zip,
      info.bundleBytes,
      (b) => report(b, 'Trip'),
    );
    await _verify(zip, info.bundleSha256, 'trip bundle');
    done += info.bundleBytes;

    // 2. Map extracts (reuse files we already have with the same area hash)
    final tiles = <LocalTiles>[];
    final tilesDir = store.tilesDir(tripId);
    await tilesDir.create(recursive: true);
    for (final t in info.tiles) {
      final hash = t['area_hash'] as String;
      final bytes = (t['bytes'] as num).toInt();
      final sha = t['sha256'] as String;
      final name = '$hash.pmtiles';
      final dest = File('${tilesDir.path}/$name');
      final have =
          existing?.tiles
              .where((x) => x.areaHash == hash && x.sha256 == sha)
              .isNotEmpty ??
          false;
      if (!(have && await dest.exists() && await dest.length() == bytes)) {
        final part = File('${work.path}/$name');
        await _fetch(
          t['url'] as String,
          part,
          bytes,
          (b) => report(b, 'Offline map'),
        );
        await _verify(part, sha, 'offline map');
        await part.rename(dest.path);
      }
      done += bytes;
      tiles.add(
        LocalTiles(
          areaHash: hash,
          file: name,
          sha256: sha,
          bytes: bytes,
          bbox: (t['bbox'] as List).map((e) => (e as num).toDouble()).toList(),
          maxZoom: (t['max_zoom'] as num).toInt(),
        ),
      );
    }

    // 2b. Device-map mode: cut each area from the planet with range requests.
    // Plan every area first (directories only) so progress has a real total.
    final source = info.deviceSource;
    if (info.tilesStatus == 'device' && source != null) {
      onProgress?.call(done / total.clamp(1, 1 << 62), 'Offline map');
      final planet = HttpRangeSource(source);
      final ex = PmtilesExtractor(planet);
      final slots = <int, LocalTiles>{};
      final todo = <(int, Map<String, dynamic>, ExtractPlan)>[];
      try {
        for (final a in info.deviceAreas) {
          final index = (a['area_index'] as num).toInt();
          final hash = a['area_hash'] as String;
          final bbox = (a['bbox'] as List)
              .map((e) => (e as num).toDouble())
              .toList();
          final maxZoom = (a['max_zoom'] as num).toInt();
          final prev = existing?.tiles
              .where((x) => x.areaHash == hash)
              .firstOrNull;
          final dest = File('${tilesDir.path}/$hash.pmtiles');
          if (prev != null &&
              await dest.exists() &&
              await dest.length() == prev.bytes) {
            slots[index] = prev;
            continue;
          }
          final plan = await ex.plan(bbox, maxZoom);
          total += plan.tileBytes;
          todo.add((index, a, plan));
        }
        for (final (index, a, plan) in todo) {
          final hash = a['area_hash'] as String;
          final name = '$hash.pmtiles';
          final part = File('${work.path}/$name');
          await ex.write(plan, part, onBytes: (b) => report(b, 'Offline map'));
          final sha = (await sha256.bind(part.openRead()).first).toString();
          final bytes = await part.length();
          await part.rename('${tilesDir.path}/$name');
          done += plan.tileBytes;
          slots[index] = LocalTiles(
            areaHash: hash,
            file: name,
            sha256: sha,
            bytes: bytes,
            bbox: plan.bbox,
            maxZoom: plan.maxZoom,
          );
        }
      } on PmtilesException catch (e) {
        throw DownloadException('Couldn\'t download the offline map. $e');
      } finally {
        planet.close();
      }
      tiles.addAll([for (final k in slots.keys.toList()..sort()) slots[k]!]);
    }

    // 3. Unzip into a staging dir, then swap into place.
    onProgress?.call(1, 'Unpacking');
    final staging = Directory('${work.path}/bundle');
    await unzipBundle(zip, staging);
    if (!await File('${staging.path}/index.html').exists() ||
        !await File('${staging.path}/manifest.json').exists()) {
      throw DownloadException(
        'Downloaded trip is incomplete (missing index.html or manifest.json).',
      );
    }
    final target = store.versionDir(tripId, info.version);
    if (await target.exists()) await target.delete(recursive: true);
    await staging.rename(target.path);

    final local = LocalTrip(
      id: tripId,
      title: info.title,
      version: info.version,
      startDate: info.startDate,
      endDate: info.endDate,
      bundleSha256: info.bundleSha256,
      tiles: tiles,
      bytes: info.bundleBytes + tiles.fold(0, (n, t) => n + t.bytes),
      downloadedAt: DateTime.now(),
      tilesIncluded: info.tilesStatus != 'not_included',
      onlineMap: info.onlineTilesUrl,
      owner: owner,
      accent:
          ((info.raw['manifest'] as Map?)?['theme'] as Map?)?['accent']
              as String?,
      accentDark:
          ((info.raw['manifest'] as Map?)?['theme'] as Map?)?['accent_dark']
              as String?,
      coverImage: () {
        final m = info.raw['manifest'] as Map?;
        final th = m?['theme'] as Map?;
        String? c = m?['cover_image'] as String? ?? th?['cover_image'] as String?;
        if (c == null) {
          for (final candidate in [
            'cover.jpg',
            'cover.jpeg',
            'cover.png',
            'cover.webp',
            'assets/cover.jpg',
            'assets/cover.jpeg',
            'assets/cover.png',
            'assets/cover.webp',
          ]) {
            if (File('${target.path}/$candidate').existsSync()) {
              c = candidate;
              break;
            }
          }
        }
        return c;
      }(),
    );
    await store.saveMeta(local);

    // 4. Clean up: staging, older versions, tiles no longer referenced.
    await work.delete(recursive: true);
    await for (final d in store.tripDir(tripId).list()) {
      if (d is Directory &&
          d.path != target.path &&
          RegExp(r'/v\d+$').hasMatch(d.path)) {
        await d.delete(recursive: true);
      }
    }
    final keep = tiles.map((t) => t.file).toSet();
    await for (final f in tilesDir.list()) {
      if (f is File && !keep.contains(f.uri.pathSegments.last)) {
        await f.delete();
      }
    }
    return local;
  }

  /// Resumable download via background_downloader (keeps going when the app is backgrounded).
  Future<void> _fetch(
    String url,
    File dest,
    int expectedBytes,
    void Function(int bytes) onBytes,
  ) async {
    final task = DownloadTask(
      url: url,
      filename: dest.uri.pathSegments.last,
      directory: dest.parent.path,
      baseDirectory: BaseDirectory.root,
      updates: Updates.statusAndProgress,
      allowPause: true,
      retries: 3,
      requiresWiFi: false,
      displayName: 'Waypack trip',
    );
    final result = await FileDownloader().download(
      task,
      onProgress: (p) {
        if (p >= 0) onBytes((p * expectedBytes).round());
      },
    );
    if (result.status != TaskStatus.complete) {
      final why = result.exception?.description ?? result.status.name;
      throw DownloadException(
        'Download failed ($why). Check your connection and try again.',
      );
    }
  }

  Future<void> _verify(File f, String expected, String what) async {
    final digest = await sha256.bind(f.openRead()).first;
    if (digest.toString() != expected) {
      await f.delete();
      throw DownloadException(
        'The $what was corrupted in transit (checksum mismatch). Try again.',
      );
    }
  }
}
