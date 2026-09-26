#!/usr/bin/env bash
# Ground Truth: a package that defines a typecheck script has a CI job that
# runs that script, not a bare tsc invocation.
#
# A package's typecheck script is where the second tsconfig lives (app: the
# test files carry Node types and are checked by tsconfig.test.json). A CI
# step that runs `npx tsc --noEmit` directly runs only the first tsconfig, so
# a test can call a function with an argument it no longer takes and CI
# stays green. That is issue #85 with the fix present on the branch and
# absent from the gate.
# No network, no cloud, no vendor CLIs.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI="$ROOT/.github/workflows/ci.yml"

pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

[ -f "$CI" ] || { echo "no workflow at $CI" >&2; exit 1; }

for pkg in "$ROOT"/*/package.json; do
    dir=$(dirname "$pkg")
    name=$(basename "$dir")
    [ "$name" = "node_modules" ] && continue

    has_typecheck=$(python3 -c "
import json,sys
try: print('yes' if 'typecheck' in json.load(open(sys.argv[1])).get('scripts',{}) else 'no')
except Exception: print('no')" "$pkg")
    [ "$has_typecheck" = "yes" ] || continue

    block=$(awk -v p="  $name:" '
        $0 == p {inblock=1; next}
        inblock && /^  [a-zA-Z0-9_-]+:$/ {exit}
        inblock {print}
    ' "$CI")

    if [ -z "$block" ]; then
        bad "$name has a typecheck script but no CI job"
        continue
    fi
    if printf '%s' "$block" | grep -E "run: npm run typecheck" >/dev/null; then
        ok "$name CI job runs npm run typecheck"
    else
        bad "$name CI job does not run npm run typecheck (a bare tsc skips every tsconfig the script adds)"
    fi
done

echo "ci typecheck checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
