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
import '../widgets/scrapbook.dart';

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
    final brief = _brief!;
    final here = _here;
    final request = brief.build(
      question,
      here: here,
      now: DevFlags.fakeNowTime,
      history: history,
      toolAvailable: _status?.tools ?? false,
    );
    _answering = _engine!
        .generate(request, search: (q) async => brief.toolResult(q, here: here))
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
    final p = Paper.of(context);
    final status = _status;
    return KraftScaffold(
      title: 'Ask',
      subtitle: _manifest == null
          ? 'Works with no signal'
          : '${_manifest!.title} · works with no signal',
      maxWidth: 760,
      body: _loadError != null
          ? Padding(
              padding: const EdgeInsets.all(24),
              child: Align(
                alignment: Alignment.topCenter,
                child: StickyNote(child: Text(_loadError!)),
              ),
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
                    padding: const EdgeInsets.fromLTRB(18, 8, 18, 12),
                    children: [
                      if (_messages.isEmpty) ...[
                        Padding(
                          padding: const EdgeInsets.fromLTRB(2, 4, 2, 16),
                          child: Text(
                            'Ask anything about ${_manifest?.title ?? 'your trip'}. Answers come from your downloaded plan and work with no signal.',
                            style: TextStyle(
                              fontSize: 15,
                              height: 1.45,
                              color: p.ink,
                            ),
                          ),
                        ),
                        Wrap(
                          spacing: 6,
                          runSpacing: 10,
                          children: [
                            for (final (i, q) in _suggestions.indexed)
                              _WashiChip(
                                label: q,
                                color: Paper.tapes[i % Paper.tapes.length],
                                onTap: () => _ask(q),
                              ),
                          ],
                        ),
                      ],
                      for (final m in _messages) ...[
                        _Bubble(text: m.question, mine: true),
                        _Bubble(
                          text: m.error ?? (m.answer.isEmpty ? '…' : m.answer),
                          mine: false,
                          error: m.error != null,
                          thinking:
                              m.answer.isEmpty && m.error == null && !m.done,
                        ),
                      ],
                    ],
                  ),
                ),
                SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
                    child: Column(
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: TextField(
                                key: const Key('assistant-input'),
                                controller: _input,
                                textInputAction: TextInputAction.send,
                                onSubmitted: _ask,
                                minLines: 1,
                                maxLines: 4,
                                decoration: InputDecoration(
                                  hintText: 'Ask about your trip…',
                                  contentPadding: const EdgeInsets.symmetric(
                                    horizontal: 18,
                                    vertical: 13,
                                  ),
                                  border: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(24),
                                    borderSide: BorderSide.none,
                                  ),
                                  enabledBorder: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(24),
                                    borderSide: BorderSide.none,
                                  ),
                                  focusedBorder: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(24),
                                    borderSide: BorderSide(
                                      color: p.accent,
                                      width: 2,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 10),
                            _busy
                                ? RoundButton(
                                    tooltip: 'Stop',
                                    icon: Icons.stop,
                                    size: 48,
                                    onPressed: _stop,
                                  )
                                : RoundButton(
                                    tooltip: 'Ask',
                                    icon: Icons.arrow_upward,
                                    size: 48,
                                    accent: true,
                                    onPressed: () => _ask(_input.text),
                                  ),
                          ],
                        ),
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            '${status.label}${_here == null ? '' : ' · using your location'}. Answers can be wrong: check conditions locally.',
                            textAlign: TextAlign.center,
                            style: TextStyle(fontSize: 11.5, color: p.muted),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}

/// A suggested question on a strip of washi tape.
class _WashiChip extends StatelessWidget {
  const _WashiChip({
    required this.label,
    required this.color,
    required this.onTap,
  });
  final String label;
  final Color color;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    child: GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          color: Color.lerp(color, Colors.white, .35),
          borderRadius: BorderRadius.circular(2),
          boxShadow: const [
            BoxShadow(
              color: Color(0x243C2814),
              blurRadius: 2,
              offset: Offset(0, 1),
            ),
          ],
        ),
        child: Text(
          label,
          style: const TextStyle(
            fontSize: 13.5,
            fontWeight: FontWeight.w600,
            color: Paper.captionInk,
          ),
        ),
      ),
    ),
  );
}

/// Questions are yellow sticky notes on the right; answers are paper cards on the left.
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
    final p = Paper.of(context);
    if (mine) {
      return Align(
        alignment: Alignment.centerRight,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(52, 10, 0, 6),
            child: StickyNote(
              tilt: 1.2,
              child: SelectableText(
                text,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: Paper.captionInk,
                ),
              ),
            ),
          ),
        ),
      );
    }
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.fromLTRB(0, 6, 28, 6),
        padding: const EdgeInsets.fromLTRB(15, 12, 15, 13),
        constraints: const BoxConstraints(maxWidth: 560),
        decoration: BoxDecoration(
          color: p.card,
          borderRadius: BorderRadius.circular(6),
          boxShadow: const [
            BoxShadow(
              color: Color(0x243C2814),
              blurRadius: 2,
              offset: Offset(0, 1),
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  error ? Icons.error_outline : Icons.auto_awesome,
                  size: 12,
                  color: error ? p.err : p.accent,
                ),
                const SizedBox(width: 5),
                Text(
                  error ? 'Couldn\'t answer' : 'From your plan · offline',
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w800,
                    letterSpacing: .6,
                    color: error ? p.err : p.accent,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 5),
            thinking
                ? SizedBox(
                    width: 44,
                    child: LinearProgressIndicator(
                      minHeight: 3,
                      color: p.accent,
                      backgroundColor: p.accent.withValues(alpha: .2),
                    ),
                  )
                : SelectableText(
                    text,
                    style: TextStyle(
                      fontSize: 14.5,
                      height: 1.5,
                      color: error ? p.err : p.ink,
                    ),
                  ),
          ],
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
    final p = Paper.of(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(26, 40, 26, 24),
      children: [
        StickyNote(
          tilt: -1,
          tape: 1,
          padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Not available on this device yet',
                style: hand(30, Paper.captionInk),
              ),
              const SizedBox(height: 10),
              Text(
                status.explanation,
                style: const TextStyle(fontSize: 14.5, height: 1.5),
              ),
            ],
          ),
        ),
        const SizedBox(height: 22),
        Text(
          'Everything else in Waypack works offline as usual: the plan, the map and Today.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, color: p.muted),
        ),
      ],
    );
  }
}

/// "Packing note": downloading the on-device model is a before-you-go chore.
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
    final p = Paper.of(context);
    final downloading =
        progress != null || status.state == EngineState.downloading;
    final engine = status.label.split(',').first;
    Widget check(String text, bool done) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Container(
            width: 18,
            height: 18,
            decoration: BoxDecoration(
              border: Border.all(color: Paper.captionMuted, width: 2),
              borderRadius: BorderRadius.circular(4),
            ),
            child: done ? Icon(Icons.check, size: 13, color: p.ok) : null,
          ),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 13.5))),
        ],
      ),
    );
    return ListView(
      padding: const EdgeInsets.fromLTRB(26, 36, 26, 24),
      children: [
        PaperObject(
          tilt: -1.2,
          tape: 1,
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 22),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const IconChip(
                icon: Icons.auto_awesome_outlined,
                color: ChipColor.lilac,
                size: 44,
              ),
              const SizedBox(height: 12),
              Text('Before you go…', style: hand(34, Paper.captionInk)),
              const SizedBox(height: 8),
              Text(
                'Your phone can answer questions about your trip with no signal, using $engine.',
                style: const TextStyle(fontSize: 14, height: 1.5),
              ),
              const SizedBox(height: 10),
              check(
                'One-time download${status.bytes == null ? '' : ', about ${_size(status.bytes!)}'}',
                downloading,
              ),
              check('Best on Wi-Fi and power', downloading),
              check('Then it works anywhere, offline', false),
              const SizedBox(height: 16),
              if (downloading) ...[
                PaperProgress(
                  value: (progress ?? -1) >= 0 ? progress : null,
                  track: const Color(0x1A3D332B),
                ),
                const SizedBox(height: 6),
                Text(
                  progress != null && progress! >= 0
                      ? 'Downloading… ${(progress! * 100).round()}%'
                      : 'Downloading…',
                  style: const TextStyle(
                    fontSize: 12,
                    color: Paper.captionMuted,
                  ),
                ),
              ] else
                PaperButton(
                  expand: true,
                  icon: Icons.download,
                  label: 'Download model',
                  onPressed: onDownload,
                ),
            ],
          ),
        ),
        const SizedBox(height: 22),
        Text(
          'Everything else works offline as usual: the plan, the map and Today.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12.5, color: p.muted),
        ),
      ],
    );
  }
}

String _size(int bytes) => bytes >= 1e9
    ? '${(bytes / 1e9).toStringAsFixed(1)} GB'
    : '${(bytes / 1e6).round()} MB';
