import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

import '../config.dart';
import '../models/trip.dart';

class ApiException implements Exception {
  ApiException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

/// Client for the Waypack Worker's app API (services/mcp/src/api.ts).
class Api {
  Api({http.Client? client}) : _http = client ?? http.Client();
  final http.Client _http;

  Map<String, String> get _headers {
    final token = Supabase.instance.client.auth.currentSession?.accessToken;
    return {
      if (token != null) 'Authorization': 'Bearer $token',
      'Accept': 'application/json',
    };
  }

  Future<Map<String, dynamic>> _json(
    String method,
    String path, {
    Object? body,
  }) async {
    final uri = Uri.parse('${Config.apiUrl}$path');
    final req = http.Request(method, uri)..headers.addAll(_headers);
    if (body != null) {
      req.headers['Content-Type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    final res = await http.Response.fromStream(
      await _http.send(req).timeout(const Duration(seconds: 30)),
    );
    final j = res.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      throw ApiException(
        res.statusCode,
        j['error'] as String? ?? 'Request failed (${res.statusCode})',
      );
    }
    return j;
  }

  Future<List<RemoteTrip>> trips() async {
    final j = await _json('GET', '/api/trips');
    return (j['trips'] as List)
        .map((t) => RemoteTrip.fromJson(t as Map<String, dynamic>))
        .toList();
  }

  Future<DownloadInfo> downloadInfo(String tripId) async =>
      DownloadInfo(await _json('GET', '/api/trips/$tripId/download'));

  Future<Map<String, dynamic>> me() => _json('GET', '/api/me');

  /// The trip's companion invite link (created on first use).
  Future<String> inviteLink(String tripId) async =>
      (await _json('POST', '/api/trips/$tripId/invite'))['invite_url']
          as String;

  Future<List<Map<String, dynamic>>> tokens() async =>
      ((await _json('GET', '/api/tokens'))['tokens'] as List)
          .cast<Map<String, dynamic>>();
  Future<Map<String, dynamic>> createToken(String label) =>
      _json('POST', '/api/tokens', body: {'label': label});
  Future<void> revokeToken(String id) => _json('DELETE', '/api/tokens/$id');
  Future<void> deleteAccount() => _json('DELETE', '/api/account');
}

class DownloadInfo {
  DownloadInfo(this.raw);
  final Map<String, dynamic> raw;
  String get tripId => raw['trip_id'] as String;
  String get title => raw['title'] as String;
  int get version => (raw['version'] as num).toInt();
  String? get startDate => raw['start_date'] as String?;
  String? get endDate => raw['end_date'] as String?;
  String get bundleUrl => (raw['bundle'] as Map)['url'] as String;
  String get bundleSha256 => (raw['bundle'] as Map)['sha256'] as String;
  int get bundleBytes => ((raw['bundle'] as Map)['bytes'] as num).toInt();
  String get tilesStatus => raw['tiles_status'] as String;
  String? get onlineTilesUrl => raw['online_tiles_url'] as String?;
  List<Map<String, dynamic>> get tiles =>
      (raw['tiles'] as List).cast<Map<String, dynamic>>();
  int get totalBytes =>
      bundleBytes +
      tiles.fold<int>(0, (n, t) => n + ((t['bytes'] as num?)?.toInt() ?? 0));
}
