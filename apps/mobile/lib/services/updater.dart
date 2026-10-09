import 'dart:io';

import 'package:flutter/services.dart';

/// The Mac app's Sparkle auto-updater (macos/Runner/AppDelegate.swift, WaypackUpdater).
/// Only the direct-download Mac build has it; elsewhere [info] returns null.
class Updater {
  static const _channel = MethodChannel('waypack/updater');

  static bool get supported => Platform.isMacOS;

  /// `{enabled, version, build, automatic, lastCheck (ms since epoch or null)}`, or null.
  static Future<UpdaterInfo?> info() async {
    if (!supported) return null;
    try {
      final m = await _channel.invokeMapMethod<String, Object?>('info');
      return m == null ? null : UpdaterInfo.fromMap(m);
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  static Future<void> setAutomatic(bool on) =>
      _channel.invokeMethod('setAutomatic', on);

  /// Sparkle's own window takes over: "up to date", or the new version with release notes.
  static Future<void> checkNow() => _channel.invokeMethod('check');
}

class UpdaterInfo {
  const UpdaterInfo({
    required this.enabled,
    required this.version,
    required this.build,
    required this.automatic,
    this.lastCheck,
  });

  factory UpdaterInfo.fromMap(Map<String, Object?> m) => UpdaterInfo(
    enabled: m['enabled'] == true,
    version: '${m['version'] ?? ''}',
    build: '${m['build'] ?? ''}',
    automatic: m['automatic'] == true,
    lastCheck: m['lastCheck'] is num
        ? DateTime.fromMillisecondsSinceEpoch((m['lastCheck'] as num).round())
        : null,
  );

  /// False in debug builds, which never update themselves.
  final bool enabled;
  final String version, build;
  final bool automatic;
  final DateTime? lastCheck;
}
