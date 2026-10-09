import 'dart:io';

/// FeedbackKit (shake to report, screen tracking) only ships Android and iOS implementations.
/// Anywhere else, the Mac app included, its calls throw MissingPluginException; the one in main()
/// left the Mac window black, so every FeedbackKit call goes through this check.
final bool feedbackAvailable = Platform.isIOS || Platform.isAndroid;
