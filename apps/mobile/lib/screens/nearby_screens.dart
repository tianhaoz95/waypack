import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../dev_flags.dart';
import '../services/transfer.dart';
import '../state/app_state.dart';
import '../util/colors.dart';
import '../util/format.dart';
import '../widgets/scrapbook.dart';
import 'trip_screen.dart';

const _howTo =
    'Both devices on the same Wi-Fi, or the other phone joins this phone\'s Personal Hotspot. '
    'A hotspot works with no signal at all; turn it on in Settings.';

/// Sender: shows a QR code (and a typed fallback) while serving the trip to nearby devices.
class HandoffSendScreen extends StatefulWidget {
  const HandoffSendScreen({super.key, required this.tripId});
  final String tripId;

  @override
  State<HandoffSendScreen> createState() => _HandoffSendScreenState();
}

class _HandoffSendScreenState extends State<HandoffSendScreen> {
  TransferServer? _server;
  StreamSubscription<TransferStatus>? _sub;
  String? _error;
  double? _sending;
  int _sent = 0;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    final s = context.read<AppState>();
    await _stop();
    setState(() {
      _error = null;
      _sending = null;
    });
    final local = s.trip(widget.tripId)?.local;
    if (local == null) {
      setState(() => _error = 'This trip isn\'t downloaded on this device.');
      return;
    }
    try {
      final server = await TransferServer.start(s.store, local);
      if (!mounted) {
        await server.stop();
        return;
      }
      _sub = server.status.listen((st) {
        if (!mounted) return;
        setState(() {
          _sent = st.completed;
          _sending =
              st.sent >= st.bytes && st.file == server.offer.files.last.name
              ? null
              : st.sent / st.bytes;
        });
      });
      setState(() => _server = server);
    } catch (e) {
      setState(() => _error = 'Couldn\'t start the handoff: $e');
    }
  }

  Future<void> _stop() async {
    await _sub?.cancel();
    await _server?.stop();
    _server = null;
  }

  @override
  void dispose() {
    _stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    final server = _server;
    final noNetwork = server != null && server.ticket.hosts.isEmpty;
    final note = TextStyle(fontSize: 12, height: 1.45, color: p.muted);
    return KraftScaffold(
      title: 'Hand off',
      subtitle: server == null
          ? 'To a nearby phone, no signal needed'
          : '${server.offer.title} · ${formatBytes(server.offer.totalBytes)} · ${server.offer.files.any((f) => f.kind == 'tiles') ? 'plan + offline map' : 'plan only'}',
      maxWidth: 520,
      body: ListView(
        padding: const EdgeInsets.fromLTRB(0, 8, 0, 40),
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 22),
              child: StickyNote(color: Paper.stickyPink, child: Text(_error!)),
            ),
          if (server == null && _error == null)
            const Center(
              child: Padding(
                padding: EdgeInsets.all(48),
                child: CircularProgressIndicator(),
              ),
            ),
          if (server != null) ...[
            if (noNetwork)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 22),
                child: StickyNote(
                  tape: 0,
                  padding: const EdgeInsets.fromLTRB(18, 20, 18, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'This device isn\'t on a Wi-Fi network or hotspot.',
                        style: hand(26, Paper.captionInk),
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'Turn on Personal Hotspot (it works without signal), ask the other phone to join it, then tap Try again.',
                        style: TextStyle(fontSize: 14, height: 1.45),
                      ),
                      const SizedBox(height: 14),
                      PaperButton(label: 'Try again', onPressed: _start),
                    ],
                  ),
                ),
              )
            else ...[
              // The QR code is a taped polaroid; the typed fallback is its caption.
              Center(
                child: SizedBox(
                  width: 280,
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      PaperObject(
                        tilt: -1.2,
                        tape: 0,
                        padding: const EdgeInsets.fromLTRB(14, 14, 14, 16),
                        child: Column(
                          children: [
                            QrImageView(
                              data: server.ticket.toUri(),
                              size: 240,
                              backgroundColor: Colors.white,
                              semanticsLabel: 'Handoff QR code',
                            ),
                            const SizedBox(height: 8),
                            Text(
                              server.offer.title,
                              textAlign: TextAlign.center,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: hand(26, Paper.captionInk),
                            ),
                            const SizedBox(height: 6),
                            SelectableText(
                              '${server.ticket.hosts.first}\ncode ${formatCode(server.ticket.code)}',
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontFamily: 'monospace',
                                fontFamilyFallback: ['Menlo', 'Courier'],
                                fontSize: 14,
                                height: 1.4,
                                color: Paper.captionInk,
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (_sent > 0 && _sending == null)
                        Positioned(
                          right: -10,
                          top: -14,
                          child: Stamp(
                            label:
                                'Sent to $_sent device${_sent == 1 ? '' : 's'}',
                            color: Paper.light.ok,
                            icon: Icons.check,
                            angle: 8,
                            background: Paper.lightPaper,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 22),
              if (_sending != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(22, 0, 22, 18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Sending… ${(_sending! * 100).round()}%',
                        style: hand(22, p.ink),
                      ),
                      const SizedBox(height: 6),
                      PaperProgress(value: _sending),
                    ],
                  ),
                ),
              PaperCard(
                children: [
                  for (final (i, step) in const [
                    'On the other phone, open Waypack',
                    'Tap the scan button on Our trips',
                    'Point it at this code',
                  ].indexed)
                    PaperRow(
                      title: step,
                      trailing: null,
                      icon: [
                        Icons.looks_one_outlined,
                        Icons.looks_two_outlined,
                        Icons.looks_3_outlined,
                      ][i],
                      chip: [
                        ChipColor.yellow,
                        ChipColor.mint,
                        ChipColor.pink,
                      ][i],
                    ),
                ],
              ),
              if (_sent > 0)
                Padding(
                  padding: const EdgeInsets.fromLTRB(26, 12, 26, 0),
                  child: Text(
                    'Another phone can scan the same code while this screen is open.',
                    textAlign: TextAlign.center,
                    style: note,
                  ),
                ),
            ],
            Padding(
              padding: const EdgeInsets.fromLTRB(26, 16, 26, 0),
              child: Text(_howTo, textAlign: TextAlign.center, style: note),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(26, 6, 26, 0),
              child: Text(
                'Sharing stops when you leave this screen (or after 15 minutes).',
                textAlign: TextAlign.center,
                style: note,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Receiver: scan the sender's QR code (or type its address and code), then copy the trip.
class ReceiveNearbyScreen extends StatefulWidget {
  const ReceiveNearbyScreen({super.key});

  @override
  State<ReceiveNearbyScreen> createState() => _ReceiveNearbyScreenState();
}

class _ReceiveNearbyScreenState extends State<ReceiveNearbyScreen> {
  final _address = TextEditingController();
  final _code = TextEditingController();
  TransferClient? _client;
  TransferTicket? _ticket;
  String? _host;
  TransferOffer? _offer;
  String? _error;
  bool _busy = false;
  double? _progress;
  String _stage = '';
  bool _done = false;

  bool get _canScan =>
      (Platform.isIOS || Platform.isAndroid) && !DevFlags.noPermissionPrompts;

  @override
  void dispose() {
    _client?.close();
    _address.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _connect(TransferTicket ticket) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    _client?.close();
    final client = _client = TransferClient(context.read<AppState>().store);
    try {
      final (host, offer) = await client.connect(ticket);
      setState(() {
        _ticket = ticket;
        _host = host;
        _offer = offer;
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _receive() async {
    final s = context.read<AppState>();
    setState(() {
      _busy = true;
      _error = null;
      _progress = 0;
    });
    try {
      final local = await _client!.receive(
        _host!,
        _ticket!,
        _offer!,
        owner: s.user?.id,
        onProgress: (p, stage) {
          if (mounted) {
            setState(() {
              _progress = p;
              _stage = stage;
            });
          }
        },
      );
      s.adoptLocal(local);
      setState(() => _done = true);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    final s = context.watch<AppState>();
    final offer = _offer;
    final existing = offer == null
        ? null
        : s.trip(offer.trip['id'] as String)?.local;
    final accent = offer == null
        ? p.accent
        : (hexColor(offer.trip['accent'] as String?) ??
              fallbackAccent(offer.trip['id'] as String));

    // The incoming trip as a polaroid, before and after receiving it.
    Widget polaroid(TransferOffer offer, {bool received = false}) => Center(
      child: SizedBox(
        width: 250,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            PaperObject(
              tilt: -1.6,
              tape: 0,
              padding: const EdgeInsets.fromLTRB(10, 10, 10, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  AspectRatio(
                    aspectRatio: 1 / .8,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(1),
                      child: CustomPaint(
                        painter: ScenePainter(
                          accent,
                          (offer.trip['id'] as String).hashCode,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(offer.title, style: hand(28, Paper.captionInk)),
                  const SizedBox(height: 4),
                  Text(
                    [
                      dateRange(
                        offer.trip['start_date'] as String?,
                        offer.trip['end_date'] as String?,
                      ),
                      formatBytes(offer.totalBytes),
                      offer.files.any((f) => f.kind == 'tiles')
                          ? 'with offline map'
                          : 'no offline map',
                    ].where((x) => x.isNotEmpty).join(' · '),
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: Paper.captionMuted,
                    ),
                  ),
                ],
              ),
            ),
            if (received)
              Positioned(
                right: -14,
                top: 26,
                child: Stamp(
                  label: 'Received',
                  icon: Icons.check,
                  color: Paper.light.ok,
                  angle: 12,
                  fontSize: 14,
                  background: Paper.lightPaper,
                ),
              ),
          ],
        ),
      ),
    );

    return KraftScaffold(
      title: 'Receive a trip',
      subtitle: 'From a nearby phone, no signal needed',
      maxWidth: 520,
      body: ListView(
        padding: const EdgeInsets.fromLTRB(0, 8, 0, 40),
        children: [
          if (offer == null) ...[
            if (_canScan)
              // The live camera inside a blank polaroid, waiting for the other phone's code.
              Center(
                child: SizedBox(
                  width: 300,
                  child: PaperObject(
                    tilt: 1,
                    tape: 2,
                    padding: const EdgeInsets.fromLTRB(10, 10, 10, 12),
                    child: Column(
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(1),
                          child: SizedBox(
                            height: 260,
                            child: MobileScanner(
                              onDetect: (capture) {
                                for (final b in capture.barcodes) {
                                  final v = b.rawValue ?? '';
                                  if (v.startsWith('waypack://receive')) {
                                    try {
                                      _connect(TransferTicket.parse(v));
                                    } on TransferException catch (e) {
                                      setState(() => _error = e.message);
                                    }
                                    return;
                                  }
                                }
                              },
                            ),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Point at the code',
                          style: hand(26, Paper.captionInk),
                        ),
                        const SizedBox(height: 3),
                        const Text(
                          'On their phone: open the trip → ⋯ → Hand off',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 11.5,
                            color: Paper.captionMuted,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              )
            else
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 22),
                child: Text(
                  'On the phone that has the trip: open it, tap ⋯, then Hand off to a nearby phone.',
                  style: TextStyle(fontSize: 15, height: 1.45, color: p.ink),
                ),
              ),
            SectionTitle(
              _canScan ? '…or type it in' : 'Type what the other phone shows',
              size: 23,
              padding: const EdgeInsets.fromLTRB(22, 24, 22, 10),
            ),
            PaperCard(
              padding: const EdgeInsets.all(14),
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: _address,
                      decoration: const InputDecoration(
                        labelText: 'Address',
                        hintText: '192.168.1.5:51234',
                      ),
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _code,
                      decoration: const InputDecoration(
                        labelText: 'Code',
                        hintText: 'ABCD-EFGH',
                      ),
                      textCapitalization: TextCapitalization.characters,
                      autocorrect: false,
                    ),
                    const SizedBox(height: 12),
                    PaperButton(
                      expand: true,
                      label: _busy ? 'Connecting…' : 'Connect',
                      onPressed: _busy
                          ? null
                          : () {
                              try {
                                _connect(
                                  TransferTicket.parse(
                                    _address.text,
                                    typedCode: _code.text,
                                  ),
                                );
                              } on TransferException catch (e) {
                                setState(() => _error = e.message);
                              }
                            },
                    ),
                  ],
                ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 20, 22, 0),
              child: StickyNote(
                tilt: -1,
                child: const Text(
                  _howTo,
                  style: TextStyle(fontSize: 12.5, height: 1.45),
                ),
              ),
            ),
          ] else if (!_done) ...[
            const SizedBox(height: 24),
            polaroid(offer),
            if (existing != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(30, 18, 30, 0),
                child: Text(
                  existing.version >= (offer.trip['version'] as num).toInt()
                      ? 'You already have this version; receiving replaces it.'
                      : 'This replaces your older copy (version ${existing.version}).',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, color: p.muted),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(40, 24, 40, 0),
              child: _progress != null
                  ? Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '$_stage · ${(_progress! * 100).round()}%',
                          style: hand(22, p.ink),
                        ),
                        const SizedBox(height: 6),
                        PaperProgress(value: _progress),
                      ],
                    )
                  : PaperButton(
                      expand: true,
                      icon: Icons.download,
                      label: 'Receive trip',
                      onPressed: _busy ? null : _receive,
                    ),
            ),
          ] else ...[
            const SizedBox(height: 30),
            polaroid(offer, received: true),
            const SizedBox(height: 28),
            Text(
              'It\'s here!',
              textAlign: TextAlign.center,
              style: hand(40, p.ink),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(30, 8, 30, 20),
              child: Text(
                '${offer.title} is on this phone. Everything works offline. When you have signal, it updates like your other trips if you\'re a companion on it.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 14, height: 1.5, color: p.muted),
              ),
            ),
            Center(
              child: PaperButton(
                icon: Icons.open_in_full,
                label: 'Open trip',
                onPressed: () => Navigator.pushReplacement(
                  context,
                  MaterialPageRoute(
                    settings: const RouteSettings(name: 'Trip'),
                    builder: (_) =>
                        TripScreen(tripId: offer.trip['id'] as String),
                  ),
                ),
              ),
            ),
          ],
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 16, 22, 0),
              child: StickyNote(color: Paper.stickyPink, child: Text(_error!)),
            ),
        ],
      ),
    );
  }
}
