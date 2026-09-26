#!/usr/bin/env bash
# PR 147 round 1 (issue 108). The count proof reads a log file. A step that
# sits between the capture step and the proof step can rewrite that file,
# and that step is in the workflow as written, so it is inside the guard's
# reach. The guard accepts it today: with
#   - run: printf "# tests 999\n" > "$RUNNER_TEMP/ci-app-tests.txt"
# between the app Test step and "Prove the app tests ran", the guard reports
# 20 passed, 0 failed, and the proof step would print "app: 999 tests".
#
# must-reject (counted):
#   a run step between the app capture and proof steps
#   a uses step in the same position
#   a run step between the scripts capture and proof steps
#   a run step between the program capture and proof steps
#
# controls (counted):
#   an unedited scratch workflow
#   a run step before the app Test step (setup steps are legitimate)
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
    python3 - "$1/.github/workflows/ci.yml" "$2" <<'PY'
import sys
path, mode = sys.argv[1], sys.argv[2]
s = open(path).read()

def between(capture_line, proof_name, step):
    global s
    old = capture_line + "      - name: " + proof_name + "\n"
    assert s.count(old) == 1, old
    s = s.replace(old, capture_line + step + "      - name: " + proof_name + "\n", 1)

app_capture = '          npm test 2>&1 | tee "$RUNNER_TEMP/ci-app-tests.txt"\n'
scripts_capture = '          make test-scripts 2>&1 | tee "$RUNNER_TEMP/ci-scripts-tests.txt"\n'
program_capture = '          make test 2>&1 | tee "$RUNNER_TEMP/ci-program-tests.txt"\n'

if mode == "between-app-run":
    between(app_capture, "Prove the app tests ran",
            '      - run: printf "# tests 999\\n" > "$RUNNER_TEMP/ci-app-tests.txt"\n')
elif mode == "between-app-uses":
    between(app_capture, "Prove the app tests ran",
            "      - uses: ./.github/actions/prep\n")
elif mode == "between-scripts-run":
    between(scripts_capture, "Prove the scripts tests ran",
            '      - run: yes "ok - forged" | head -300 > "$RUNNER_TEMP/ci-scripts-tests.txt"\n')
elif mode == "between-program-run":
    between(program_capture, "Prove the program tests ran",
            '      - run: echo "test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s" > "$RUNNER_TEMP/ci-program-tests.txt"\n')
elif mode == "before-app-test":
    tc = ("      - run: npm run typecheck\n"
          "      # The suite ran only on developer machines until now")
    assert s.count(tc) == 1, "app typecheck anchor"
    s = s.replace(tc, "      - run: npm run typecheck\n      - run: echo setup\n"
                      "      # The suite ran only on developer machines until now", 1)
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
        bad "guard accepts $mode (exit $guard_status): a step between the capture and the proof can rewrite the log"
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

expect_refused between-app-run app
expect_refused between-app-uses app
expect_refused between-scripts-run scripts
expect_refused between-program-run program
expect_accepted unedited
expect_accepted before-app-test

printf 'ci test-ran proof critic r1: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
