#!/usr/bin/env bash
# The scripts job runs `make test-scripts`, which is this guard plus every
# other script check. A job `if:` or `continue-on-error:` switches that job
# off. The guard used to stay green, so CI could skip the guard and a local
# run would still pass. The program job is already refused in that shape.
#
# must-reject (counted):
#   scripts-if-false   if: false on the scripts job
#   scripts-continue   continue-on-error: true on the scripts job
#
# The unedited copy is the control. The repository workflow stays accepted.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD=ci-covers-packages.test.sh

pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

scratch() {
    local dir name pkg
    dir=$(mktemp -d)
    mkdir -p "$dir/scripts" "$dir/.github/workflows" "$dir/programs/veto/src"
    cp "$ROOT/scripts/$GUARD" "$dir/scripts/$GUARD"
    cp "$ROOT/.github/workflows/ci.yml" "$dir/.github/workflows/ci.yml"
    cp "$ROOT/README.md" "$dir/README.md"
    printf 'pub fn veto() {}\n' > "$dir/programs/veto/src/lib.rs"
    for pkg in "$ROOT"/*/package.json; do
        name=$(basename "$(dirname "$pkg")")
        [ "$name" = "node_modules" ] && continue
        mkdir -p "$dir/$name/src"
        cp "$pkg" "$dir/$name/package.json"
        printf 'export const x = 1;\n' > "$dir/$name/src/index.ts"
        printf '# %s\n' "$name" > "$dir/$name/README.md"
    done
    printf '%s' "$dir"
}

edit() {
    python3 - "$1/.github/workflows/ci.yml" "$2" <<'PY'
import sys
path, mode = sys.argv[1], sys.argv[2]
s = open(path).read()
needle = "  scripts:\n    runs-on: ubuntu-latest\n"
assert s.count(needle) == 1, (mode, s.count(needle))
extra = {
    "scripts-if-false": "    if: false\n",
    "scripts-continue": "    continue-on-error: true\n",
}
if mode not in extra:
    sys.exit("unknown mode " + mode)
open(path, "w").write(s.replace(needle, needle + extra[mode], 1))
PY
}

guard_reason() {
    "$1/scripts/$GUARD" 2>/dev/null | grep '^not ok' | sed -n '1p'
}

guard_passes() {
    "$1/scripts/$GUARD" >/dev/null 2>&1
}

expect_reason() {
    case "$1" in
        scripts-if-false) printf '%s' "scripts job if disables the check before the step runs" ;;
        scripts-continue) printf '%s' "scripts job continue-on-error disables the check before the step runs" ;;
        *) return 1 ;;
    esac
}

MUST_REJECT="scripts-if-false scripts-continue"

for mode in $MUST_REJECT; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    reason=$(expect_reason "$mode") || { bad "no expected reason for $mode"; rm -rf "$dir"; continue; }
    if guard_passes "$dir"; then
        bad "guard stays green with $mode, so CI can skip make test-scripts and the guard still passes"
    else
        case "$(guard_reason "$dir")" in
            *"$reason"*) ok "guard refuses $mode because the scripts job is switched off" ;;
            *) bad "guard fails with $mode for another reason: $(guard_reason "$dir")" ;;
        esac
    fi
    rm -rf "$dir"
done

dir=$(scratch)
if guard_passes "$dir"; then
    ok "unedited scratch copy passes the guard (control)"
else
    bad "unedited scratch copy fails the guard: $(guard_reason "$dir")"
fi
rm -rf "$dir"

printf 'ci coverage scripts-job checks: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
