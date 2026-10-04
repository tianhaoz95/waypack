/// A trip as listed by the server.
class RemoteTrip {
  RemoteTrip({
    required this.id,
    required this.title,
    this.startDate,
    this.endDate,
    required this.version,
    required this.status,
    required this.bundleBytes,
    required this.tilesBytes,
    required this.tilesStatus,
  });

  final String id;
  final String title;
  final String? startDate;
  final String? endDate;
  final int version;
  final String status; // processing | ready | failed
  final int bundleBytes;
  final int tilesBytes;
  final String
  tilesStatus; // ready | processing | not_included | failed | expired

  factory RemoteTrip.fromJson(Map<String, dynamic> j) => RemoteTrip(
    id: j['id'] as String,
    title: j['title'] as String,
    startDate: j['start_date'] as String?,
    endDate: j['end_date'] as String?,
    version: (j['current_version'] as num?)?.toInt() ?? 0,
    status: j['status'] as String? ?? 'processing',
    bundleBytes: ((j['sizes'] as Map?)?['bundle_bytes'] as num?)?.toInt() ?? 0,
    tilesBytes: ((j['sizes'] as Map?)?['tiles_bytes'] as num?)?.toInt() ?? 0,
    tilesStatus: j['tiles_status'] as String? ?? 'not_included',
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'title': title,
    'start_date': startDate,
    'end_date': endDate,
    'current_version': version,
    'status': status,
    'sizes': {'bundle_bytes': bundleBytes, 'tiles_bytes': tilesBytes},
    'tiles_status': tilesStatus,
  };
}

/// What's on this device for a trip (persisted as trips/{id}/local.json).
class LocalTrip {
  LocalTrip({
    required this.id,
    required this.title,
    required this.version,
    this.startDate,
    this.endDate,
    required this.bundleSha256,
    required this.tiles,
    required this.bytes,
    required this.downloadedAt,
    this.tilesIncluded = true,
    this.owner,
    this.accent,
    this.accentDark,
  });

  /// Trip theme colours (manifest.theme) for native screens.
  final String? accent;
  final String? accentDark;

  /// Supabase user id that downloaded it; other accounts on this device don't see it.
  final String? owner;
  final String id;
  final String title;
  final int version;
  final String? startDate;
  final String? endDate;
  final String bundleSha256;
  final List<LocalTiles> tiles;
  final int bytes;
  final DateTime downloadedAt;
  final bool tilesIncluded;

  factory LocalTrip.fromJson(Map<String, dynamic> j) => LocalTrip(
    id: j['id'] as String,
    title: j['title'] as String,
    version: (j['version'] as num).toInt(),
    startDate: j['start_date'] as String?,
    endDate: j['end_date'] as String?,
    bundleSha256: j['bundle_sha256'] as String,
    tiles: ((j['tiles'] as List?) ?? const [])
        .map((t) => LocalTiles.fromJson(t as Map<String, dynamic>))
        .toList(),
    bytes: (j['bytes'] as num).toInt(),
    downloadedAt: DateTime.parse(j['downloaded_at'] as String),
    tilesIncluded: j['tiles_included'] as bool? ?? true,
    owner: j['owner'] as String?,
    accent: j['accent'] as String?,
    accentDark: j['accent_dark'] as String?,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'title': title,
    'version': version,
    'start_date': startDate,
    'end_date': endDate,
    'bundle_sha256': bundleSha256,
    'tiles': tiles.map((t) => t.toJson()).toList(),
    'bytes': bytes,
    'downloaded_at': downloadedAt.toIso8601String(),
    'tiles_included': tilesIncluded,
    'owner': owner,
    'accent': accent,
    'accent_dark': accentDark,
  };
}

class LocalTiles {
  LocalTiles({
    required this.areaHash,
    required this.file,
    required this.sha256,
    required this.bytes,
    required this.bbox,
    required this.maxZoom,
  });
  final String areaHash;
  final String file; // file name under tiles/{trip}/
  final String sha256;
  final int bytes;
  final List<double> bbox;
  final int maxZoom;

  factory LocalTiles.fromJson(Map<String, dynamic> j) => LocalTiles(
    areaHash: j['area_hash'] as String,
    file: j['file'] as String,
    sha256: j['sha256'] as String,
    bytes: (j['bytes'] as num).toInt(),
    bbox: (j['bbox'] as List).map((e) => (e as num).toDouble()).toList(),
    maxZoom: (j['max_zoom'] as num).toInt(),
  );

  Map<String, dynamic> toJson() => {
    'area_hash': areaHash,
    'file': file,
    'sha256': sha256,
    'bytes': bytes,
    'bbox': bbox,
    'max_zoom': maxZoom,
  };
}

/// Merged view for the trips list.
enum DownloadState {
  notDownloaded,
  downloading,
  offline,
  updateAvailable,
  failed,
}
