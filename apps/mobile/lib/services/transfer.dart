import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:archive/archive_io.dart';
import 'package:crypto/crypto.dart';

import '../models/trip.dart';
import 'trip_store.dart';

/// Offline phone-to-phone handoff (DECISIONS #48).
///
/// The sending device serves one downloaded trip over the local network (same Wi-Fi, or the
/// receiver joins the sender's Personal Hotspot, which works with no signal). The receiver gets
/// a [TransferTicket] from a QR code (or types the address and code), checks the offer against
/// the hash in the ticket, downloads every file, checks each SHA-256 and installs the trip the
/// same way a normal download does. Works between iPhone, Android and Mac.

const transferVersion = 1;

class TransferException implements Exception {
  TransferException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// One file in an offer: the zipped bundle, or an offline map extract.
class TransferFile {
  TransferFile({
    required this.name,
    required this.sha256,
    required this.bytes,
    required this.kind,
    this.areaHash,
    this.bbox,
    this.maxZoom,
  });
  final String name;
  final String sha256;
  final int bytes;
  final String kind; // bundle | tiles
  final String? areaHash;
  final List<double>? bbox;
  final int? maxZoom;

  Map<String, dynamic> toJson() => {
    'name': name,
    'sha256': sha256,
    'bytes': bytes,
    'kind': kind,
    if (areaHash != null) 'area_hash': areaHash,
    if (bbox != null) 'bbox': bbox,
    if (maxZoom != null) 'max_zoom': maxZoom,
  };

  factory TransferFile.fromJson(Map<String, dynamic> j) {
    final name = j['name'] as String;
    if (!RegExp(r'^[A-Za-z0-9_.-]{1,80}$').hasMatch(name) ||
        name.startsWith('.')) {
      throw TransferException('The other device sent an invalid file name.');
    }
    return TransferFile(
      name: name,
      sha256: j['sha256'] as String,
      bytes: (j['bytes'] as num).toInt(),
      kind: j['kind'] as String,
      areaHash: j['area_hash'] as String?,
      bbox: (j['bbox'] as List?)?.map((e) => (e as num).toDouble()).toList(),
      maxZoom: (j['max_zoom'] as num?)?.toInt(),
    );
  }
}

/// What the sender offers (served as offer.json).
class TransferOffer {
  TransferOffer({required this.trip, required this.files});
  final Map<String, dynamic> trip; // LocalTrip fields minus owner
  final List<TransferFile> files;

  int get totalBytes => files.fold(0, (n, f) => n + f.bytes);
  String get title => trip['title'] as String? ?? 'Trip';

  String encode() => jsonEncode({
    'v': transferVersion,
    'trip': trip,
    'files': files.map((f) => f.toJson()).toList(),
  });

  factory TransferOffer.decode(String body) {
    final j = jsonDecode(body) as Map<String, dynamic>;
    if ((j['v'] as num?)?.toInt() != transferVersion) {
      throw TransferException(
        'The other device has a different Waypack version. Update both apps and try again.',
      );
    }
    return TransferOffer(
      trip: (j['trip'] as Map).cast<String, dynamic>(),
      files: (j['files'] as List)
          .map((f) => TransferFile.fromJson((f as Map).cast<String, dynamic>()))
          .toList(),
    );
  }
}

/// How the receiver reaches the sender: what the QR code (or the typed address + code) carries.
class TransferTicket {
  TransferTicket({required this.hosts, required this.code, this.offerSha});
  final List<String> hosts; // "192.168.1.5:51234"
  final String code;
  final String? offerSha; // SHA-256 of offer.json; only in QR tickets

  String toUri() {
    final q = {'h': hosts.join(','), 'k': code, 'm': ?offerSha};
    return Uri(
      scheme: 'waypack',
      host: 'receive',
      queryParameters: q,
    ).toString();
  }

  /// A scanned QR (`waypack://receive?...`) or a typed "192.168.1.5:51234" + code.
  static TransferTicket parse(String input, {String? typedCode}) {
    final s = input.trim();
    if (s.startsWith('waypack://receive')) {
      final u = Uri.parse(s);
      final hosts = (u.queryParameters['h'] ?? '')
          .split(',')
          .where(_validHost)
          .toList();
      final code = u.queryParameters['k'] ?? '';
      if (hosts.isEmpty || !_validCode(code)) {
        throw TransferException('That QR code isn\'t a Waypack handoff.');
      }
      return TransferTicket(
        hosts: hosts,
        code: code,
        offerSha: u.queryParameters['m'],
      );
    }
    final code = normalizeCode(typedCode ?? '');
    if (!_validHost(s)) {
      throw TransferException(
        'Enter the address shown on the other phone, like 192.168.1.5:51234.',
      );
    }
    if (!_validCode(code)) {
      throw TransferException(
        'Enter the 8-character code shown on the other phone.',
      );
    }
    return TransferTicket(hosts: [s], code: code);
  }

  static bool _validHost(String h) =>
      RegExp(r'^(\d{1,3}\.){3}\d{1,3}:\d{2,5}$').hasMatch(h);
  static bool _validCode(String c) =>
      RegExp(r'^[0-9A-HJKMNP-TV-Z]{8}$').hasMatch(c);
}

/// Crockford base32 without ambiguous letters; typed codes are upper-cased and I/L/O mapped.
const _alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
String newTransferCode([Random? random]) {
  final r = random ?? Random.secure();
  return List.generate(8, (_) => _alphabet[r.nextInt(_alphabet.length)]).join();
}

String normalizeCode(String c) => c
    .toUpperCase()
    .replaceAll(RegExp(r'[\s-]'), '')
    .replaceAll('O', '0')
    .replaceAll('I', '1')
    .replaceAll('L', '1');

/// Displays a code as "ABCD-EFGH".
String formatCode(String c) =>
    c.length == 8 ? '${c.substring(0, 4)}-${c.substring(4)}' : c;

/// IPv4 addresses other devices on this network can reach (Wi-Fi, hotspot, Ethernet).
Future<List<String>> lanAddresses() async {
  final out = <String>[];
  for (final i in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
    for (final a in i.addresses) {
      final ip = a.address;
      if (a.isLoopback || ip.startsWith('169.254.')) continue;
      // Hotspot / Wi-Fi / Ethernet interfaces first; cellular (pdp_ip, rmnet) last.
      final cellular = RegExp(r'^(pdp_ip|rmnet|ccmni|utun|ipsec)')
          .hasMatch(i.name);
      if (cellular) {
        out.add(ip);
      } else {
        out.insert(0, ip);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------- sending

/// Serves one downloaded trip to a nearby device until [stop] (or [ttl], or one complete transfer
/// plus [lingerAfterDone] so a second companion can still connect).
class TransferServer {
  TransferServer._(
    this._server,
    this.ticket,
    this.offer,
    this._files,
    this._tmp,
  );

  final HttpServer _server;
  final TransferTicket ticket;
  final TransferOffer offer;
  final Map<String, File> _files;
  final Directory _tmp;
  final _progress = StreamController<TransferStatus>.broadcast();
  int _badRequests = 0;
  int _completed = 0;
  Timer? _ttl;
  bool _stopped = false;

  /// Bytes sent in the current transfer and completed transfers.
  Stream<TransferStatus> get status => _progress.stream;
  int get completed => _completed;

  static Future<TransferServer> start(
    TripStore store,
    LocalTrip trip, {
    Duration ttl = const Duration(minutes: 15),
    InternetAddress? bindAddress,
    List<String>? advertise,
  }) async {
    final version = store.versionDir(trip.id, trip.version);
    if (!await version.exists()) {
      throw TransferException('This trip isn\'t downloaded on this device.');
    }
    final tmp = await Directory.systemTemp.createTemp('waypack-transfer-');
    final zip = File('${tmp.path}/bundle.zip');
    await ZipFileEncoder().zipDirectory(version, filename: zip.path, level: 0);
    final files = <String, File>{'bundle.zip': zip};
    final list = <TransferFile>[
      TransferFile(
        name: 'bundle.zip',
        sha256: await _sha(zip),
        bytes: await zip.length(),
        kind: 'bundle',
      ),
    ];
    for (final t in trip.tiles) {
      final f = File('${store.tilesDir(trip.id).path}/${t.file}');
      if (!await f.exists()) continue;
      files[t.file] = f;
      list.add(
        TransferFile(
          name: t.file,
          sha256: t.sha256,
          bytes: t.bytes,
          kind: 'tiles',
          areaHash: t.areaHash,
          bbox: t.bbox,
          maxZoom: t.maxZoom,
        ),
      );
    }
    final tripJson = trip.toJson()..remove('owner');
    final offer = TransferOffer(trip: tripJson, files: list);
    final server = await HttpServer.bind(
      bindAddress ?? InternetAddress.anyIPv4,
      0,
    );
    final hosts = (advertise ?? await lanAddresses())
        .map((ip) => '$ip:${server.port}')
        .toList();
    final ticket = TransferTicket(
      hosts: hosts,
      code: newTransferCode(),
      offerSha: sha256.convert(utf8.encode(offer.encode())).toString(),
    );
    final s = TransferServer._(server, ticket, offer, files, tmp);
    s._ttl = Timer(ttl, s.stop);
    server.listen(s._handle, onError: (_) {});
    return s;
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    try {
      final seg = req.uri.pathSegments;
      // /t/<code>/offer.json | /t/<code>/file/<name>
      if (req.method != 'GET' ||
          seg.length < 3 ||
          seg[0] != 't' ||
          seg[1] != ticket.code) {
        res.statusCode = HttpStatus.forbidden;
        // Wrong codes on a LAN mean someone is guessing: stop after a few.
        if (++_badRequests >= 20) unawaited(stop());
        return;
      }
      if (seg.length == 3 && seg[2] == 'offer.json') {
        res.headers.contentType = ContentType.json;
        res.write(offer.encode());
        return;
      }
      if (seg.length == 4 && seg[2] == 'file' && _files.containsKey(seg[3])) {
        final f = _files[seg[3]]!;
        final len = await f.length();
        res.headers.contentType = ContentType.binary;
        res.contentLength = len;
        var sent = 0;
        await res.addStream(
          f.openRead().map((chunk) {
            sent += chunk.length;
            _progress.add(
              TransferStatus(
                file: seg[3],
                sent: sent,
                bytes: len,
                completed: _completed,
              ),
            );
            return chunk;
          }),
        );
        if (seg[3] == offer.files.last.name) {
          _completed++;
          _progress.add(
            TransferStatus(
              file: seg[3],
              sent: len,
              bytes: len,
              completed: _completed,
            ),
          );
        }
        return;
      }
      res.statusCode = HttpStatus.notFound;
    } catch (_) {
      res.statusCode = HttpStatus.internalServerError;
    } finally {
      await res.close().catchError((_) {});
    }
  }

  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    _ttl?.cancel();
    await _server.close(force: true);
    await _progress.close();
    if (await _tmp.exists()) await _tmp.delete(recursive: true);
  }

  static Future<String> _sha(File f) async =>
      (await sha256.bind(f.openRead()).first).toString();
}

class TransferStatus {
  TransferStatus({
    required this.file,
    required this.sent,
    required this.bytes,
    required this.completed,
  });
  final String file;
  final int sent;
  final int bytes;
  final int completed;
}

// -------------------------------------------------------------------------------- receiving

typedef TransferProgress = void Function(double fraction, String stage);

class TransferClient {
  TransferClient(this.store, {HttpClient? client})
    : _http =
          client ??
          (HttpClient()..connectionTimeout = const Duration(seconds: 4));
  final TripStore store;
  final HttpClient _http;

  /// Finds the sender (trying each advertised address) and reads its offer.
  Future<(String, TransferOffer)> connect(TransferTicket t) async {
    Object? last;
    for (final host in t.hosts) {
      try {
        final body = await _get(
          Uri.parse('http://$host/t/${t.code}/offer.json'),
        );
        final text = utf8.decode(body);
        if (t.offerSha != null &&
            sha256.convert(utf8.encode(text)).toString() != t.offerSha) {
          throw TransferException(
            'The other device\'s trip didn\'t match its QR code. Scan it again.',
          );
        }
        return (host, TransferOffer.decode(text));
      } on TransferException {
        rethrow;
      } catch (e) {
        last = e;
      }
    }
    throw TransferException(
      'Couldn\'t reach the other device${last is _HttpStatusError && last.status == 403 ? ' (wrong code)' : ''}. '
      'Both devices must be on the same Wi-Fi, or this device must join the other one\'s Personal Hotspot.',
    );
  }

  /// Downloads, verifies and installs the offered trip. Returns the installed trip.
  Future<LocalTrip> receive(
    String host,
    TransferTicket t,
    TransferOffer offer, {
    String? owner,
    TransferProgress? onProgress,
  }) async {
    final trip = offer.trip;
    final id = trip['id'] as String;
    final version = (trip['version'] as num).toInt();
    if (!RegExp(r'^[0-9a-f-]{36}$').hasMatch(id)) {
      throw TransferException('The other device sent an invalid trip.');
    }
    final bundle = offer.files.where((f) => f.kind == 'bundle').firstOrNull;
    if (bundle == null) {
      throw TransferException(
        'The other device didn\'t offer the trip itself.',
      );
    }

    final work = Directory('${store.tripDir(id).path}/.incoming-nearby');
    if (await work.exists()) await work.delete(recursive: true);
    await work.create(recursive: true);
    try {
      final total = max(1, offer.totalBytes);
      var done = 0;
      for (final f in offer.files) {
        final dest = File('${work.path}/${f.name}');
        await _download(
          Uri.parse('http://$host/t/${t.code}/file/${f.name}'),
          dest,
          (n) {
            onProgress?.call(
              ((done + n) / total).clamp(0, 1).toDouble(),
              f.kind == 'bundle' ? 'Trip' : 'Offline map',
            );
          },
        );
        if (await dest.length() != f.bytes ||
            (await sha256.bind(dest.openRead()).first).toString() != f.sha256) {
          throw TransferException(
            'A file was damaged on the way (${f.kind == 'bundle' ? 'trip' : 'map'}). Try again, closer to the other device.',
          );
        }
        done += f.bytes;
      }

      onProgress?.call(1, 'Unpacking');
      final staging = Directory('${work.path}/bundle');
      await unzipBundle(File('${work.path}/${bundle.name}'), staging);
      if (!await File('${staging.path}/index.html').exists() ||
          !await File('${staging.path}/manifest.json').exists()) {
        throw TransferException(
          'The trip from the other device is incomplete.',
        );
      }
      final target = store.versionDir(id, version);
      if (await target.exists()) await target.delete(recursive: true);
      await staging.rename(target.path);

      final tilesDir = store.tilesDir(id);
      await tilesDir.create(recursive: true);
      final tiles = <LocalTiles>[];
      for (final f in offer.files.where((f) => f.kind == 'tiles')) {
        await File('${work.path}/${f.name}')
            .rename('${tilesDir.path}/${f.name}');
        tiles.add(
          LocalTiles(
            areaHash: f.areaHash ?? f.name.split('.').first,
            file: f.name,
            sha256: f.sha256,
            bytes: f.bytes,
            bbox: f.bbox ?? const [],
            maxZoom: f.maxZoom ?? 15,
          ),
        );
      }

      final local = LocalTrip(
        id: id,
        title: trip['title'] as String? ?? 'Trip',
        version: version,
        startDate: trip['start_date'] as String?,
        endDate: trip['end_date'] as String?,
        bundleSha256: bundle.sha256,
        tiles: tiles,
        bytes: offer.totalBytes,
        downloadedAt: DateTime.now(),
        tilesIncluded: trip['tiles_included'] as bool? ?? tiles.isNotEmpty,
        owner: owner,
        accent: trip['accent'] as String?,
        accentDark: trip['accent_dark'] as String?,
        receivedNearby: true,
      );
      await store.saveMeta(local);

      // Older versions and tiles this version doesn't use.
      await for (final d in store.tripDir(id).list()) {
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
    } finally {
      if (await work.exists()) await work.delete(recursive: true);
    }
  }

  Future<List<int>> _get(Uri u) async {
    final req = await _http.getUrl(u);
    final res = await req.close().timeout(const Duration(seconds: 8));
    if (res.statusCode != 200) {
      await res.drain<void>();
      throw _HttpStatusError(res.statusCode);
    }
    return res.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
  }

  Future<void> _download(Uri u, File dest, void Function(int) onBytes) async {
    final req = await _http.getUrl(u);
    final res = await req.close();
    if (res.statusCode != 200) {
      await res.drain<void>();
      throw TransferException(
        'The other device stopped sharing (${res.statusCode}). Ask them to start the handoff again.',
      );
    }
    final sink = dest.openWrite();
    var n = 0;
    try {
      await for (final chunk in res.timeout(const Duration(seconds: 20))) {
        sink.add(chunk);
        n += chunk.length;
        onBytes(n);
      }
    } on TimeoutException {
      throw TransferException(
        'The connection to the other device was lost. Move closer and try again.',
      );
    } finally {
      await sink.close();
    }
  }

  void close() => _http.close(force: true);
}

class _HttpStatusError implements Exception {
  _HttpStatusError(this.status);
  final int status;
}
