import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// On-device language models behind one interface (DECISIONS #49).
///
/// Today: Apple Foundation Models (iOS/iPadOS/macOS 26+ with Apple Intelligence) and Gemini Nano
/// (Android, via ML Kit's Prompt API / AICore) through [NativeAssistantEngine]. Devices with
/// neither get [UnsupportedEngine]. A downloadable open model (e.g. Qwen on LiteRT-LM) can be
/// added later as another [AssistantEngine] in [AssistantEngines.candidates]; nothing else changes:
/// the trip context, prompts and UI are engine-independent.

enum EngineState { available, downloadable, downloading, unavailable }

class EngineStatus {
  const EngineStatus({required this.engine, required this.state, this.reason});
  final String
  engine; // apple-foundation | gemini-nano | none | (later) litert-qwen
  final EngineState state;
  final String? reason;

  factory EngineStatus.fromMap(Map m) => EngineStatus(
    engine: m['engine'] as String? ?? 'none',
    state: switch (m['state']) {
      'available' => EngineState.available,
      'downloadable' => EngineState.downloadable,
      'downloading' => EngineState.downloading,
      _ => EngineState.unavailable,
    },
    reason: m['reason'] as String?,
  );

  /// Who runs the model, for the screen's footer.
  String get label => switch (engine) {
    'apple-foundation' => 'Apple Intelligence, on this device',
    'gemini-nano' => 'Gemini Nano, on this device',
    _ => 'On-device AI',
  };

  /// Why it can't run, in words a traveler understands.
  String get explanation => switch (reason) {
    'appleIntelligenceNotEnabled' => 'Turn on Apple Intelligence in Settings to ask questions about your trip offline.',
    'modelNotReady' => 'Apple Intelligence is still downloading its model. Try again in a little while (on Wi-Fi and power).',
    'deviceNotEligible' => 'This device doesn\'t support Apple Intelligence, so the offline assistant isn\'t available here yet.',
    'osTooOld' =>
      engine == 'apple-foundation'
          ? 'The offline assistant needs iOS 26 or macOS 26 or later.'
          : 'The offline assistant needs a newer system version.',
    'aicoreUnavailable' || 'unsupportedDevice' => 'This phone doesn\'t support Gemini Nano, so the offline assistant isn\'t available here yet.',
    'noEngine' =>
      'This device doesn\'t have an on-device AI model Waypack can use yet.',
    _ => 'The offline assistant isn\'t available on this device yet.',
  };
}

class AssistantRequest {
  const AssistantRequest({
    required this.instructions,
    required this.prompt,
    this.temperature = 0.3,
    this.maxTokens = 350,
  });
  final String instructions;
  final String prompt;
  final double temperature;
  final int maxTokens;
}

class AssistantException implements Exception {
  AssistantException(this.code, this.message);
  final String code; // context | guardrail | locale | busy | failed
  final String message;
  @override
  String toString() => message;
}

abstract class AssistantEngine {
  Future<EngineStatus> status();

  /// Fetches the model if [status] says downloadable. Emits progress 0..1 (or -1 if unknown).
  Stream<double> download();

  /// Streams the answer as it grows: every event is the full text so far.
  Stream<String> generate(AssistantRequest request);

  Future<void> cancel();
}

/// Apple Foundation Models (iOS/macOS) or Gemini Nano (Android), implemented in
/// ios/Runner/AppDelegate.swift, macos/Runner/MainFlutterWindow.swift and
/// android/.../MainActivity.kt with the same channel protocol.
class NativeAssistantEngine implements AssistantEngine {
  NativeAssistantEngine({MethodChannel? methods, EventChannel? events})
    : _methods = methods ?? const MethodChannel('waypack/assistant'),
      _events = events ?? const EventChannel('waypack/assistant/events');

  final MethodChannel _methods;
  final EventChannel _events;
  Stream<Map>? _stream;
  int _seq = 0;
  String? _current;

  Stream<Map> get _all => _stream ??= _events
      .receiveBroadcastStream()
      .map((e) => (e as Map).cast<String, dynamic>())
      .asBroadcastStream();

  @override
  Future<EngineStatus> status() async {
    try {
      final m = await _methods.invokeMethod<Map>('status');
      return EngineStatus.fromMap(m ?? const {});
    } on MissingPluginException {
      return const EngineStatus(
        engine: 'none',
        state: EngineState.unavailable,
        reason: 'noEngine',
      );
    } on PlatformException catch (e) {
      return EngineStatus(
        engine: 'none',
        state: EngineState.unavailable,
        reason: e.code,
      );
    }
  }

  @override
  Stream<double> download() async* {
    // Subscribe before starting so no progress event is missed.
    final controller = StreamController<double>();
    final sub = _all.where((e) => e['type'] == 'download').listen((e) {
      if (e['error'] != null) {
        controller.addError(AssistantException('failed', '${e['error']}'));
        controller.close();
        return;
      }
      final total = (e['total'] as num?)?.toDouble() ?? 0;
      final bytes = (e['bytes'] as num?)?.toDouble() ?? 0;
      controller.add(total > 0 ? (bytes / total).clamp(0, 1).toDouble() : -1);
      if (e['done'] == true) controller.close();
    });
    await _methods.invokeMethod<void>('download');
    try {
      yield* controller.stream;
    } finally {
      await sub.cancel();
    }
  }

  @override
  Stream<String> generate(AssistantRequest r) async* {
    final id = 'q${++_seq}';
    _current = id;
    final events = _all.where((e) => e['id'] == id);
    final controller = StreamController<String>();
    final sub = events.listen((e) {
      switch (e['type']) {
        case 'text':
          controller.add(e['text'] as String? ?? '');
        case 'done':
          final t = e['text'] as String?;
          if (t != null) controller.add(t);
          controller.close();
        case 'error':
          // The system's raw error is for logs only; the screen shows a plain explanation.
          if (kDebugMode && e['detail'] != null) {
            debugPrint('assistant error ${e['code']}: ${e['detail']}');
          }
          controller.addError(
            AssistantException(
              e['code'] as String? ?? 'failed',
              e['message'] as String? ?? 'The assistant stopped.',
            ),
          );
          controller.close();
      }
    });
    await _methods.invokeMethod<void>('generate', {
      'id': id,
      'instructions': r.instructions,
      'prompt': r.prompt,
      'temperature': r.temperature,
      'maxTokens': r.maxTokens,
    });
    try {
      yield* controller.stream;
    } finally {
      await sub.cancel();
      if (_current == id) _current = null;
    }
  }

  @override
  Future<void> cancel() async {
    final id = _current;
    if (id != null) await _methods.invokeMethod<void>('cancel', {'id': id});
  }
}

/// Phones with neither Apple Intelligence nor Gemini Nano (for now).
class UnsupportedEngine implements AssistantEngine {
  const UnsupportedEngine([
    this.why = const EngineStatus(
      engine: 'none',
      state: EngineState.unavailable,
      reason: 'noEngine',
    ),
  ]);
  final EngineStatus why;
  @override
  Future<EngineStatus> status() async => why;
  @override
  Stream<double> download() => const Stream.empty();
  @override
  Stream<String> generate(AssistantRequest request) =>
      Stream.error(AssistantException('unavailable', why.explanation));
  @override
  Future<void> cancel() async {}
}

class AssistantEngines {
  /// In order of preference. Add a downloadable model (LiteRT-LM + Qwen) here later.
  static List<AssistantEngine> candidates() => [NativeAssistantEngine()];

  /// The first engine that is (or can become) usable; otherwise [UnsupportedEngine] carrying the
  /// most helpful reason (e.g. "turn on Apple Intelligence" beats "no engine").
  static Future<(AssistantEngine, EngineStatus)> pick([
    List<AssistantEngine>? engines,
  ]) async {
    EngineStatus? best;
    for (final e in engines ?? candidates()) {
      final s = await e.status();
      if (s.state != EngineState.unavailable) return (e, s);
      if (best == null || (best.engine == 'none' && s.engine != 'none')) {
        best = s;
      }
    }
    final why =
        best ??
        const EngineStatus(
          engine: 'none',
          state: EngineState.unavailable,
          reason: 'noEngine',
        );
    return (UnsupportedEngine(why), why);
  }
}
