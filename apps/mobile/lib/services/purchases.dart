import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

import '../config.dart';

/// RevenueCat wrapper (design §11). Disabled gracefully when no API key is configured
/// (local dev), so the rest of the app works without store setup.
class Billing {
  static bool enabled = false;
  static const entitlement = 'pro';

  static Future<void> init(String? userId) async {
    final key = Platform.isIOS ? Config.revenueCatAppleKey : Config.revenueCatGoogleKey;
    if (key.isEmpty) return;
    try {
      await Purchases.setLogLevel(kDebugMode ? LogLevel.debug : LogLevel.warn);
      await Purchases.configure(PurchasesConfiguration(key)..appUserID = userId);
      enabled = true;
    } catch (e) {
      debugPrint('RevenueCat init failed: $e');
    }
  }

  /// RevenueCat's app user id must be the Supabase user id so the webhook can map it.
  static Future<void> identify(String userId) async {
    if (!enabled) return;
    await Purchases.logIn(userId);
  }

  static Future<void> logOut() async {
    if (!enabled) return;
    try {
      await Purchases.logOut();
    } catch (_) {}
  }

  static Future<List<Package>> packages() async {
    if (!enabled) return const [];
    final offerings = await Purchases.getOfferings();
    return offerings.current?.availablePackages ?? const [];
  }

  /// Returns true if the purchase granted the `pro` entitlement.
  static Future<bool> buy(Package p) async {
    final result = await Purchases.purchase(PurchaseParams.package(p));
    return result.customerInfo.entitlements.active.containsKey(entitlement);
  }

  static Future<bool> restore() async {
    if (!enabled) return false;
    final info = await Purchases.restorePurchases();
    return info.entitlements.active.containsKey(entitlement);
  }
}
