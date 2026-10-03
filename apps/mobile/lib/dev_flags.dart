/// Build-time flags for tests and store screenshots. All default to off.
class DevFlags {
  /// Skip system permission prompts (tests can't tap system dialogs).
  static const noPermissionPrompts = bool.fromEnvironment('NO_PERMISSION_PROMPTS') || bool.fromEnvironment('NO_LOCATION_PROMPT');

  /// Show the dev-only sign-in (works only against a local development server).
  static const devSignIn = bool.fromEnvironment('DEV_SIGN_IN');

  /// Pretend it's this moment (ISO 8601 with offset), e.g. 2026-12-25T10:05:00-08:00.
  static const fakeNow = String.fromEnvironment('FAKE_NOW');

  static DateTime? get fakeNowTime => fakeNow.isEmpty ? null : DateTime.parse(fakeNow);
}
