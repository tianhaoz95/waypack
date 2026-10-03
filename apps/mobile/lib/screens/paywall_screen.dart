import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

import '../config.dart';
import '../services/handoff.dart';
import '../services/purchases.dart';
import '../state/app_state.dart';

/// Waypack Pro paywall (design §11). Prices come from the stores via RevenueCat.
class PaywallScreen extends StatefulWidget {
  const PaywallScreen({super.key});
  @override
  State<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends State<PaywallScreen> {
  List<Package>? _packages;
  bool _busy = false;
  String? _message;

  @override
  void initState() {
    super.initState();
    Billing.packages().then((p) => mounted ? setState(() => _packages = p) : null).catchError((Object e) {
      if (mounted) setState(() => _message = 'Couldn\'t load prices: $e');
    });
  }

  Future<void> _done(bool granted) async {
    if (!mounted) return;
    if (granted) {
      // The server learns about the purchase via the RevenueCat webhook; give it a moment.
      await Future<void>.delayed(const Duration(seconds: 2));
      if (!mounted) return;
      await context.read<AppState>().refresh();
      if (mounted) Navigator.pop(context);
    } else {
      setState(() => _message = 'No active Waypack Pro purchase found.');
    }
  }

  Future<void> _buy(Package p) async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await _done(await Billing.buy(p));
    } on PurchasesError catch (e) {
      if (e.code != PurchasesErrorCode.purchaseCancelledError) setState(() => _message = e.message);
    } catch (e) {
      setState(() => _message = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final features = [
      (Icons.map_outlined, 'Offline maps', 'Trails, roads and labels for your whole trip area — no signal needed.'),
      (Icons.my_location, 'GPS blue dot', 'See where you are on the offline map.'),
      (Icons.luggage_outlined, 'Up to 10 active trips', 'Plan several trips at once.'),
    ];
    return Scaffold(
      appBar: AppBar(title: const Text('Waypack Pro')),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Text('Take the whole trip offline', style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 16),
        for (final (icon, title, sub) in features)
          ListTile(contentPadding: EdgeInsets.zero, leading: Icon(icon, color: t.colorScheme.primary), title: Text(title), subtitle: Text(sub)),
        const SizedBox(height: 16),
        if (!Billing.enabled)
          const Card(child: Padding(padding: EdgeInsets.all(16), child: Text('Purchases aren\'t configured in this build (missing RevenueCat key).')))
        else if (_packages == null)
          const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
        else
          for (final p in _packages!)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                onPressed: _busy ? null : () => _buy(p),
                child: Text(p.packageType == PackageType.lifetime
                    ? 'Lifetime · ${p.storeProduct.priceString} (founding member)'
                    : 'Annual · ${p.storeProduct.priceString}/year'),
              ),
            ),
        TextButton(
          onPressed: _busy || !Billing.enabled
              ? null
              : () async {
                  setState(() => _busy = true);
                  try {
                    await _done(await Billing.restore());
                  } finally {
                    if (mounted) setState(() => _busy = false);
                  }
                },
          child: const Text('Restore purchases'),
        ),
        if (_message != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_message!, style: TextStyle(color: t.colorScheme.error))),
        const SizedBox(height: 16),
        Text(
          'Annual auto-renews until cancelled in your App Store / Google Play settings. Lifetime is a one-time purchase. Trips you\'ve already planned stay available on the free plan.',
          style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
        ),
        TextButton(onPressed: () => Handoff.openExternal(Config.privacyUrl), child: const Text('Privacy policy')),
      ]),
    );
  }
}
