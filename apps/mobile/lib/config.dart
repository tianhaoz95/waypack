import 'dart:io';

/// Build-time configuration. Pass with --dart-define (see apps/mobile/README.md).
class Config {
  static const _supabaseUrl = String.fromEnvironment('SUPABASE_URL', defaultValue: 'http://127.0.0.1:55421');
  static const supabaseAnonKey = String.fromEnvironment(
    'SUPABASE_ANON_KEY',
    // Supabase's public local-dev anon key (same for every `supabase start`).
    defaultValue:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  );
  static const _apiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://127.0.0.1:8787');
  static const authScheme = 'com.hejitech.waypack';
  static const authRedirect = '$authScheme://login-callback';
  static const privacyUrl = 'https://waypack.app/privacy';
  static const skillUrl = 'https://waypack.app/#connect';

  /// The Android emulator reaches the host's loopback via 10.0.2.2.
  static String _host(String url) =>
      Platform.isAndroid ? url.replaceFirst('://127.0.0.1', '://10.0.2.2').replaceFirst('://localhost', '://10.0.2.2') : url;

  static String get supabaseUrl => _host(_supabaseUrl);
  static String get apiUrl => _host(_apiUrl);
  static String get mcpUrl => '$_apiUrl/mcp';
}
