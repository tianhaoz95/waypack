import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../config.dart';

/// Email + 6-digit code (same flow as the MCP authorize page), optionally Apple/Google.
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _code = TextEditingController();
  bool _codeSent = false;
  bool _busy = false;
  String? _error;

  SupabaseClient get _sb => Supabase.instance.client;

  Future<void> _run(Future<void> Function() fn) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await fn();
    } on AuthException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = 'Something went wrong: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendCode() => _run(() async {
        final email = _email.text.trim();
        if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email)) throw const AuthException('Enter a valid email address.');
        await _sb.auth.signInWithOtp(email: email, shouldCreateUser: true);
        setState(() => _codeSent = true);
      });

  Future<void> _verify() => _run(() async {
        await _sb.auth.verifyOTP(type: OtpType.email, email: _email.text.trim(), token: _code.text.replaceAll(' ', ''));
      });

  Future<void> _oauth(OAuthProvider p) => _run(() async {
        await _sb.auth.signInWithOAuth(p, redirectTo: Config.authRedirect);
      });

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(Icons.backpack_outlined, size: 56, color: t.colorScheme.primary),
                  const SizedBox(height: 12),
                  Text('Waypack', textAlign: TextAlign.center, style: t.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  Text('Trips planned by your AI agent, ready when the signal isn\'t.',
                      textAlign: TextAlign.center, style: t.textTheme.bodyLarge?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                  const SizedBox(height: 32),
                  if (!_codeSent) ...[
                    TextField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                      textInputAction: TextInputAction.go,
                      onSubmitted: (_) => _sendCode(),
                      decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder()),
                    ),
                    const SizedBox(height: 12),
                    FilledButton(onPressed: _busy ? null : _sendCode, child: const Text('Email me a sign-in code')),
                  ] else ...[
                    Text('Enter the 6-digit code sent to ${_email.text.trim()}', style: t.textTheme.bodyLarge),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _code,
                      keyboardType: TextInputType.number,
                      autofillHints: const [AutofillHints.oneTimeCode],
                      textInputAction: TextInputAction.go,
                      onSubmitted: (_) => _verify(),
                      style: t.textTheme.headlineSmall?.copyWith(letterSpacing: 6),
                      decoration: const InputDecoration(labelText: 'Code', border: OutlineInputBorder()),
                    ),
                    const SizedBox(height: 12),
                    FilledButton(onPressed: _busy ? null : _verify, child: const Text('Sign in')),
                    TextButton(onPressed: _busy ? null : () => setState(() => _codeSent = false), child: const Text('Use a different email')),
                  ],
                  if (Config.enableOAuthProviders) ...[
                    const SizedBox(height: 24),
                    const Row(children: [Expanded(child: Divider()), Padding(padding: EdgeInsets.symmetric(horizontal: 8), child: Text('or')), Expanded(child: Divider())]),
                    const SizedBox(height: 16),
                    OutlinedButton.icon(onPressed: _busy ? null : () => _oauth(OAuthProvider.apple), icon: const Icon(Icons.apple), label: const Text('Continue with Apple')),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(onPressed: _busy ? null : () => _oauth(OAuthProvider.google), icon: const Icon(Icons.g_mobiledata), label: const Text('Continue with Google')),
                  ],
                  if (_busy) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: CircularProgressIndicator())),
                  if (_error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(_error!, style: TextStyle(color: t.colorScheme.error))),
                  const SizedBox(height: 24),
                  Text('Use the same email as your AI agent\'s Waypack connection.',
                      textAlign: TextAlign.center, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
