import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/manifest.dart';
import '../models/trip.dart';
import '../services/api.dart';
import '../services/downloader.dart';
import '../services/local_server.dart';
import '../services/notifications.dart';
import '../services/trip_store.dart';

class TripEntry {
  TripEntry({this.remote, this.local});
  RemoteTrip? remote;
  LocalTrip? local;

  String get id => remote?.id ?? local!.id;
  String get title => remote?.title ?? local!.title;
  String? get startDate => remote?.startDate ?? local?.startDate;
  String? get endDate => remote?.endDate ?? local?.endDate;
  bool get isOffline => local != null;
  bool get updateAvailable =>
      remote != null &&
      local != null &&
      remote!.version > local!.version &&
      remote!.status == 'ready';
  bool get isPast {
    final end = endDate;
    if (end == null) return false;
    return end.compareTo(DateTime.now().toIso8601String().substring(0, 10)) < 0;
  }
}

class AppState extends ChangeNotifier {
  AppState({required this.store, required this.server, required this.api})
    : downloader = TripDownloader(api, store);

  final TripStore store;
  final LocalServer server;
  final Api api;
  final TripDownloader downloader;

  final Map<String, TripEntry> _trips = {};
  final Map<String, double> progress = {};
  final Map<String, String> progressStage = {};
  final Map<String, String> errors = {};
  bool loading = false;
  String? listError;
  DateTime? lastSynced;
  Map<String, dynamic>? me;

  Session? get session => Supabase.instance.client.auth.currentSession;
  User? get user => Supabase.instance.client.auth.currentUser;

  List<TripEntry> get upcoming =>
      _sorted(_trips.values.where((t) => !t.isPast), asc: true);
  List<TripEntry> get past =>
      _sorted(_trips.values.where((t) => t.isPast), asc: false);
  TripEntry? trip(String id) => _trips[id];

  List<TripEntry> _sorted(Iterable<TripEntry> it, {required bool asc}) {
    final l = it.toList()
      ..sort(
        (a, b) => (a.startDate ?? '9999').compareTo(b.startDate ?? '9999'),
      );
    return asc ? l : l.reversed.toList();
  }

  /// Loads what's on the device first (works offline), then refreshes from the server.
  Future<void> init() async {
    _trips.clear();
    final locals = await store.loadAll();
    for (final l in locals.values) {
      if (l.owner != null && l.owner != user?.id) continue;
      _trips[l.id] = TripEntry(local: l);
      _register(l);
    }
    await _loadCachedRemote();
    notifyListeners();
    if (session != null) unawaited(refresh());
  }

  /// A trip copied from a nearby device (offline handoff) is now on this device.
  void adoptLocal(LocalTrip l) {
    (_trips[l.id] ??= TripEntry()).local = l;
    _register(l);
    notifyListeners();
  }

  void _register(LocalTrip l) {
    server.versions[l.id] = l.version;
    server.tiles[l.id] = l.tiles.map((t) => t.file).toList();
  }

  Future<void> _loadCachedRemote() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('remote_trips');
    if (raw == null) return;
    try {
      for (final j in (jsonDecode(raw) as List).cast<Map<String, dynamic>>()) {
        final r = RemoteTrip.fromJson(j);
        (_trips[r.id] ??= TripEntry()).remote = r;
      }
      lastSynced = DateTime.tryParse(prefs.getString('remote_synced') ?? '');
    } catch (_) {}
  }

  Future<void> refresh() async {
    if (session == null) return;
    loading = true;
    listError = null;
    notifyListeners();
    try {
      final remote = await api.trips();
      final ids = remote.map((r) => r.id).toSet();
      // Trips deleted on the server disappear unless they're still on this device.
      _trips.removeWhere((id, e) => !ids.contains(id) && e.local == null);
      for (final e in _trips.values) {
        if (!ids.contains(e.id)) e.remote = null;
      }
      for (final r in remote) {
        (_trips[r.id] ??= TripEntry()).remote = r;
      }
      lastSynced = DateTime.now();
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        'remote_trips',
        jsonEncode(remote.map((r) => r.toJson()).toList()),
      );
      await prefs.setString('remote_synced', lastSynced!.toIso8601String());
      for (final e in _trips.values) {
        await Reminders.sync(
          tripId: e.id,
          title: e.title,
          startDate: e.startDate,
          downloaded: e.isOffline && !e.updateAvailable,
        );
      }
      me = await api.me().catchError((_) => <String, dynamic>{});
    } on SocketException {
      listError = 'Offline — showing trips saved on this device.';
    } catch (e) {
      listError = e is ApiException && e.status == 401
          ? 'Session expired — sign in again.'
          : 'Couldn\'t refresh: $e';
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  bool isDownloading(String id) => progress.containsKey(id);

  Future<void> download(String id) async {
    if (isDownloading(id)) return;
    errors.remove(id);
    progress[id] = 0;
    progressStage[id] = 'Starting';
    notifyListeners();
    try {
      final existing = _trips[id]?.local;
      final local = await downloader.download(
        id,
        owner: user?.id,
        existing: existing,
        onProgress: (f, stage) {
          progress[id] = f;
          progressStage[id] = stage;
          notifyListeners();
        },
      );
      (_trips[id] ??= TripEntry()).local = local;
      _register(local);
      await Reminders.sync(
        tripId: id,
        title: local.title,
        startDate: local.startDate,
        downloaded: true,
      );
    } catch (e) {
      errors[id] = e.toString();
    } finally {
      progress.remove(id);
      progressStage.remove(id);
      notifyListeners();
    }
  }

  Future<void> deleteLocal(String id) async {
    await store.deleteLocal(id);
    server.versions.remove(id);
    server.tiles.remove(id);
    final e = _trips[id];
    if (e != null) {
      e.local = null;
      if (e.remote == null) _trips.remove(id);
      await Reminders.sync(
        tripId: id,
        title: e.title,
        startDate: e.startDate,
        downloaded: false,
      );
    }
    notifyListeners();
  }

  Future<Manifest?> manifestFor(String id) async {
    final l = _trips[id]?.local;
    if (l == null) return null;
    final f = File('${store.versionDir(id, l.version).path}/manifest.json');
    if (!await f.exists()) return null;
    return Manifest(jsonDecode(await f.readAsString()) as Map<String, dynamic>);
  }

  Future<void> signOut() async {
    await Supabase.instance.client.auth.signOut();
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('remote_trips');
    // Downloaded trips stay on the device but are hidden until the same account signs in.
    _trips.clear();
    server.versions.clear();
    server.tiles.clear();
    notifyListeners();
  }

  void onSignedIn() => unawaited(init());
}
