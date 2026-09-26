#!/usr/bin/env bash
# PR 147 round 2 (issue 108). Round 1 showed a run step or a uses step
# between the capture step and the proof step rewriting the log. This round
# tries the other shapes a step can take in that slot, and moves a check job
# into a reusable workflow so the capture, a rewrite, and the proof all sit
# in a file the guard never opens. Each must be refused with the job named.
# Steps before the Test step are setup and must stay accepted whatever
# their shape.
#
# must-reject (counted):
#   an if-guarded run step between the app capture and proof steps
#   a flow-style run step in the same slot
#   an if-guarded run step between the program capture and proof steps
#   the app job replaced by a reusable workflow that carries its steps
#   the scripts job replaced by a reusable workflow that carries its steps
#
# controls (counted):
#   an unedited scratch workflow
#   a uses step before the app Test step
#   an if-guarded run step before the app Test step
#   an if-guarded run step before the scripts capture step
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD=ci-covers-packages.test.sh

pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

scratch() {
    local dir name pkg
    dir=$(mktemp -d)
    mkdir -p "$dir/scripts" "$dir/.github/workflows"
    cp "$ROOT/scripts/$GUARD" "$dir/scripts/$GUARD"
    cp "$ROOT/.github/workflows/ci.yml" "$dir/.github/workflows/ci.yml"
    for pkg in "$ROOT"/*/package.json; do
        name=$(basename "$(dirname "$pkg")")
        [ "$name" = "node_modules" ] && continue
        mkdir -p "$dir/$name"
        cp "$pkg" "$dir/$name/package.json"
    done
    printf '%s' "$dir"
}

edit_workflow() {
    python3 - "$1/.github/workflows" "$2" <<'PY'
import sys
wfdir, mode = sys.argv[1], sys.argv[2]
path = wfdir + "/ci.yml"
s = open(path).read()

def between(capture_line, proof_name, step):
    global s
    old = capture_line + "      - name: " + proof_name + "\n"
    assert s.count(old) == 1, old
    s = s.replace(old, capture_line + step + "      - name: " + proof_name + "\n", 1)

def before(anchor, step):
    global s
    assert s.count(anchor) == 1, anchor
    s = s.replace(anchor, step + anchor, 1)

def job_block(name, following):
    start = s.index("\n  " + name + ":\n") + 1
    end = s.index("\n  " + following + ":\n", start) + 1
    return start, end

def reusable(name, following, called):
    global s
    start, end = job_block(name, following)
    block = s[start:end]
    s = s[:start] + "  " + name + ":\n    uses: ./.github/workflows/" + name + "-tests.yml\n\n" + s[end:]
    steps = block[block.index("    steps:\n"):]
    open(wfdir + "/" + name + "-tests.yml", "w").write(
        "name: " + name + " tests\non:\n  workflow_call:\njobs:\n  " + name + ":\n"
        "    runs-on: ubuntu-latest\n" + steps.replace(called[0], called[0] + called[1], 1))

app_capture = '          npm test 2>&1 | tee "$RUNNER_TEMP/ci-app-tests.txt"\n'
scripts_capture = '          make test-scripts 2>&1 | tee "$RUNNER_TEMP/ci-scripts-tests.txt"\n'
program_capture = '          make test 2>&1 | tee "$RUNNER_TEMP/ci-program-tests.txt"\n'
app_rewrite = '      - run: printf "# tests 999\\n" > "$RUNNER_TEMP/ci-app-tests.txt"\n'
scripts_rewrite = '      - run: yes "ok - forged" | head -300 > "$RUNNER_TEMP/ci-scripts-tests.txt"\n'

if mode == "between-app-if":
    between(app_capture, "Prove the app tests ran",
            '      - if: always()\n        run: printf "# tests 999\\n" > "$RUNNER_TEMP/ci-app-tests.txt"\n')
elif mode == "between-app-flow":
    between(app_capture, "Prove the app tests ran",
            '      - {run: printf "# tests 999\\n" > "$RUNNER_TEMP/ci-app-tests.txt"}\n')
elif mode == "between-program-if":
    between(program_capture, "Prove the program tests ran",
            '      - if: success()\n        run: echo "test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s" > "$RUNNER_TEMP/ci-program-tests.txt"\n')
elif mode == "reusable-app":
    reusable("app", "terminal", (app_capture, app_rewrite))
elif mode == "reusable-scripts":
    reusable("scripts", "app", (scripts_capture, scripts_rewrite))
elif mode == "before-app-uses":
    before("      - name: Test\n        run: |\n          set -o pipefail\n" + app_capture,
           "      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'\n")
elif mode == "before-app-if":
    before("      - name: Test\n        run: |\n          set -o pipefail\n" + app_capture,
           "      - if: runner.os == 'Linux'\n        run: echo setup\n")
elif mode == "before-scripts-if":
    before("      - name: Deploy-script checks\n        run: |\n          set -o pipefail\n" + scripts_capture,
           "      - if: runner.os == 'Linux'\n        run: echo setup\n")
else:
    sys.exit("unknown mode " + mode)
open(path, "w").write(s)
PY
}

guard_out=""
guard_status=0
run_guard() {
    guard_status=0
    guard_out=$("$1/scripts/$GUARD" 2>&1) || guard_status=$?
}

expect_refused() {
    local mode="$1" job="$2"
    local dir
    dir=$(scratch)
    if ! edit_workflow "$dir" "$mode"; then
        bad "could not apply $mode"
        rm -rf "$dir"
        return
    fi
    run_guard "$dir"
    echo "----- $mode -----"
    printf '%s\n' "$guard_out" | grep '^not ok' | sed -n '1,3p'
    printf '%s\n' "$guard_out" | tail -n 1
    if [ "$guard_status" -ne 0 ] && printf '%s\n' "$guard_out" | grep '^not ok' | grep "$job" >/dev/null; then
        ok "guard refuses $mode"
    else
        bad "guard accepts $mode (exit $guard_status): the capture-to-proof slot is open"
    fi
    rm -rf "$dir"
}

expect_accepted() {
    local mode="$1"
    local dir
    dir=$(scratch)
    if [ "$mode" != "unedited" ] && ! edit_workflow "$dir" "$mode"; then
        bad "could not apply $mode"
        rm -rf "$dir"
        return
    fi
    run_guard "$dir"
    echo "----- $mode -----"
    printf '%s\n' "$guard_out" | tail -n 1
    if [ "$guard_status" -eq 0 ]; then
        ok "guard accepts $mode"
    else
        bad "guard refuses $mode: $(printf '%s\n' "$guard_out" | grep '^not ok' | sed -n '1p')"
    fi
    rm -rf "$dir"
}

expect_refused between-app-if app
expect_refused between-app-flow app
expect_refused between-program-if program
expect_refused reusable-app app
expect_refused reusable-scripts scripts
expect_accepted unedited
expect_accepted before-app-uses
expect_accepted before-app-if
expect_accepted before-scripts-if

printf 'ci test-ran proof critic r2: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
