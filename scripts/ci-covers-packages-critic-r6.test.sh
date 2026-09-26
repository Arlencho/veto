#!/usr/bin/env bash
# Critic round 2 on the scripts-job rule. The producer fixture counts if: and
# continue-on-error: on the job named scripts. The next step of the same class
# is a job under another name that runs make test-scripts, and the job being
# removed rather than disabled. The rule reads the run text, not the job name,
# so a renamed live job is accepted and a renamed switched-off job is refused.
#
# must-reject (counted):
#   renamed-if        job renamed to checks, if: false on it
#   removed           the scripts job deleted from the workflow
#   step-if           if: false on the make test-scripts step
#   or-true           run: make test-scripts || true
#   workdir           working-directory: scripts on the step
#
# controls (accepted):
#   renamed-live      job renamed to checks, nothing else changed
#   timeout           timeout-minutes: 30 on the scripts job
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
job = "  scripts:\n    runs-on: ubuntu-latest\n"
step = '          make test-scripts 2>&1 | tee "$RUNNER_TEMP/ci-scripts-tests.txt"\n'
whole = (
    '  scripts:\n    runs-on: ubuntu-latest\n    steps:\n'
    '      - uses: actions/checkout@v4\n      - name: Deploy-script checks\n'
    '        run: |\n'
    '          set -o pipefail\n'
    '          make test-scripts 2>&1 | tee "$RUNNER_TEMP/ci-scripts-tests.txt"\n'
    '      - name: Prove the scripts tests ran\n'
    '        run: |\n'
    '          bash "$GITHUB_WORKSPACE/scripts/ci-assert-test-count.sh" scripts "$RUNNER_TEMP/ci-scripts-tests.txt"\n'
    '\n'
)
edits = {
    "renamed-if":   (job, "  checks:\n    runs-on: ubuntu-latest\n    if: false\n"),
    "removed":      (whole, ""),
    "step-if":      (step, step + "        if: false\n"),
    "or-true":      (step, '          make test-scripts || true 2>&1 | tee "$RUNNER_TEMP/ci-scripts-tests.txt"\n'),
    "workdir":      (step, step + "        working-directory: scripts\n"),
    "renamed-live": (job, "  checks:\n    runs-on: ubuntu-latest\n"),
    "timeout":      (job, job + "    timeout-minutes: 30\n"),
}
if mode not in edits:
    sys.exit("unknown mode " + mode)
needle, repl = edits[mode]
assert s.count(needle) == 1, (mode, s.count(needle))
open(path, "w").write(s.replace(needle, repl, 1))
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
        renamed-if) printf '%s' "checks job if disables the check before the step runs" ;;
        removed)    printf '%s' "no job runs make test-scripts from the repo root" ;;
        step-if)    printf '%s' "scripts step if or continue-on-error can stop make test-scripts" ;;
        or-true)    printf '%s' "no job runs make test-scripts from the repo root" ;;
        workdir)    printf '%s' "scripts working-directory scripts is not the repo root" ;;
        *) return 1 ;;
    esac
}

MUST_REJECT="renamed-if removed step-if or-true workdir"
CONTROLS="renamed-live timeout"

for mode in $MUST_REJECT; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    reason=$(expect_reason "$mode") || { bad "no expected reason for $mode"; rm -rf "$dir"; continue; }
    if guard_passes "$dir"; then
        bad "guard stays green with $mode, so make test-scripts can be skipped and the guard still passes"
    else
        case "$(guard_reason "$dir")" in
            *"scripts check: "*"$reason"*) ok "guard refuses $mode on the scripts check" ;;
            *) bad "guard fails with $mode for another reason: $(guard_reason "$dir")" ;;
        esac
    fi
    rm -rf "$dir"
done

for mode in $CONTROLS; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        ok "guard accepts $mode (control)"
    else
        bad "guard refuses $mode, a live job: $(guard_reason "$dir")"
    fi
    rm -rf "$dir"
done

printf 'ci coverage critic r6 checks: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
