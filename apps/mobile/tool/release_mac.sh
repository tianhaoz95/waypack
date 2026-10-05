#!/usr/bin/env bash
# Build, sign and package the Mac app as a DMG; optionally notarize it and publish it to the site.
#
#   tool/release_mac.sh --check              # verify identity, notary credentials and config; build nothing
#   tool/release_mac.sh                      # release build → signed .app → signed DMG (build/release/)
#   tool/release_mac.sh --notarize           # ...then notarize + staple (required before anyone else can open it)
#   tool/release_mac.sh --notarize --upload  # ...then publish a GitHub release; https://<site>/download/mac redirects to it
#   tool/release_mac.sh --skip-build         # re-sign/re-package the last build
#   tool/release_mac.sh --dev                # allow localhost config (local testing only; never ship this)
#
# Config (required unless --dev): SUPABASE_URL, SUPABASE_ANON_KEY, API_URL — same as the mobile release builds.
# Version: pubspec.yaml `version:` (1.2.0+7 → Waypack-1.2.0.dmg, build 7).
#
# Identity: WAYPACK_MAC_IDENTITY, else the keychain's "Developer ID Application" certificate.
# Notarization auth, best first:
#   WAYPACK_NOTARY_PROFILE                         a `xcrun notarytool store-credentials` profile
#   FA_ASC_KEY_ID + FA_ASC_ISSUER_ID (+ FA_KEY_LOCATION or ~/.appstoreconnect/private_keys/AuthKey_<id>.p8)
# Upload: a GitHub release `mac-v<version>` on WAYPACK_RELEASE_REPO (default tianhaoz95/waypack) with
#   the DMG as `Waypack.dmg`, via `gh` (logged in with write access). The site's /download/mac
#   redirects to .../releases/latest/download/Waypack.dmg.
#
# Why sign by hand instead of `codesign --deep`: --deep applies the app's entitlements to every nested
# framework. Sign innermost-first: each framework with no entitlements, then the app with its own.
set -euo pipefail

cd "$(dirname "$0")/.."
MOBILE="$PWD"
ROOT="$(cd ../.. && pwd)"
ENTITLEMENTS="$MOBILE/macos/Runner/Release.entitlements"
APP="$MOBILE/build/macos/Build/Products/Release/Waypack.app"
OUT="$MOBILE/build/release"
REPO="${WAYPACK_RELEASE_REPO:-tianhaoz95/waypack}"   # keep in sync with MAC_RELEASES_REPO in services/mcp

CHECK=0 NOTARIZE=0 UPLOAD="" SKIP_BUILD=0 DEV=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --notarize) NOTARIZE=1 ;;
    --upload) UPLOAD=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --dev) DEV=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "!! unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION_LINE="$(grep -E '^version:' pubspec.yaml | awk '{print $2}')"
VERSION="${VERSION_LINE%%+*}"
BUILD="${VERSION_LINE#*+}"; [ "$BUILD" = "$VERSION_LINE" ] && BUILD=1
DMG="$OUT/Waypack-$VERSION.dmg"

# ------------------------------------------------------------------ config

DEFINES=()
if [ "$DEV" -eq 1 ]; then
  echo "==> --dev: local config (127.0.0.1); this build only works on this Mac with the dev stack running"
  [ -n "$UPLOAD" ] && { echo "!! refusing to upload a --dev build to the real site" >&2; exit 1; }
else
  missing=()
  for v in SUPABASE_URL SUPABASE_ANON_KEY API_URL; do [ -n "${!v:-}" ] || missing+=("$v"); done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "!! set ${missing[*]} (production values; see docs/DEPLOY.md), or pass --dev for a local test build" >&2
    exit 1
  fi
  case "$SUPABASE_URL $API_URL" in
    *127.0.0.1*|*localhost*) echo "!! SUPABASE_URL/API_URL point at localhost; use --dev for that" >&2; exit 1 ;;
  esac
  DEFINES=(--dart-define="SUPABASE_URL=$SUPABASE_URL" --dart-define="SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY" --dart-define="API_URL=$API_URL")
fi

# ---------------------------------------------------------------- identity

IDENTITY="${WAYPACK_MAC_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/')}"
[ -n "$IDENTITY" ] || {
  echo "!! no \"Developer ID Application\" certificate in the keychain." >&2
  echo "   The Apple Developer account holder creates one: Xcode > Settings > Accounts > Manage Certificates > +" >&2
  exit 1
}
echo "==> identity: $IDENTITY"

# ----------------------------------------------------------- notary auth

NOTARY=()
if [ -n "${WAYPACK_NOTARY_PROFILE:-}" ]; then
  NOTARY=(--keychain-profile "$WAYPACK_NOTARY_PROFILE")
elif [ -n "${FA_ASC_KEY_ID:-}" ] && [ -n "${FA_ASC_ISSUER_ID:-}" ]; then
  KEY="${FA_KEY_LOCATION:-$HOME/.appstoreconnect/private_keys/AuthKey_${FA_ASC_KEY_ID}.p8}"
  KEY="${KEY/#\~/$HOME}"
  [ -f "$KEY" ] && NOTARY=(--key "$KEY" --key-id "$FA_ASC_KEY_ID" --issuer "$FA_ASC_ISSUER_ID")
fi
if [ ${#NOTARY[@]} -gt 0 ]; then echo "==> notary credentials: found"; else echo "==> notary credentials: none (needed for --notarize)"; fi

if [ "$CHECK" -eq 1 ]; then
  command -v npx >/dev/null && echo "==> wrangler: available via npx (for --upload)"
  echo "==> would build Waypack $VERSION ($BUILD) → $DMG"
  exit 0
fi
if [ "$NOTARIZE" -eq 1 ] && [ ${#NOTARY[@]} -eq 0 ]; then
  echo "!! --notarize needs WAYPACK_NOTARY_PROFILE or FA_ASC_KEY_ID + FA_ASC_ISSUER_ID (see the header)" >&2
  exit 1
fi
if [ -n "$UPLOAD" ] && [ "$NOTARIZE" -eq 0 ]; then
  echo "!! --upload requires --notarize: an un-notarized DMG won't open on other Macs" >&2
  exit 1
fi
# Fail before a long build if the release can't be published.
if [ -n "$UPLOAD" ]; then
  gh auth status >/dev/null 2>&1 || { echo "!! --upload needs the GitHub CLI logged in (gh auth login)" >&2; exit 1; }
  if gh release view "mac-v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
    echo "!! release mac-v$VERSION already exists on $REPO: bump version: in pubspec.yaml" >&2
    exit 1
  fi
fi

# ------------------------------------------------------------------ build

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> building Waypack $VERSION ($BUILD)"
  (cd "$ROOT" && node apps/mobile/tool/bundle_sdk.mjs)
  flutter build macos --release ${DEFINES[@]+"${DEFINES[@]}"}
fi
[ -d "$APP" ] || { echo "!! no app at $APP — build first" >&2; exit 1; }

# ------------------------------------------------------------------- sign

echo "==> signing frameworks (innermost first)"
while IFS= read -r f; do
  codesign --force --sign "$IDENTITY" --timestamp --options runtime "$f"
  echo "    ${f#"$APP/Contents/"}"
done < <(find "$APP/Contents/Frameworks" -depth \( -name "*.framework" -o -name "*.dylib" \) 2>/dev/null)
# Any other executable code (none today; keeps this honest if a plugin starts shipping a helper).
while IFS= read -r f; do
  file -b "$f" | grep -q "Mach-O" || continue
  codesign --force --sign "$IDENTITY" --timestamp --options runtime "$f"
  echo "    ${f#"$APP/Contents/"}"
done < <(find "$APP/Contents/Resources" -type f -perm -u+x 2>/dev/null)

echo "==> signing the app"
codesign --force --sign "$IDENTITY" --timestamp --options runtime --entitlements "$ENTITLEMENTS" "$APP"
codesign --verify --deep --strict "$APP"

# The notary service rejects get-task-allow (debugger attach), which debug builds carry.
if codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q "get-task-allow"; then
  echo "!! get-task-allow is set on the app; notarization would fail" >&2
  exit 1
fi
echo "    entitlements: $(codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -o 'com\.apple\.security\.[a-z.-]*' | tr '\n' ' ')"

# -------------------------------------------------------------------- dmg

echo "==> packaging $DMG"
mkdir -p "$OUT"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Waypack.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Waypack" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
codesign --force --sign "$IDENTITY" --timestamp "$DMG"

# --------------------------------------------------------------- notarize

if [ "$NOTARIZE" -eq 1 ]; then
  echo "==> notarizing (a few minutes)"
  xcrun notarytool submit "$DMG" "${NOTARY[@]}" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler staple "$APP"
  spctl -a -vvv -t open --context context:primary-signature "$DMG" 2>&1 | sed 's/^/    /' || true
else
  echo "    (not notarized: fine on this Mac; other Macs will refuse to open it)"
fi

SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
SIZE="$(stat -f %z "$DMG")"
echo "==> $DMG  ($((SIZE / 1024 / 1024)) MB, sha256 $SHA)"

# ----------------------------------------------------------------- upload

if [ -n "$UPLOAD" ]; then
  # Fixed asset name, so github.com/<repo>/releases/latest/download/Waypack.dmg is always the newest.
  TAG="mac-v$VERSION"
  cp "$DMG" "$OUT/Waypack.dmg"
  echo "==> publishing GitHub release $TAG on $REPO (asset Waypack.dmg)"
  gh release create "$TAG" "$OUT/Waypack.dmg" --repo "$REPO" --latest \
    --title "Waypack for Mac $VERSION" \
    --notes "Waypack for Mac $VERSION (build $BUILD). macOS 12+, Apple silicon and Intel. SHA-256 \`$SHA\`."
  echo "==> live at /download/mac (redirects to the latest release)"
fi
