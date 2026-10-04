import 'dart:convert';
import 'dart:io';

import 'package:archive/archive_io.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:path_provider/path_provider.dart';

import '../models/trip.dart';

/// On-device layout (design §8.2):
///   `<support>`/trips/{trip_id}/v{n}/...        unzipped bundle
///   `<support>`/trips/{trip_id}/local.json      what's downloaded
///   `<support>`/tiles/{trip_id}/{hash}.pmtiles  offline map extracts
///   `<support>`/sdk/{version}/...               Trip SDK (unpacked from assets/sdk.zip)
class TripStore {
  TripStore(this.root);
  final Directory root;

  static Future<TripStore> open() async {
    final dir = await getApplicationSupportDirectory();
    final s = TripStore(dir);
    await Directory('${dir.path}/trips').create(recursive: true);
    await Directory('${dir.path}/tiles').create(recursive: true);
    return s;
  }

  Directory tripDir(String id) => Directory('${root.path}/trips/$id');
  Directory versionDir(String id, int v) =>
      Directory('${root.path}/trips/$id/v$v');
  Directory tilesDir(String id) => Directory('${root.path}/tiles/$id');
  File localMeta(String id) => File('${root.path}/trips/$id/local.json');
  Directory get sdkRoot => Directory('${root.path}/sdk');

  Future<Map<String, LocalTrip>> loadAll() async {
    final out = <String, LocalTrip>{};
    final dir = Directory('${root.path}/trips');
    if (!await dir.exists()) return out;
    await for (final d in dir.list()) {
      if (d is! Directory) continue;
      final f = File('${d.path}/local.json');
      if (!await f.exists()) continue;
      try {
        final t = LocalTrip.fromJson(
          jsonDecode(await f.readAsString()) as Map<String, dynamic>,
        );
        if (await versionDir(t.id, t.version).exists()) out[t.id] = t;
      } catch (_) {
        /* corrupt meta: treat as not downloaded */
      }
    }
    return out;
  }

  Future<void> saveMeta(LocalTrip t) async {
    final f = localMeta(t.id);
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsString(jsonEncode(t.toJson()));
    await tmp.rename(f.path); // atomic replace
  }

  Future<void> deleteLocal(String id) async {
    for (final d in [tripDir(id), tilesDir(id)]) {
      if (await d.exists()) await d.delete(recursive: true);
    }
  }

  Future<int> usedBytes() async {
    var n = 0;
    for (final d in [
      Directory('${root.path}/trips'),
      Directory('${root.path}/tiles'),
    ]) {
      if (!await d.exists()) continue;
      await for (final e in d.list(recursive: true)) {
        if (e is File) n += await e.length();
      }
    }
    return n;
  }

  /// Unpacks the bundled SDK once per SDK version; returns its directory.
  Future<Directory> ensureSdk() async {
    final version = (await rootBundle.loadString('assets/sdk_version.txt'))
        .trim();
    final dir = Directory('${sdkRoot.path}/$version');
    if (await File('${dir.path}/.complete').exists()) return dir;
    final data = await rootBundle.load('assets/sdk.zip');
    final tmp = Directory('${sdkRoot.path}/.tmp-$version');
    if (await tmp.exists()) await tmp.delete(recursive: true);
    await tmp.create(recursive: true);
    final archive = ZipDecoder().decodeBytes(data.buffer.asUint8List());
    for (final f in archive.files) {
      if (!f.isFile) continue;
      final out = File('${tmp.path}/${safeRelative(f.name)}');
      await out.parent.create(recursive: true);
      await out.writeAsBytes(f.content);
    }
    await File('${tmp.path}/.complete').writeAsString(version);
    if (await dir.exists()) await dir.delete(recursive: true);
    await tmp.rename(dir.path);
    // Remove older SDK versions.
    await for (final d in sdkRoot.list()) {
      if (d is Directory && d.path != dir.path) await d.delete(recursive: true);
    }
    return dir;
  }
}

/// Rejects absolute paths, `..`, backslashes and NULs (zip-slip protection).
String safeRelative(String name) {
  if (name.isEmpty ||
      name.startsWith('/') ||
      name.contains('\\') ||
      name.contains('\u0000') ||
      RegExp(r'^[A-Za-z]:').hasMatch(name)) {
    throw FormatException('unsafe path in archive: $name');
  }
  final parts = name.split('/');
  if (parts.any((p) => p == '..')) {
    throw FormatException('unsafe path in archive: $name');
  }
  return parts.where((p) => p.isNotEmpty && p != '.').join('/');
}

/// Unzips a verified bundle into [dest] (which must not exist), rejecting unsafe entries.
Future<void> unzipBundle(File zip, Directory dest) async {
  final input = InputFileStream(zip.path);
  try {
    final archive = ZipDecoder().decodeStream(input);
    // Bundles zipped as a folder: strip the single top-level directory.
    final names = archive.files
        .where((f) => f.isFile && !f.name.startsWith('__MACOSX/'))
        .map((f) => f.name)
        .toList();
    var prefix = '';
    if (!names.contains('manifest.json')) {
      final firsts = names.map((n) => n.split('/').first).toSet();
      if (firsts.length == 1 &&
          names.contains('${firsts.first}/manifest.json')) {
        prefix = '${firsts.first}/';
      }
    }
    await dest.create(recursive: true);
    for (final f in archive.files) {
      if (f.isSymbolicLink) {
        throw const FormatException('symlinks are not allowed in bundles');
      }
      if (!f.isFile || f.name.startsWith('__MACOSX/')) continue;
      final rel = safeRelative(
        f.name.startsWith(prefix) ? f.name.substring(prefix.length) : f.name,
      );
      final out = File('${dest.path}/$rel');
      await out.parent.create(recursive: true);
      final os = OutputFileStream(out.path);
      f.writeContent(os);
      await os.close();
    }
  } finally {
    await input.close();
  }
}
