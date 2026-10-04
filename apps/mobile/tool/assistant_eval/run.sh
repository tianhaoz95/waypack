#!/usr/bin/env bash
# Asks the device's on-device model the questions in cases.json through the app's real assistant
# (trip brief + searchPlan tool), and checks each answer contains the expected facts.
#   apps/mobile/tool/assistant_eval/run.sh [device] [--no-tools]   (default: macos; needs Apple Intelligence)
#   --no-tools: pre-filled search results instead of tool calling (what Gemini Nano gets)
# Run it after changing the brief, the instructions or the index.
set -euo pipefail
cd "$(dirname "$0")/../.."
DEVICE="macos"; TOOLS=true
for a in "$@"; do case "$a" in --no-tools) TOOLS=false ;; *) DEVICE="$a" ;; esac; done
ROOT="$(cd ../.. && pwd)"
PORT=$((20000 + RANDOM % 20000))
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
flutter test integration_test/assistant_eval_test.dart -d "$DEVICE" --dart-define=EVAL_URL="http://127.0.0.1:$PORT" --dart-define=EVAL_TOOLS=$TOOLS 2>&1 \
  | grep -E "^EVAL|Some tests failed|All tests passed" | sed 's/^EVAL //'
