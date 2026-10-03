import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Email + password sign-in. Sign-up sends no email; "Forgot password?" emails a 6-digit code.
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

enum _Mode { signIn, signUp, resetRequest, resetConfirm }

class _SignInScreenState extends State<SignInScreen> {
  static const minPassword = 8;
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _code = TextEditingController();
  _Mode _mode = _Mode.signIn;
  bool _busy = false;
  bool _obscure = true;
  String? _error;
  String? _info;

  GoTrueClient get _auth => Supabase.instance.client.auth;

  void _setMode(_Mode m) => setState(() {
        _mode = m;
        _error = null;
        _info = null;
        _password.clear();
        _code.clear();
      });

  Future<void> _run(Future<void> Function() fn) async {
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await fn();
    } on AuthException catch (e) {
      setState(() => _error = _friendly(e));
    } catch (e) {
      setState(() => _error = 'Something went wrong. Check your connection and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _friendly(AuthException e) {
    final code = e.code ?? '';
    if (code == 'invalid_credentials' || e.message.contains('Invalid login')) return 'Wrong email or password.';
    if (code == 'user_already_exists' || e.message.contains('already registered')) return 'An account with this email already exists. Sign in instead.';
    if (code == 'weak_password') return 'That password is too weak. Use at least $minPassword characters.';
    if (code == 'otp_expired' || e.message.contains('expired')) return 'That code is wrong or expired. Request a new one.';
    if (e.statusCode == '429') return 'Too many attempts. Please wait a few minutes.';
    return e.message;
  }

  String get _emailText => _email.text.trim().toLowerCase();

  bool _validEmail() {
    if (RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(_emailText)) return true;
    setState(() => _error = 'Enter a valid email address.');
    return false;
  }

  Future<void> _submit() async {
    if (!_validEmail()) return;
    switch (_mode) {
      case _Mode.signIn:
        if (_password.text.isEmpty) return setState(() => _error = 'Enter your password.');
        return _run(() => _auth.signInWithPassword(email: _emailText, password: _password.text));
      case _Mode.signUp:
        if (_password.text.length < minPassword) return setState(() => _error = 'Use a password with at least $minPassword characters.');
        return _run(() async {
          final r = await _auth.signUp(email: _emailText, password: _password.text);
          // Supabase answers an existing email with a user that has no identities.
          if (r.session == null) throw const AuthException('An account with this email already exists. Sign in instead.', code: 'user_already_exists');
        });
      case _Mode.resetRequest:
        return _run(() async {
          await _auth.resetPasswordForEmail(_emailText);
          setState(() {
            _mode = _Mode.resetConfirm;
            _info = 'If an account exists for $_emailText, we sent a 6-digit code.';
          });
        });
      case _Mode.resetConfirm:
        if (_password.text.length < minPassword) return setState(() => _error = 'Use a password with at least $minPassword characters.');
        return _run(() async {
          await _auth.verifyOTP(type: OtpType.recovery, email: _emailText, token: _code.text.replaceAll(' ', ''));
          await _auth.updateUser(UserAttributes(password: _password.text));
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final (title, button) = switch (_mode) {
      _Mode.signIn => ('Sign in', 'Sign in'),
      _Mode.signUp => ('Create your account', 'Create account'),
      _Mode.resetRequest => ('Reset password', 'Email me a reset code'),
      _Mode.resetConfirm => ('Choose a new password', 'Set new password'),
    };
    final showPassword = _mode != _Mode.resetRequest;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: AutofillGroup(
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
                    Text(title, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                    if (_info != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_info!, style: TextStyle(color: t.colorScheme.onSurfaceVariant))),
                    const SizedBox(height: 16),
                    TextField(
                      key: const Key('email'),
                      controller: _email,
                      enabled: _mode != _Mode.resetConfirm,
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      autofillHints: const [AutofillHints.email],
                      textInputAction: showPassword ? TextInputAction.next : TextInputAction.go,
                      onSubmitted: showPassword ? null : (_) => _submit(),
                      decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder()),
                    ),
                    if (_mode == _Mode.resetConfirm) ...[
                      const SizedBox(height: 12),
                      TextField(
                        key: const Key('code'),
                        controller: _code,
                        keyboardType: TextInputType.number,
                        autofillHints: const [AutofillHints.oneTimeCode],
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(labelText: '6-digit code from the email', border: OutlineInputBorder()),
                      ),
                    ],
                    if (showPassword) ...[
                      const SizedBox(height: 12),
                      TextField(
                        key: const Key('password'),
                        controller: _password,
                        obscureText: _obscure,
                        autofillHints: [_mode == _Mode.signIn ? AutofillHints.password : AutofillHints.newPassword],
                        textInputAction: TextInputAction.go,
                        onSubmitted: (_) => _submit(),
                        decoration: InputDecoration(
                          labelText: _mode == _Mode.signIn ? 'Password' : 'New password',
                          helperText: _mode == _Mode.signIn ? null : 'At least $minPassword characters',
                          border: const OutlineInputBorder(),
                          suffixIcon: IconButton(
                            tooltip: _obscure ? 'Show password' : 'Hide password',
                            icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                            onPressed: () => setState(() => _obscure = !_obscure),
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    FilledButton(onPressed: _busy ? null : _submit, child: Text(button)),
                    if (_busy) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: CircularProgressIndicator())),
                    if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: TextStyle(color: t.colorScheme.error))),
                    const SizedBox(height: 8),
                    if (_mode == _Mode.signIn) ...[
                      TextButton(onPressed: _busy ? null : () => _setMode(_Mode.signUp), child: const Text('New to Waypack? Create an account')),
                      TextButton(onPressed: _busy ? null : () => _setMode(_Mode.resetRequest), child: const Text('Forgot password?')),
                    ] else
                      TextButton(onPressed: _busy ? null : () => _setMode(_Mode.signIn), child: const Text('Back to sign in')),
                    const SizedBox(height: 16),
                    Text('Use the same account as your AI agent\'s Waypack connection.',
                        textAlign: TextAlign.center, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
