#!/usr/bin/env bash
set -eu

# Run from the skill root (tests/run.sh).
cd "$(dirname "$0")/.."

pass=0
fail=0
failures=()

run_test() {
  local name=$1
  local file=$2
  if node "$file"; then
    pass=$((pass + 1))
    echo "PASS  $name"
  else
    fail=$((fail + 1))
    failures+=("$name")
    echo "FAIL  $name"
  fi
}

echo "dsc-scrape tests"
echo "----------------"

for f in tests/test-*.js; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .js)
  run_test "$name" "$f"
done

echo "----------------"
echo "$pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  printf '  %s\n' "${failures[@]}"
  exit 1
fi
