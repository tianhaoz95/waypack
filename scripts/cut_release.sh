#!/usr/bin/env bash
# Cut a Waypack release: bump the version, push, and publish GitHub Release v<version>, which
# ships every app surface through GitHub Actions:
#   - iOS        → TestFlight            (.github/workflows/testflight.yml)
#   - Mac        → Waypack.dmg on the release, served at /download/mac (.github/workflows/mac-release.yml)
# The Worker + site deploy on any push to main (Cloudflare Workers Builds), so the version-bump
# push ships them too.
#
#   scripts/cut_release.sh                 # next patch (first release: the pubspec version)
#   scripts/cut_release.sh minor           # or: major | patch | 1.4.0
#   scripts/cut_release.sh 1.4.0 --notes "Offline maps on the phone"
#   scripts/cut_release.sh --dry-run       # show what would happen, change nothing
#   scripts/cut_release.sh --watch         # wait for the release workflows and report
#   scripts/cut_release.sh --force         # skip the CI-is-green check
#
# Build numbers are assigned by CI (1000 + run number); pubspec's +build is left alone.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBSPEC=apps/mobile/pubspec.yaml
BUMP="" NOTES="" DRY=0 WATCH=0 FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    major|minor|patch) BUMP="$1" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$1" ;;
    --notes) NOTES="${2:?--notes needs text}"; shift ;;
    --dry-run) DRY=1 ;;
    --watch) WATCH=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "!! unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "!! $*" >&2; exit 1; }
run() { if [ "$DRY" -eq 1 ]; then echo "   (dry run) $*"; else "$@"; fi; }

# ------------------------------------------------------------------ preflight

command -v gh >/dev/null || die "the GitHub CLI (gh) is required"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

[ "$(git branch --show-current)" = main ] || die "release from main (on $(git branch --show-current))"
[ -z "$(git status --porcelain)" ] || die "working tree has uncommitted changes"
git fetch -q origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main differs from origin/main: pull or push first"

# The release ships whatever CI last checked; refuse a red or unchecked commit.
HEAD_SHA="$(git rev-parse HEAD)"
if [ "$FORCE" -eq 0 ]; then
  CI="$(gh run list --repo "$REPO" --workflow ci.yml --commit "$HEAD_SHA" --limit 1 --json status,conclusion -q '.[0] | "\(.status) \(.conclusion)"' 2>/dev/null || true)"
  case "$CI" in
    "completed success") echo "==> CI is green on ${HEAD_SHA:0:7}" ;;
    "") die "no CI run for ${HEAD_SHA:0:7} yet (push first, or --force)" ;;
    completed*) die "CI failed on ${HEAD_SHA:0:7} ($CI): fix it, or --force" ;;
    *) die "CI is still running on ${HEAD_SHA:0:7}: wait for it, or --force" ;;
  esac
fi

# Signing material the release workflows need (names only; values are never readable).
SECRETS="$(gh secret list --repo "$REPO" --json name -q '.[].name')"
missing=()
for s in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8_BASE64 SIGNING_P12_BASE64 SIGNING_P12_PASSWORD MAC_SIGNING_P12_BASE64 MAC_SIGNING_P12_PASSWORD; do
  grep -qx "$s" <<<"$SECRETS" || missing+=("$s")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "!! missing repo secrets: ${missing[*]} (see docs/DEPLOY.md §4b)" >&2
  [ "$FORCE" -eq 1 ] || die "the release workflows would fail; set them, or --force"
fi

# -------------------------------------------------------------- version

PUB_LINE="$(grep -E '^version:' "$PUBSPEC" | awk '{print $2}')"
PUB_VERSION="${PUB_LINE%%+*}" PUB_BUILD="${PUB_LINE#*+}"
LAST_TAG="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)"
BASE="${LAST_TAG#v}"

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEXT="$BUMP"
elif [ -z "$LAST_TAG" ] && [ -z "$BUMP" ]; then
  NEXT="$PUB_VERSION" # first release: ship what pubspec already says
else
  [ -n "$BASE" ] || BASE="$PUB_VERSION"
  IFS=. read -r MA MI PA <<<"$BASE"
  case "${BUMP:-patch}" in
    major) NEXT="$((MA + 1)).0.0" ;;
    minor) NEXT="$MA.$((MI + 1)).0" ;;
    patch) NEXT="$MA.$MI.$((PA + 1))" ;;
  esac
fi
TAG="v$NEXT"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && die "release $TAG already exists"
if [ -n "$LAST_TAG" ] && [ "$(printf '%s\n%s\n' "$BASE" "$NEXT" | sort -V | tail -1)" != "$NEXT" ]; then
  die "$NEXT is not newer than the last release $LAST_TAG"
fi

echo "==> releasing $TAG (last: ${LAST_TAG:-none}; pubspec $PUB_LINE)"

# --------------------------------------------------------------- release

if [ "$PUB_VERSION" != "$NEXT" ]; then
  echo "==> pubspec.yaml: $PUB_LINE → $NEXT+$PUB_BUILD"
  if [ "$DRY" -eq 0 ]; then
    sed -i.bak -E "s/^version: .*/version: $NEXT+$PUB_BUILD/" "$PUBSPEC" && rm -f "$PUBSPEC.bak"
    git add "$PUBSPEC"
    git commit -q -m "Release $TAG"
    git push -q origin main
  else
    echo "   (dry run) commit \"Release $TAG\" and push (deploys the Worker + site)"
  fi
  HEAD_SHA="$(git rev-parse HEAD)"
fi

ARGS=(--repo "$REPO" --target "$HEAD_SHA" --title "Waypack $NEXT" --latest)
if [ -n "$NOTES" ]; then ARGS+=(--notes "$NOTES"); else ARGS+=(--generate-notes); fi
echo "==> publishing GitHub Release $TAG at ${HEAD_SHA:0:7}"
run gh release create "$TAG" "${ARGS[@]}"

[ "$DRY" -eq 1 ] && { echo "==> dry run: nothing was changed"; exit 0; }

echo "==> started:"
echo "    iOS → TestFlight:   https://github.com/$REPO/actions/workflows/testflight.yml"
echo "    Mac → Waypack.dmg:  https://github.com/$REPO/actions/workflows/mac-release.yml"
echo "    release:            https://github.com/$REPO/releases/tag/$TAG"

if [ "$WATCH" -eq 1 ]; then
  sleep 10 # let the release event fan out
  status=0
  for wf in testflight.yml mac-release.yml; do
    id="$(gh run list --repo "$REPO" --workflow "$wf" --event release --limit 1 --json databaseId -q '.[0].databaseId')"
    [ -n "$id" ] || { echo "!! no $wf run found" >&2; status=1; continue; }
    echo "==> waiting for $wf ($id)…"
    if gh run watch "$id" --repo "$REPO" --exit-status --interval 30 >/dev/null; then
      echo "    $wf: success"
    else
      echo "!! $wf failed: gh run view $id --repo $REPO --log-failed" >&2
      status=1
    fi
  done
  exit "$status"
fi
