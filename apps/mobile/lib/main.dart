import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'config.dart';
import 'dev_flags.dart';
import 'screens/sign_in_screen.dart';
import 'screens/trips_screen.dart';
import 'services/api.dart';
import 'services/local_server.dart';
import 'services/notifications.dart';
import 'services/trip_store.dart';
import 'state/app_state.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final state = await bootstrap();
  runApp(ChangeNotifierProvider.value(value: state, child: const WaypackApp()));
}

/// Initializes services; shared by main() and integration tests.
Future<AppState> bootstrap() async {
  await Supabase.initialize(
    url: Config.supabaseUrl,
    publishableKey: Config.supabaseAnonKey,
    // Email + password only; no deep-link (magic link / OAuth) callbacks to handle.
    authOptions: const FlutterAuthClientOptions(detectSessionInUri: false),
  );
  final store = await TripStore.open();
  final server = LocalServer(store);
  await server.start();
  await Reminders.init();

  final state = AppState(store: store, server: server, api: Api());
  await state.init();
  return state;
}

class WaypackApp extends StatelessWidget {
  const WaypackApp({super.key});

  ThemeData _theme(Brightness b) => ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1D6FE0), brightness: b),
        visualDensity: VisualDensity.standard,
        cardTheme: const CardThemeData(margin: EdgeInsets.symmetric(vertical: 6)),
        filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(minimumSize: const Size(48, 48))),
        outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48))),
      );

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Waypack',
        debugShowCheckedModeBanner: false,
        theme: _theme(Brightness.light),
        darkTheme: _theme(Brightness.dark),
        home: const _AuthGate(),
      );
}

class _AuthGate extends StatefulWidget {
  const _AuthGate();
  @override
  State<_AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<_AuthGate> {
  StreamSubscription<AuthState>? _sub;
  bool _signedIn = false;

  @override
  void initState() {
    super.initState();
    _signedIn = Supabase.instance.client.auth.currentSession != null;
    _sub = Supabase.instance.client.auth.onAuthStateChange.listen((e) {
      if (!mounted) return;
      // Any transition to a session counts (OAuth, Apple ID token, or a restored session).
      final now = e.session != null;
      if (now && !_signedIn) {
        context.read<AppState>().onSignedIn();
        if (!DevFlags.noPermissionPrompts) Reminders.requestPermission();
      }
      _signedIn = now;
      setState(() {});
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Offline launches keep working: the persisted session is used without a network call.
    final signedIn = Supabase.instance.client.auth.currentSession != null;
    return signedIn ? const TripsScreen() : const SignInScreen();
  }
}
