import 'dart:async';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:crypto/crypto.dart';

import '../models/trip.dart';
import 'api.dart';
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
    final total = info.totalBytes.clamp(1, 1 << 62);
    var done = 0;
    void report(int bytes, String stage) => onProgress?.call(
      ((done + bytes) / total).clamp(0, 1).toDouble(),
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
      bytes: info.totalBytes,
      downloadedAt: DateTime.now(),
      tilesIncluded: info.tilesStatus != 'not_included',
      owner: owner,
      accent:
          ((info.raw['manifest'] as Map?)?['theme'] as Map?)?['accent']
              as String?,
      accentDark:
          ((info.raw['manifest'] as Map?)?['theme'] as Map?)?['accent_dark']
              as String?,
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
