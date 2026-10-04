#!/usr/bin/env bash
# Asks the device's on-device model the questions in cases.json, using the app's real trip briefs,
# and checks each answer contains the expected facts. macOS with Apple Intelligence for now.
#   apps/mobile/tool/assistant_eval/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
EVAL_OUT="$OUT" flutter test tool/assistant_eval/build_prompts_test.dart >/dev/null
swiftc -parse-as-library tool/assistant_eval/apple.swift -o "$OUT/apple" 2>/dev/null
pass=0; fail=0
n=$(python3 -c 'import json;print(len(json.load(open("tool/assistant_eval/cases.json"))))')
for ((i = 0; i < n; i++)); do
  q=$(python3 -c "import json;c=json.load(open('tool/assistant_eval/cases.json'))[$i];print('[%s] %s' % (c['trip'], c['q']))")
  a=$("$OUT/apple" "$OUT/$i.instructions" "$OUT/$i.prompt" | tr '\n' ' ')
  if python3 -c "import json,sys;c=json.load(open('tool/assistant_eval/cases.json'))[$i];a=sys.argv[1].lower();sys.exit(0 if all(e.lower() in a for e in c['expect']) else 1)" "$a"; then
    pass=$((pass + 1)); echo "✓ $q"; else fail=$((fail + 1)); echo "✗ $q"; fi
  echo "    $a"
done
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
