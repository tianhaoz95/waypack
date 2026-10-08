import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:http/http.dart' as http;
import 'package:sign_in_with_apple/sign_in_with_apple.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../config.dart';
import '../dev_flags.dart';
import '../widgets/scrapbook.dart';

/// One tap: Sign in with Apple (native sheet on iPhone) or Google (system sign-in pop-up).
/// No email or codes.
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
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
    } on _Cancelled {
      // User closed the sheet: nothing to report.
    } on AuthException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = 'Sign-in failed. Please try again.\n($e)');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Google everywhere, and Apple on Android: Supabase OAuth (PKCE) in the system auth session.
  Future<void> _webOAuth(OAuthProvider provider) async {
    final res = await _sb.auth.getOAuthSignInUrl(
      provider: provider,
      redirectTo: Config.authRedirect,
    );
    final String result;
    try {
      result = await FlutterWebAuth2.authenticate(
        url: res.url,
        callbackUrlScheme: Config.authScheme,
      );
    } on PlatformException catch (e) {
      if (e.code == 'CANCELED') throw _Cancelled();
      rethrow;
    }
    final uri = Uri.parse(result);
    final code = uri.queryParameters['code'];
    if (code == null) {
      final err =
          uri.queryParameters['error_description'] ??
          uri.queryParameters['error'];
      if (err == null || err.contains('cancel')) throw _Cancelled();
      throw AuthException(err.replaceAll('+', ' '));
    }
    await _sb.auth.exchangeCodeForSession(code);
  }

  /// Native Sign in with Apple on iOS (Face ID sheet), verified by Supabase with a nonce.
  Future<void> _appleNative() async {
    final rawNonce = _nonce();
    final AuthorizationCredentialAppleID cred;
    try {
      cred = await SignInWithApple.getAppleIDCredential(
        scopes: [
          AppleIDAuthorizationScopes.email,
          AppleIDAuthorizationScopes.fullName,
        ],
        nonce: sha256.convert(utf8.encode(rawNonce)).toString(),
      );
    } on SignInWithAppleAuthorizationException catch (e) {
      if (e.code == AuthorizationErrorCode.canceled) throw _Cancelled();
      rethrow;
    }
    final idToken = cred.identityToken;
    if (idToken == null) {
      throw const AuthException('Apple didn\'t return an identity token.');
    }
    await _sb.auth.signInWithIdToken(
      provider: OAuthProvider.apple,
      idToken: idToken,
      nonce: rawNonce,
    );
  }

  static String _nonce([int length = 32]) {
    const chars =
        '0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._';
    final r = Random.secure();
    return List.generate(length, (_) => chars[r.nextInt(chars.length)]).join();
  }

  Future<void> _apple() => _run(
    () => Platform.isIOS ? _appleNative() : _webOAuth(OAuthProvider.apple),
  );
  Future<void> _google() => _run(() => _webOAuth(OAuthProvider.google));

  /// Local development / tests only (build with --dart-define=DEV_SIGN_IN=true).
  Future<void> _dev(String email) => _run(() async {
    final res = await http.post(
      Uri.parse('${Config.apiUrl}/api/auth/dev'),
      headers: {'Content-Type': 'application/json', 'X-Waypack': '1'},
      body: jsonEncode({'email': email}),
    );
    if (res.statusCode != 200) {
      throw AuthException('Dev sign-in refused (${res.statusCode})');
    }
    await _sb.auth.setSession(
      (jsonDecode(res.body) as Map)['refresh_token'] as String,
    );
  });

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Scaffold(
      backgroundColor: p.bg,
      body: Kraft(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(28, 12, 28, 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _PhotoPile(),
                    const SizedBox(height: 8),
                    Semantics(
                      header: true,
                      child: Text(
                        'Waypack',
                        textAlign: TextAlign.center,
                        style: hand(54, p.ink),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      'Trips planned by your AI agent,\nready when the signal isn\'t.',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 15.5,
                        height: 1.45,
                        color: p.muted,
                      ),
                    ),
                    const SizedBox(height: 30),
                    SignInWithAppleButton(
                      onPressed: _busy ? () {} : _apple,
                      text: 'Continue with Apple',
                      // The Apple button sizes its label from the height (≈0.43×); the Google label matches it.
                      height: 52,
                      style: dark
                          ? SignInWithAppleButtonStyle.white
                          : SignInWithAppleButtonStyle.black,
                      borderRadius: const BorderRadius.all(Radius.circular(26)),
                    ),
                    const SizedBox(height: 12),
                    _GoogleButton(onPressed: _busy ? null : _google),
                    if (_busy)
                      const Padding(
                        padding: EdgeInsets.only(top: 20),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 16),
                        child: StickyNote(
                          color: Paper.stickyPink,
                          child: Text(_error!),
                        ),
                      ),
                    const SizedBox(height: 26),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 12),
                      child: StickyNote(
                        tilt: 1,
                        child: Text(
                          'Use the same account as your AI agent\'s Waypack connection.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 12.5, height: 1.4),
                        ),
                      ),
                    ),
                    if (DevFlags.devSignIn)
                      _DevSignIn(onSubmit: _dev, busy: _busy),
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

/// Three taped polaroids with drawn scenes: the scrapbook before there are any trips.
class _PhotoPile extends StatelessWidget {
  const _PhotoPile();

  Widget _photo(Color accent, int seed, String caption, double width) =>
      SizedBox(
        width: width,
        child: PaperObject(
          padding: const EdgeInsets.fromLTRB(7, 7, 7, 9),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AspectRatio(
                aspectRatio: 1 / .8,
                child: CustomPaint(painter: ScenePainter(accent, seed)),
              ),
              const SizedBox(height: 6),
              Text(caption, style: hand(20, Paper.captionInk)),
            ],
          ),
        ),
      );

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: SizedBox(
      height: 270,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            left: 0,
            top: 34,
            child: Transform.rotate(
              angle: -8 * pi / 180,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  _photo(const Color(0xFFE0703A), 3, 'Beach week', 140),
                  const Positioned(
                    top: -6,
                    left: 4,
                    child: TapeStrip(width: 44, angle: -32),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            right: 0,
            top: 16,
            child: Transform.rotate(
              angle: 6 * pi / 180,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  _photo(const Color(0xFF3F6EA8), 11, 'Ski trip', 140),
                  const Positioned(
                    top: -6,
                    right: 4,
                    child: TapeStrip(
                      width: 44,
                      angle: 28,
                      color: Color(0xFFA9D3C0),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            top: 96,
            child: Center(
              child: Transform.rotate(
                angle: -1.5 * pi / 180,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    _photo(const Color(0xFFC2562D), 7, 'Fall break', 160),
                    const Positioned(
                      top: -8,
                      left: 0,
                      right: 0,
                      child: Center(child: TapeStrip(color: Color(0xFFF3D27A))),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

class _Cancelled implements Exception {}

/// Google-branded button (white, "G" logo) per Google's sign-in branding guidelines.
class _GoogleButton extends StatelessWidget {
  const _GoogleButton({required this.onPressed});
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 52,
    child: OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF1F1F1F),
        side: const BorderSide(color: Color(0xFF747775)),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(fontSize: 20, fontWeight: FontWeight.w500),
      ),
      child: const Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _GoogleG(),
          SizedBox(width: 8),
          Flexible(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Text('Continue with Google'),
            ),
          ),
        ],
      ),
    ),
  );
}

class _GoogleG extends StatelessWidget {
  const _GoogleG();
  @override
  Widget build(BuildContext context) => const SizedBox(
    width: 20,
    height: 20,
    child: CustomPaint(painter: _GPainter()),
  );
}

/// Draws the four-colour Google "G".
class _GPainter extends CustomPainter {
  const _GPainter();
  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width;
    final stroke = s * 0.2;
    final rect = Rect.fromCircle(
      center: Offset(s / 2, s / 2),
      radius: s / 2 - stroke / 2,
    );
    Paint p(Color c) => Paint()
      ..color = c
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke;
    const deg = pi / 180;
    canvas.drawArc(
      rect,
      -40 * deg,
      -100 * deg,
      false,
      p(const Color(0xFFEA4335)),
    ); // red (top)
    canvas.drawArc(
      rect,
      -140 * deg,
      -80 * deg,
      false,
      p(const Color(0xFFFBBC05)),
    ); // yellow (left)
    canvas.drawArc(
      rect,
      -220 * deg,
      -95 * deg,
      false,
      p(const Color(0xFF34A853)),
    ); // green (bottom)
    canvas.drawArc(
      rect,
      -315 * deg,
      -45 * deg,
      false,
      p(const Color(0xFF4285F4)),
    ); // blue (right)
    canvas.drawLine(
      Offset(s / 2, s / 2),
      Offset(s - stroke / 2, s / 2),
      p(const Color(0xFF4285F4))..strokeCap = StrokeCap.butt,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _DevSignIn extends StatefulWidget {
  const _DevSignIn({required this.onSubmit, required this.busy});
  final Future<void> Function(String email) onSubmit;
  final bool busy;
  @override
  State<_DevSignIn> createState() => _DevSignInState();
}

class _DevSignInState extends State<_DevSignIn> {
  final _email = TextEditingController(text: 'dev@waypack.test');
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 32),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Divider(),
        Text(
          'Dev sign-in (local server only)',
          style: Theme.of(context).textTheme.labelMedium,
        ),
        const SizedBox(height: 8),
        TextField(
          key: const Key('dev-email'),
          controller: _email,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            isDense: true,
          ),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: widget.busy
              ? null
              : () => widget.onSubmit(_email.text.trim()),
          child: const Text('Dev sign-in'),
        ),
      ],
    ),
  );
}
