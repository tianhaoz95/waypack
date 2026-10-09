import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../config.dart';
import '../services/feedback.dart';
import '../services/handoff.dart';
import '../services/updater.dart';
import '../state/app_state.dart';
import '../util/format.dart';
import '../widgets/scrapbook.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, this.scrollToConnect = false});
  final bool scrollToConnect;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _connectKey = GlobalKey();
  int? _storage;
  UpdaterInfo? _updates;
  List<Map<String, dynamic>>? _tokens;

  @override
  void initState() {
    super.initState();
    final s = context.read<AppState>();
    s.store.usedBytes().then(
      (b) => mounted ? setState(() => _storage = b) : null,
    );
    _loadUpdates();
    _loadTokens();
    if (widget.scrollToConnect) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final c = _connectKey.currentContext;
        if (c != null) {
          Scrollable.ensureVisible(
            c,
            duration: const Duration(milliseconds: 300),
          );
        }
      });
    }
  }

  Future<void> _loadUpdates() async {
    final i = await Updater.info();
    if (mounted) setState(() => _updates = i);
  }

  Future<void> _loadTokens() async {
    try {
      final t = await context.read<AppState>().api.tokens();
      if (mounted) setState(() => _tokens = t);
    } catch (_) {
      if (mounted) setState(() => _tokens = null);
    }
  }

  void _copy(String text, String what) {
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('$what copied')));
  }

  Future<void> _newToken() async {
    final s = context.read<AppState>();
    try {
      final r = await s.api.createToken('Created in app');
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (d) => AlertDialog(
          title: const Text('New API token'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Copy it now — it won\'t be shown again. Use it as a Bearer token for headless MCP clients.',
              ),
              const SizedBox(height: 12),
              SelectableText(
                r['token'] as String,
                style: const TextStyle(fontFamily: 'monospace'),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => _copy(r['token'] as String, 'Token'),
              child: const Text('Copy'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(d),
              child: const Text('Done'),
            ),
          ],
        ),
      );
      _loadTokens();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Couldn\'t create token: $e')));
      }
    }
  }

  Future<void> _deleteAccount() async {
    final s = context.read<AppState>();
    final ok = await showPaperConfirm(
      context,
      title: 'Delete account?',
      message: 'This permanently deletes your account, all trips and offline maps on our servers, and cancels any subscription.',
    );
    if (!ok) return;
    try {
      await s.api.deleteAccount();
      for (final e in [...s.upcoming, ...s.past]) {
        await s.store.deleteLocal(e.id);
      }
      await s.signOut();
      if (mounted) Navigator.popUntil(context, (r) => r.isFirst);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final p = Paper.of(context);
    final plan = (s.me?['plan'] as Map?)?['tier'] as String? ?? 'free';
    final mcp = Config.mcpUrl;
    final cmd = 'claude mcp add --transport http waypack $mcp';
    final step = TextStyle(fontSize: 13.5, height: 1.5, color: p.ink);
    Widget num(String n) => Container(
      width: 20,
      height: 20,
      margin: const EdgeInsets.only(right: 8, top: 1),
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: ChipColor.yellow,
        shape: BoxShape.circle,
      ),
      child: Text(
        n,
        style: const TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w800,
          color: Paper.captionInk,
        ),
      ),
    );
    return KraftScaffold(
      title: 'Settings',
      body: ListView(
        padding: const EdgeInsets.only(top: 4, bottom: 40),
        children: [
          PaperCard(
            children: [
              PaperRow(
                icon: Icons.person_outline,
                chip: ChipColor.pink,
                title: s.user?.email ?? 'Signed in',
                subtitle: plan == 'free'
                    ? 'Free plan · 1 active trip · maps need a connection'
                    : '${plan == 'lifetime' ? 'Waypack Pro · Lifetime' : 'Waypack Pro · Annual'} · offline maps · up to 10 active trips',
                // The app is a free viewer: plans live on the user's account (no purchasing in the app).
                trailing: Stamp(
                  label: plan == 'free' ? 'Free' : 'Pro',
                  color: plan == 'free' ? p.muted : p.accent,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          PaperCard(
            children: [
              PaperRow(
                icon: Icons.sd_storage_outlined,
                chip: ChipColor.blue,
                title: 'Storage used',
                trailing: Text(
                  _storage == null ? '…' : formatBytes(_storage!),
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: p.muted,
                  ),
                ),
              ),
              PaperRow(
                icon: Icons.public,
                chip: ChipColor.mint,
                title: 'Use online map',
                subtitle: 'When connected, show the full map, including outside your downloaded areas. Turn off to use only downloaded maps, e.g. to save data abroad.',
                trailing: Switch.adaptive(
                  value: s.useOnlineMap,
                  onChanged: s.setUseOnlineMap,
                ),
                onTap: () => s.setUseOnlineMap(!s.useOnlineMap),
              ),
            ],
          ),
          Container(
            key: _connectKey,
            child: const SectionTitle('Connect your AI agent'),
          ),
          PaperCard(
            padding: const EdgeInsets.all(14),
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      num('1'),
                      Expanded(
                        child: Text(
                          'Add the Waypack MCP server to your agent:',
                          style: step,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  _CodeBox(text: mcp, onCopy: () => _copy(mcp, 'MCP URL')),
                  const SizedBox(height: 6),
                  _CodeBox(text: cmd, onCopy: () => _copy(cmd, 'Command')),
                  const SizedBox(height: 12),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      num('2'),
                      Expanded(
                        child: Text(
                          'Optional: install the Waypack skill for best results (Claude Code / Claude apps).',
                          style: step,
                        ),
                      ),
                    ],
                  ),
                  Padding(
                    padding: const EdgeInsets.only(left: 20),
                    child: TextButton(
                      style: TextButton.styleFrom(foregroundColor: p.accent),
                      onPressed: () => Handoff.openExternal(Config.skillUrl),
                      child: const Text('Skill install instructions →'),
                    ),
                  ),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      num('3'),
                      Expanded(
                        child: Text.rich(
                          TextSpan(
                            style: step,
                            children: [
                              const TextSpan(text: 'Ask: '),
                              TextSpan(
                                text: '“Plan a 3-day trip to … with Waypack.”',
                                style: hand(20, p.ink),
                              ),
                              const TextSpan(
                                text: ' Sign in with this same email when the agent asks.',
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
          const SectionTitle('API tokens', note: 'for headless MCP clients'),
          PaperCard(
            children: [
              if (_tokens != null)
                for (final tok in _tokens!)
                  PaperRow(
                    icon: Icons.key_outlined,
                    chip: ChipColor.yellow,
                    title: '${tok['token_prefix']}…',
                    subtitle:
                        '${tok['label'] ?? ''} · last used ${tok['last_used_at'] == null ? 'never' : relativeTime(DateTime.parse(tok['last_used_at'] as String))}',
                    trailing: IconButton(
                      tooltip: 'Revoke',
                      icon: Icon(Icons.delete_outline, color: p.muted),
                      onPressed: () async {
                        await s.api.revokeToken(tok['id'] as String);
                        _loadTokens();
                      },
                    ),
                  ),
              PaperRow(
                icon: Icons.add,
                chip: ChipColor.mint,
                title: 'Create token',
                subtitle: 'For MCP clients that can\'t do OAuth',
                chevron: true,
                onTap: _newToken,
              ),
            ],
          ),
          if (_updates != null) ...[
            const SectionTitle('Updates', note: 'Waypack for Mac'),
            PaperCard(
              children: [
                PaperRow(
                  icon: Icons.system_update_alt,
                  chip: ChipColor.mint,
                  title: 'Check for updates automatically',
                  subtitle: _updates!.enabled
                      ? 'Waypack checks once a day and asks before installing.'
                      : 'Not available in development builds.',
                  enabled: _updates!.enabled,
                  trailing: Switch.adaptive(
                    value: _updates!.automatic,
                    onChanged: _updates!.enabled
                        ? (v) async {
                            await Updater.setAutomatic(v);
                            _loadUpdates();
                          }
                        : null,
                  ),
                ),
                PaperRow(
                  icon: Icons.refresh,
                  chip: ChipColor.yellow,
                  title: 'Check for updates now',
                  subtitle:
                      'Version ${_updates!.version} (${_updates!.build})'
                      '${_updates!.lastCheck != null ? ' · last checked ${relativeTime(_updates!.lastCheck!)}' : ''}',
                  enabled: _updates!.enabled,
                  chevron: true,
                  onTap: () async {
                    await Updater.checkNow();
                    _loadUpdates();
                  },
                ),
              ],
            ),
          ],
          const SectionTitle('More'),
          PaperCard(
            children: [
              // Shaking is a phone gesture (and FeedbackKit is phone-only).
              if (feedbackAvailable)
                PaperRow(
                  icon: Icons.vibration,
                  chip: ChipColor.yellow,
                  title: 'Shake to report feedback',
                  subtitle: 'Shake your device to capture a screenshot and report an issue.',
                  trailing: Switch.adaptive(
                    value: s.shakeToReport,
                    onChanged: s.setShakeToReport,
                  ),
                  onTap: () => s.setShakeToReport(!s.shakeToReport),
                ),
              PaperRow(
                icon: Icons.privacy_tip_outlined,
                chip: ChipColor.lilac,
                title: 'Privacy policy',
                chevron: true,
                onTap: () => Handoff.openExternal(Config.privacyUrl),
              ),
              PaperRow(
                icon: Icons.copyright_outlined,
                chip: ChipColor.blue,
                title: 'Map data & licenses',
                subtitle:
                    '© OpenStreetMap contributors (ODbL), Protomaps, MapLibre',
                chevron: true,
                onTap: () => showLicensePage(
                  context: context,
                  applicationName: 'Waypack',
                  applicationLegalese: 'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL). Basemap by Protomaps. Rendering by MapLibre GL JS (BSD-3-Clause). Fonts: Noto Sans (SIL OFL 1.1), Caveat (SIL OFL 1.1).',
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          PaperCard(
            children: [
              PaperRow(
                icon: Icons.logout,
                chip: ChipColor.blue,
                title: 'Sign out',
                onTap: () async {
                  await s.signOut();
                  if (context.mounted) {
                    Navigator.popUntil(context, (r) => r.isFirst);
                  }
                },
              ),
              PaperRow(
                icon: Icons.delete_forever_outlined,
                destructive: true,
                title: 'Delete account',
                onTap: _deleteAccount,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _CodeBox extends StatelessWidget {
  const _CodeBox({required this.text, required this.onCopy});
  final String text;
  final VoidCallback onCopy;
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return Container(
      decoration: BoxDecoration(
        color: p.ink.withValues(alpha: .06),
        borderRadius: BorderRadius.circular(6),
      ),
      padding: const EdgeInsets.only(left: 12),
      child: Row(
        children: [
          Expanded(
            child: SelectableText(
              text,
              style: TextStyle(
                fontFamily: 'monospace',
                fontFamilyFallback: const ['Menlo', 'Courier'],
                fontSize: 12.5,
                color: p.ink,
              ),
            ),
          ),
          IconButton(
            tooltip: 'Copy',
            icon: Icon(Icons.copy, size: 18, color: p.muted),
            onPressed: onCopy,
          ),
        ],
      ),
    );
  }
}
