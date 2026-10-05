#!/usr/bin/env bash
# Build the iOS app and upload it to App Store Connect (TestFlight).
#
#   SUPABASE_URL=… SUPABASE_ANON_KEY=… API_URL=… tool/release_ios.sh
#
# Bump `version:` in pubspec.yaml first (1.0.0+2 → version 1.0.0, build 2); build numbers can't repeat.
# CI (.github/workflows/testflight.yml) overrides both with BUILD_NAME / BUILD_NUMBER.
# Signing: automatic, team 68CTFST8W2, authorized by the App Store Connect API key, so Xcode needs no
# signed-in account: FA_ASC_KEY_ID + FA_ASC_ISSUER_ID (+ FA_KEY_LOCATION or
# ~/.appstoreconnect/private_keys/AuthKey_<id>.p8). Upload settings: ios/ExportOptions.plist.
set -euo pipefail
cd "$(dirname "$0")/.."

missing=()
for v in SUPABASE_URL SUPABASE_ANON_KEY API_URL FA_ASC_KEY_ID FA_ASC_ISSUER_ID; do [ -n "${!v:-}" ] || missing+=("$v"); done
[ ${#missing[@]} -eq 0 ] || { echo "!! set ${missing[*]}" >&2; exit 1; }
case "$SUPABASE_URL $API_URL" in *127.0.0.1*|*localhost*) echo "!! SUPABASE_URL/API_URL point at localhost" >&2; exit 1 ;; esac
KEY="${FA_KEY_LOCATION:-$HOME/.appstoreconnect/private_keys/AuthKey_${FA_ASC_KEY_ID}.p8}"
KEY="${KEY/#\~/$HOME}"
[ -f "$KEY" ] || { echo "!! API key not found: $KEY" >&2; exit 1; }
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY" -authenticationKeyID "$FA_ASC_KEY_ID" -authenticationKeyIssuerID "$FA_ASC_ISSUER_ID")

VERSION_LINE="$(grep -E '^version:' pubspec.yaml | awk '{print $2}')"
BUILD_NAME="${BUILD_NAME:-${VERSION_LINE%%+*}}"
BUILD_NUMBER="${BUILD_NUMBER:-${VERSION_LINE#*+}}"
echo "==> Waypack $BUILD_NAME ($BUILD_NUMBER)"
(cd ../.. && node apps/mobile/tool/bundle_sdk.mjs)   # the trip SDK the app serves (packages/trip-sdk/dist)
flutter build ios --release --no-codesign --build-name="$BUILD_NAME" --build-number="$BUILD_NUMBER" \
  --dart-define="SUPABASE_URL=$SUPABASE_URL" --dart-define="SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY" --dart-define="API_URL=$API_URL"
rm -rf build/ios/archive/Runner.xcarchive build/ios/export
xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/ios/archive/Runner.xcarchive archive "${AUTH[@]}" | tail -5
xcodebuild -exportArchive -archivePath build/ios/archive/Runner.xcarchive \
  -exportOptionsPlist ios/ExportOptions.plist -exportPath build/ios/export "${AUTH[@]}" | tail -5
echo "==> uploaded; it shows up in TestFlight after Apple finishes processing (5–30 min)"
