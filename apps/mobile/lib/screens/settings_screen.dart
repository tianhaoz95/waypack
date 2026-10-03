import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../config.dart';
import '../services/handoff.dart';
import '../state/app_state.dart';
import '../util/format.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, this.scrollToConnect = false});
  final bool scrollToConnect;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _connectKey = GlobalKey();
  int? _storage;
  List<Map<String, dynamic>>? _tokens;

  @override
  void initState() {
    super.initState();
    final s = context.read<AppState>();
    s.store.usedBytes().then((b) => mounted ? setState(() => _storage = b) : null);
    _loadTokens();
    if (widget.scrollToConnect) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final c = _connectKey.currentContext;
        if (c != null) Scrollable.ensureVisible(c, duration: const Duration(milliseconds: 300));
      });
    }
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
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$what copied')));
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
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Copy it now — it won\'t be shown again. Use it as a Bearer token for headless MCP clients.'),
            const SizedBox(height: 12),
            SelectableText(r['token'] as String, style: const TextStyle(fontFamily: 'monospace')),
          ]),
          actions: [
            TextButton(onPressed: () => _copy(r['token'] as String, 'Token'), child: const Text('Copy')),
            FilledButton(onPressed: () => Navigator.pop(d), child: const Text('Done')),
          ],
        ),
      );
      _loadTokens();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Couldn\'t create token: $e')));
    }
  }

  Future<void> _deleteAccount() async {
    final s = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Delete account?'),
        content: const Text('This permanently deletes your account, all trips and offline maps on our servers, and cancels any subscription.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: Theme.of(d).colorScheme.error), onPressed: () => Navigator.pop(d, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await s.api.deleteAccount();
      for (final e in [...s.upcoming, ...s.past]) {
        await s.store.deleteLocal(e.id);
      }
      await s.signOut();
      if (mounted) Navigator.popUntil(context, (r) => r.isFirst);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final t = Theme.of(context);
    final plan = (s.me?['plan'] as Map?)?['tier'] as String? ?? 'free';
    final mcp = Config.mcpUrl;
    Widget section(String title) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
          child: Text(title, style: t.textTheme.titleSmall?.copyWith(color: t.colorScheme.primary, fontWeight: FontWeight.w700)),
        );

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(children: [
        section('Account'),
        ListTile(leading: const Icon(Icons.person_outline), title: Text(s.user?.email ?? 'Signed in')),
        ListTile(
          leading: const Icon(Icons.workspace_premium_outlined),
          title: Text(plan == 'free' ? 'Free plan' : plan == 'lifetime' ? 'Waypack Pro · Lifetime' : 'Waypack Pro · Annual'),
          // The app is a free viewer: plans live on the user's account (no purchasing in the app).
          subtitle: Text(plan == 'free' ? '1 active trip · maps need a connection' : 'Offline maps · up to 10 active trips'),
        ),
        ListTile(
          leading: const Icon(Icons.sd_storage_outlined),
          title: const Text('Storage used'),
          trailing: Text(_storage == null ? '…' : formatBytes(_storage!)),
        ),

        Container(key: _connectKey, child: section('Connect your AI agent')),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('1. Add the Waypack MCP server to your agent:'),
            const SizedBox(height: 8),
            _CodeBox(text: mcp, onCopy: () => _copy(mcp, 'MCP URL')),
            const SizedBox(height: 8),
            _CodeBox(text: 'claude mcp add --transport http waypack $mcp', onCopy: () => _copy('claude mcp add --transport http waypack $mcp', 'Command')),
            const SizedBox(height: 12),
            const Text('2. Optional: install the Waypack skill for best results (Claude Code / Claude apps).'),
            TextButton(onPressed: () => Handoff.openExternal(Config.skillUrl), child: const Text('Skill install instructions')),
            const Text('3. Ask: "Plan a 3-day trip to … with Waypack." Sign in with this same email when the agent asks.'),
          ]),
        ),
        section('API tokens'),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text('For headless MCP clients that can\'t do OAuth.', style: t.textTheme.bodySmall),
        ),
        if (_tokens != null)
          for (final tok in _tokens!)
            ListTile(
              leading: const Icon(Icons.key_outlined),
              title: Text('${tok['token_prefix']}…'),
              subtitle: Text('${tok['label'] ?? ''} · last used ${tok['last_used_at'] == null ? 'never' : relativeTime(DateTime.parse(tok['last_used_at'] as String))}'),
              trailing: IconButton(
                tooltip: 'Revoke',
                icon: const Icon(Icons.delete_outline),
                onPressed: () async {
                  await s.api.revokeToken(tok['id'] as String);
                  _loadTokens();
                },
              ),
            ),
        ListTile(leading: const Icon(Icons.add), title: const Text('Create token'), onTap: _newToken),

        section('About'),
        ListTile(leading: const Icon(Icons.privacy_tip_outlined), title: const Text('Privacy policy'), onTap: () => Handoff.openExternal(Config.privacyUrl)),
        ListTile(
          leading: const Icon(Icons.copyright_outlined),
          title: const Text('Map data & licenses'),
          subtitle: const Text('© OpenStreetMap contributors (ODbL), Protomaps, MapLibre'),
          onTap: () => showLicensePage(context: context, applicationName: 'Waypack', applicationLegalese: 'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL). Basemap by Protomaps. Rendering by MapLibre GL JS (BSD-3-Clause). Fonts: Noto Sans (SIL OFL 1.1).'),
        ),
        const Divider(height: 32),
        ListTile(leading: const Icon(Icons.logout), title: const Text('Sign out'), onTap: () async {
          await s.signOut();
          if (context.mounted) Navigator.popUntil(context, (r) => r.isFirst);
        }),
        ListTile(
          leading: Icon(Icons.delete_forever_outlined, color: t.colorScheme.error),
          title: Text('Delete account', style: TextStyle(color: t.colorScheme.error)),
          onTap: _deleteAccount,
        ),
        const SizedBox(height: 32),
      ]),
    );
  }
}

class _CodeBox extends StatelessWidget {
  const _CodeBox({required this.text, required this.onCopy});
  final String text;
  final VoidCallback onCopy;
  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(color: Theme.of(context).colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(10)),
        padding: const EdgeInsets.only(left: 12),
        child: Row(children: [
          Expanded(child: SelectableText(text, style: const TextStyle(fontFamily: 'monospace', fontSize: 13))),
          IconButton(tooltip: 'Copy', icon: const Icon(Icons.copy, size: 20), onPressed: onCopy),
        ]),
      );
}
