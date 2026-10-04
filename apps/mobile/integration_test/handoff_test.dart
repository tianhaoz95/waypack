// Offline handoff between two real app instances (tool/handoff_e2e.mjs runs both):
//   ROLE=send    (e.g. the Mac app): download the seeded trip, open "Hand off to a nearby phone",
//                print TICKET_HOST/TICKET_CODE, wait until a device has received it.
//   ROLE=receive (e.g. an iOS simulator): sign in as another user who isn't on the trip, type
//                the address + code, receive, open the trip.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:provider/provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:waypack/main.dart';

const role = String.fromEnvironment('ROLE', defaultValue: 'send');
const email = String.fromEnvironment(
  'TEST_EMAIL',
  defaultValue: 'dev@waypack.test',
);
const ticketHost = String.fromEnvironment('TICKET_HOST');
const ticketCode = String.fromEnvironment('TICKET_CODE');

Future<void> settle(WidgetTester t, [int ms = 1500]) async {
  for (var i = 0; i < ms ~/ 100; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

Future<void> until(WidgetTester t, Finder f, {int seconds = 90}) async {
  for (var i = 0; i < seconds * 10 && f.evaluate().isEmpty; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
  expect(f, findsWidgets, reason: 'waited ${seconds}s for $f');
}

Future<void> shot(WidgetTester t, String name) async {
  await settle(t, 1000);
  // ignore: avoid_print
  print('SHOT:$name');
  await settle(t, 2500);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('handoff $role', (t) async {
    final state = await bootstrap();
    if (Supabase.instance.client.auth.currentSession != null) {
      await state.signOut();
    }
    for (final e in [...state.upcoming, ...state.past]) {
      await state.store.deleteLocal(e.id);
    }
    await t.pumpWidget(
      ChangeNotifierProvider.value(value: state, child: const WaypackApp()),
    );
    await settle(t);
    await t.enterText(find.byKey(const Key('dev-email')), email);
    await t.tap(find.text('Dev sign-in'));

    if (role == 'send') {
      await until(t, find.text('Download'));
      await t.tap(find.text('Download').first);
      await until(t, find.text('Open'));
      await t.tap(find.text('Open').first);
      await settle(t, 3000);
      await t.tap(find.byTooltip('Waypack menu'));
      await settle(t);
      await t.tap(find.text('Hand off to a nearby phone'));
      await until(t, find.textContaining('code '));
      final text = find
          .byType(SelectableText)
          .evaluate()
          .map((e) => (e.widget as SelectableText).data ?? '')
          .firstWhere((d) => d.contains('code '));
      final lines = text.split('\n');
      // ignore: avoid_print
      print('TICKET_HOST:${lines[0]}');
      // ignore: avoid_print
      print('TICKET_CODE:${lines[1].replaceFirst('code ', '')}');
      await shot(t, 'send-1-qr');
      await until(t, find.textContaining('Sent to 1 device'), seconds: 900);
      await shot(t, 'send-2-sent');
    } else {
      await until(t, find.text('Receive a trip from a nearby phone'));
      await shot(t, 'recv-1-empty');
      await t.tap(find.text('Receive a trip from a nearby phone'));
      await settle(t);
      await t.enterText(find.widgetWithText(TextField, 'Address'), ticketHost);
      await t.enterText(
        find.widgetWithText(TextField, 'Code'),
        ticketCode.toLowerCase(),
      );
      await t.tap(find.text('Connect'));
      await until(t, find.text('Receive trip'));
      await shot(t, 'recv-2-offer');
      await t.tap(find.text('Receive trip'));
      await until(t, find.text('Open trip'), seconds: 180);
      await shot(t, 'recv-3-done');
      await t.tap(find.text('Open trip'));
      await settle(t, 6000);
      await shot(t, 'recv-4-trip');
      // The trip screen is full-screen (no app bar): go back like the system back gesture.
      await t.binding.handlePopRoute();
      await settle(t);
      await until(t, find.text('From a nearby phone'));
      await shot(t, 'recv-5-trips');
    }
  });
}
