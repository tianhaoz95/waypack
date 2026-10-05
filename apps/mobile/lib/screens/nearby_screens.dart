import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../dev_flags.dart';
import '../services/transfer.dart';
import '../state/app_state.dart';
import '../util/format.dart';
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
    final t = Theme.of(context);
    final server = _server;
    final noNetwork = server != null && server.ticket.hosts.isEmpty;
    return Scaffold(
      appBar: AppBar(title: const Text('Hand off to a nearby phone')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              if (_error != null)
                Text(_error!, style: TextStyle(color: t.colorScheme.error)),
              if (server == null && _error == null)
                const Center(
                  child: Padding(
                    padding: EdgeInsets.all(48),
                    child: CircularProgressIndicator(),
                  ),
                ),
              if (server != null) ...[
                Text(
                  server.offer.title,
                  style: t.textTheme.titleLarge,
                  textAlign: TextAlign.center,
                ),
                Text(
                  '${formatBytes(server.offer.totalBytes)} · ${server.offer.files.any((f) => f.kind == 'tiles') ? 'plan + offline map' : 'plan only'}',
                  textAlign: TextAlign.center,
                  style: t.textTheme.bodyMedium?.copyWith(
                    color: t.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 20),
                if (noNetwork)
                  Card(
                    color: t.colorScheme.secondaryContainer,
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'This device isn\'t on a Wi-Fi network or hotspot.',
                            style: t.textTheme.titleMedium,
                          ),
                          const SizedBox(height: 6),
                          const Text(
                            'Turn on Personal Hotspot (it works without signal), ask the other phone to join it, then tap Try again.',
                          ),
                          const SizedBox(height: 10),
                          FilledButton(
                            onPressed: _start,
                            child: const Text('Try again'),
                          ),
                        ],
                      ),
                    ),
                  )
                else ...[
                  Center(
                    child: Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: QrImageView(
                        data: server.ticket.toUri(),
                        size: 240,
                        backgroundColor: Colors.white,
                        semanticsLabel: 'Handoff QR code',
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'On the other phone: Waypack → Trips → Receive from a nearby phone, then scan this code.',
                    textAlign: TextAlign.center,
                    style: t.textTheme.bodyLarge,
                  ),
                  const SizedBox(height: 12),
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.keyboard_outlined),
                      title: const Text('No camera? Type this instead'),
                      subtitle: SelectableText(
                        '${server.ticket.hosts.first}\ncode ${formatCode(server.ticket.code)}',
                        style: t.textTheme.titleMedium?.copyWith(
                          fontFamily: 'monospace',
                        ),
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 8),
                if (_sending != null) ...[
                  Text('Sending… ${(_sending! * 100).round()}%'),
                  const SizedBox(height: 6),
                  LinearProgressIndicator(value: _sending),
                ] else if (_sent > 0)
                  ListTile(
                    leading: Icon(
                      Icons.check_circle,
                      color: Colors.green.shade700,
                    ),
                    title: Text(
                      'Sent to $_sent device${_sent == 1 ? '' : 's'}',
                    ),
                    subtitle: const Text(
                      'Another phone can scan the same code while this screen is open.',
                    ),
                  ),
                const SizedBox(height: 8),
                Text(
                  _howTo,
                  style: t.textTheme.bodySmall?.copyWith(
                    color: t.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Sharing stops when you leave this screen (or after 15 minutes).',
                  style: t.textTheme.bodySmall?.copyWith(
                    color: t.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
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
    final t = Theme.of(context);
    final s = context.watch<AppState>();
    final offer = _offer;
    final existing = offer == null
        ? null
        : s.trip(offer.trip['id'] as String)?.local;
    return Scaffold(
      appBar: AppBar(title: const Text('Receive from a nearby phone')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              if (offer == null) ...[
                Text(
                  'On the phone that has the trip: open it, tap ⋯, then Hand off to a nearby phone.',
                  style: t.textTheme.bodyLarge,
                ),
                const SizedBox(height: 8),
                Text(
                  _howTo,
                  style: t.textTheme.bodySmall?.copyWith(
                    color: t.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 16),
                if (_canScan)
                  ClipRRect(
                    borderRadius: BorderRadius.circular(16),
                    child: SizedBox(
                      height: 300,
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
                const SizedBox(height: 16),
                Text(
                  _canScan
                      ? 'Or type what the other phone shows'
                      : 'Type what the other phone shows',
                  style: t.textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _address,
                  decoration: const InputDecoration(
                    labelText: 'Address',
                    hintText: '192.168.1.5:51234',
                    border: OutlineInputBorder(),
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
                    border: OutlineInputBorder(),
                  ),
                  textCapitalization: TextCapitalization.characters,
                  autocorrect: false,
                ),
                const SizedBox(height: 12),
                FilledButton(
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
                  child: Text(_busy ? 'Connecting…' : 'Connect'),
                ),
              ] else if (!_done) ...[
                Text(offer.title, style: t.textTheme.headlineSmall),
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
                  style: t.textTheme.bodyMedium?.copyWith(
                    color: t.colorScheme.onSurfaceVariant,
                  ),
                ),
                if (existing != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      existing.version >= (offer.trip['version'] as num).toInt()
                          ? 'You already have this version; receiving replaces it.'
                          : 'This replaces your older copy (version ${existing.version}).',
                    ),
                  ),
                const SizedBox(height: 16),
                if (_progress != null) ...[
                  Text('$_stage · ${(_progress! * 100).round()}%'),
                  const SizedBox(height: 6),
                  LinearProgressIndicator(value: _progress),
                ] else
                  FilledButton.icon(
                    onPressed: _busy ? null : _receive,
                    icon: const Icon(Icons.download),
                    label: const Text('Receive trip'),
                  ),
              ] else ...[
                Icon(
                  Icons.check_circle,
                  size: 56,
                  color: Colors.green.shade700,
                ),
                const SizedBox(height: 8),
                Text(
                  '${offer.title} is on this phone',
                  style: t.textTheme.titleLarge,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 4),
                Text(
                  'Everything works offline. When you have signal, it updates like your other trips if you\'re a companion on it.',
                  textAlign: TextAlign.center,
                  style: t.textTheme.bodyMedium?.copyWith(
                    color: t.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: () => Navigator.pushReplacement(
                    context,
                    MaterialPageRoute(
                      settings: const RouteSettings(name: 'Trip'),
                      builder: (_) =>
                          TripScreen(tripId: offer.trip['id'] as String),
                    ),
                  ),
                  child: const Text('Open trip'),
                ),
              ],
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    _error!,
                    style: TextStyle(color: t.colorScheme.error),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
