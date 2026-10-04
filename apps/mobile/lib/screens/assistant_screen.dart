import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';

import '../assistant/context.dart';
import '../assistant/engine.dart';
import '../dev_flags.dart';
import '../models/manifest.dart';
import '../state/app_state.dart';

/// "Ask about this trip": an on-device model answers from the downloaded plan, with no signal.
class AssistantScreen extends StatefulWidget {
  const AssistantScreen({super.key, required this.tripId, this.engines});
  final String tripId;

  /// For tests: engines to choose from (defaults to [AssistantEngines.candidates]).
  final List<AssistantEngine>? engines;

  @override
  State<AssistantScreen> createState() => _AssistantScreenState();
}

class _Message {
  _Message(this.question) : error = null, answer = '';
  final String question;
  String answer;
  String? error;
  bool done = false;
}

class _AssistantScreenState extends State<AssistantScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _messages = <_Message>[];
  AssistantEngine? _engine;
  EngineStatus? _status;
  TripBrief? _brief;
  Manifest? _manifest;
  LatLon? _here;
  StreamSubscription<String>? _answering;
  double? _download;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final s = context.read<AppState>();
    final m = await s.manifestFor(widget.tripId);
    final local = s.trip(widget.tripId)?.local;
    if (m == null || local == null) {
      setState(
        () => _loadError = 'This trip isn\'t downloaded on this device.',
      );
      return;
    }
    var guide = '';
    try {
      guide = htmlText(
        await File(
          '${s.store.versionDir(widget.tripId, local.version).path}/index.html',
        ).readAsString(),
      );
    } catch (_) {}
    final (engine, status) = await AssistantEngines.pick(widget.engines);
    if (!mounted) return;
    setState(() {
      _manifest = m;
      _brief = TripBrief(m, guideText: guide);
      _engine = engine;
      _status = status;
    });
    unawaited(_locate());
  }

  /// Last known / current GPS fix, if the user allowed location. Works offline.
  Future<void> _locate() async {
    if (DevFlags.noPermissionPrompts) return;
    try {
      final p = await Geolocator.checkPermission();
      if (p == LocationPermission.denied ||
          p == LocationPermission.deniedForever) {
        return;
      }
      final last = await Geolocator.getLastKnownPosition();
      if (last != null && mounted) {
        setState(() => _here = LatLon(last.latitude, last.longitude));
      }
      final cur = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          timeLimit: Duration(seconds: 8),
        ),
      );
      if (mounted) setState(() => _here = LatLon(cur.latitude, cur.longitude));
    } catch (_) {
      /* answers just won't include distances */
    }
  }

  @override
  void dispose() {
    _answering?.cancel();
    _engine?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  bool get _busy => _answering != null;

  void _ask(String q) {
    final question = q.trim();
    if (question.isEmpty || _busy || _brief == null || _engine == null) return;
    _input.clear();
    final history = _messages
        .where((m) => m.done && m.error == null)
        .map((m) => Turn(m.question, m.answer))
        .toList();
    final msg = _Message(question);
    setState(() => _messages.add(msg));
    final request = _brief!.build(
      question,
      here: _here,
      now: DevFlags.fakeNowTime,
      history: history,
    );
    _answering = _engine!
        .generate(request)
        .listen(
          (text) {
            setState(() => msg.answer = text);
            _toBottom();
          },
          onError: (Object e) => setState(() {
            msg.error = e is AssistantException
                ? switch (e.code) {
                    'context' => 'That question needs more of the trip than fits on-device. Try asking about one day or place.',
                    'guardrail' => 'The on-device model declined to answer that. Try rephrasing.',
                    'locale' =>
                      'The on-device model doesn\'t support this language yet.',
                    'busy' =>
                      'The on-device model is busy. Try again in a moment.',
                    'assets' => 'Apple Intelligence is still getting ready on this device. Try again later (on Wi-Fi and power).',
                    // Never show the system's raw error text.
                    _ => 'The on-device model couldn\'t answer that right now. Try again in a moment.',
                  }
                : '$e';
            msg.done = true;
            _answering = null;
          }),
          onDone: () => setState(() {
            msg.done = true;
            _answering = null;
          }),
          cancelOnError: true,
        );
    _toBottom();
  }

  void _stop() {
    _engine?.cancel();
    _answering?.cancel();
    setState(() {
      if (_messages.isNotEmpty) _messages.last.done = true;
      _answering = null;
    });
  }

  void _toBottom() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (_scroll.hasClients) {
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    }
  });

  Future<void> _downloadModel() async {
    setState(() => _download = 0);
    try {
      await for (final p in _engine!.download()) {
        if (mounted) setState(() => _download = p);
      }
      final s = await _engine!.status();
      if (mounted) setState(() => _status = s);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Couldn\'t download the model: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _download = null);
    }
  }

  List<String> get _suggestions {
    final m = _manifest;
    bool hasCat(String c) => m?.places.any((p) => p.category == c) ?? false;
    return [
      'What\'s next?',
      if (hasCat('fuel')) 'Where\'s the nearest gas?',
      if (hasCat('food')) 'Where can we eat nearby?',
      'What\'s plan B if the weather turns?',
      'What should we pack for today?',
      'Emergency numbers and nearest hospital',
    ];
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final status = _status;
    return Scaffold(
      appBar: AppBar(title: const Text('Ask about this trip')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: _loadError != null
                ? Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(_loadError!),
                  )
                : status == null
                ? const Center(child: CircularProgressIndicator())
                : status.state == EngineState.unavailable
                ? _Unsupported(status: status)
                : status.state != EngineState.available
                ? _NeedsModel(
                    status: status,
                    progress: _download,
                    onDownload: _downloadModel,
                  )
                : Column(
                    children: [
                      Expanded(
                        child: ListView(
                          controller: _scroll,
                          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                          children: [
                            if (_messages.isEmpty) ...[
                              Text(
                                'Ask anything about ${_manifest?.title ?? 'your trip'}. Answers come from your downloaded plan and work with no signal.',
                                style: t.textTheme.bodyLarge,
                              ),
                              const SizedBox(height: 12),
                              Wrap(
                                spacing: 8,
                                runSpacing: 8,
                                children: [
                                  for (final s in _suggestions)
                                    ActionChip(
                                      label: Text(s),
                                      onPressed: () => _ask(s),
                                    ),
                                ],
                              ),
                            ],
                            for (final m in _messages) ...[
                              _Bubble(text: m.question, mine: true),
                              _Bubble(
                                text:
                                    m.error ??
                                    (m.answer.isEmpty ? '…' : m.answer),
                                mine: false,
                                error: m.error != null,
                                thinking:
                                    m.answer.isEmpty &&
                                    m.error == null &&
                                    !m.done,
                              ),
                            ],
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
                        child: Row(
                          children: [
                            Expanded(
                              child: TextField(
                                key: const Key('assistant-input'),
                                controller: _input,
                                textInputAction: TextInputAction.send,
                                onSubmitted: _ask,
                                minLines: 1,
                                maxLines: 4,
                                decoration: const InputDecoration(
                                  hintText: 'Ask about your trip',
                                  border: OutlineInputBorder(),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            _busy
                                ? IconButton.filledTonal(
                                    tooltip: 'Stop',
                                    onPressed: _stop,
                                    icon: const Icon(Icons.stop),
                                  )
                                : IconButton.filled(
                                    tooltip: 'Ask',
                                    onPressed: () => _ask(_input.text),
                                    icon: const Icon(Icons.arrow_upward),
                                  ),
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                        child: Text(
                          '${status.label}${_here == null ? '' : ' · using your location'}. Answers can be wrong: check conditions locally.',
                          textAlign: TextAlign.center,
                          style: t.textTheme.bodySmall?.copyWith(
                            color: t.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({
    required this.text,
    required this.mine,
    this.error = false,
    this.thinking = false,
  });
  final String text;
  final bool mine;
  final bool error;
  final bool thinking;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final bg = mine
        ? t.colorScheme.primary
        : (error
              ? t.colorScheme.errorContainer
              : t.colorScheme.surfaceContainerHighest);
    final fg = mine
        ? t.colorScheme.onPrimary
        : (error ? t.colorScheme.onErrorContainer : t.colorScheme.onSurface);
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: const BoxConstraints(maxWidth: 560),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(16),
        ),
        child: thinking
            ? SizedBox(
                width: 36,
                child: LinearProgressIndicator(
                  minHeight: 3,
                  color: fg,
                  backgroundColor: fg.withValues(alpha: .2),
                ),
              )
            : SelectableText(
                text,
                style: t.textTheme.bodyLarge?.copyWith(color: fg),
              ),
      ),
    );
  }
}

class _Unsupported extends StatelessWidget {
  const _Unsupported({required this.status});
  final EngineStatus status;
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.auto_awesome_outlined,
            size: 48,
            color: t.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: 12),
          Text(
            'Not available on this device yet',
            style: t.textTheme.titleLarge,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            status.explanation,
            style: t.textTheme.bodyLarge,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 12),
          Text(
            'Everything else in Waypack works offline as usual: the plan, the map and Today.',
            style: t.textTheme.bodyMedium?.copyWith(
              color: t.colorScheme.onSurfaceVariant,
            ),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

class _NeedsModel extends StatelessWidget {
  const _NeedsModel({
    required this.status,
    required this.progress,
    required this.onDownload,
  });
  final EngineStatus status;
  final double? progress;
  final VoidCallback onDownload;
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final downloading =
        progress != null || status.state == EngineState.downloading;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.download_for_offline_outlined,
            size: 48,
            color: t.colorScheme.primary,
          ),
          const SizedBox(height: 12),
          Text('Get the offline assistant', style: t.textTheme.titleLarge),
          const SizedBox(height: 8),
          Text(
            'Your phone can answer questions about your trip with no signal, using ${status.label.split(',').first}. '
            'It needs a one-time model download (do it on Wi-Fi, before you go).',
            textAlign: TextAlign.center,
            style: t.textTheme.bodyLarge,
          ),
          const SizedBox(height: 16),
          if (downloading) ...[
            LinearProgressIndicator(
              value: (progress ?? -1) >= 0 ? progress : null,
            ),
            const SizedBox(height: 6),
            Text(
              progress != null && progress! >= 0
                  ? 'Downloading… ${(progress! * 100).round()}%'
                  : 'Downloading…',
            ),
          ] else
            FilledButton.icon(
              onPressed: onDownload,
              icon: const Icon(Icons.download),
              label: const Text('Download model'),
            ),
        ],
      ),
    );
  }
}
