#!/usr/bin/env bash
# Issue 108. The coverage guard stays green for a step that writes
# npm_config_script_shell into GITHUB_ENV, a step that writes .npmrc, a
# composite action, and a container image. Those four change the run after
# the workflow file was read. The count proof is what fails them: npm test
# exits 0 and the runner log has no test summary.
#
# The fifth row is a strategy key on a check job. That key is inside the
# guard's reach, so the guard refuses it.
#
# must-reject (counted):
#   the five rows above
#   a quoted strategy key, and strategy on the program and scripts jobs
#   parser samples: zero, a missing summary, a count below the floor,
#   ignored cargo tests left out of the count
#
# controls (counted):
#   a real node summary, a real cargo total, shell "ok - " lines
#   strategy on watcher-image only (not a check job)
#   an unedited scratch workflow
#   a tiny package whose tests actually run
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD=ci-covers-packages.test.sh
ASSERT="$ROOT/scripts/ci-assert-test-count.sh"

pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
[ -x "$ASSERT" ] || { echo "missing executable $ASSERT" >&2; exit 1; }

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
app = "  app:\n    runs-on: ubuntu-latest\n"
program = "  program:\n    runs-on: ubuntu-latest\n"
scripts = "  scripts:\n    runs-on: ubuntu-latest\n"
image = "  watcher-image:\n    runs-on: ubuntu-latest\n"
tc = "      - run: npm run typecheck\n"

def insert_before_app_typecheck(step):
    global s
    i = s.index(tc)
    s = s[:i] + step + s[i:]

if mode == "step-writes-env":
    insert_before_app_typecheck(
        '      - run: echo "npm_config_script_shell=/usr/bin/true" >> "$GITHUB_ENV"\n'
    )
elif mode == "step-writes-npmrc":
    insert_before_app_typecheck(
        "      - run: echo script-shell=/usr/bin/true > .npmrc\n"
    )
elif mode == "composite-action":
    insert_before_app_typecheck("      - uses: ./.github/actions/prep\n")
elif mode == "container-image":
    assert s.count(app) == 1
    s = s.replace(app, app + "    container: {image: node:22}\n", 1)
elif mode == "matrix-exclude-all":
    assert s.count(app) == 1
    s = s.replace(
        app,
        app + "    strategy: {matrix: {n: [1], exclude: [{n: 1}]}}\n",
        1,
    )
elif mode == "strategy-quoted":
    assert s.count(app) == 1
    s = s.replace(app, app + '    "strategy": {matrix: {n: [1]}}\n', 1)
elif mode == "strategy-program":
    assert s.count(program) == 1
    s = s.replace(program, program + "    strategy: {matrix: {n: [1]}}\n", 1)
elif mode == "strategy-scripts":
    assert s.count(scripts) == 1
    s = s.replace(scripts, scripts + "    strategy: {matrix: {n: [1]}}\n", 1)
elif mode == "strategy-image":
    assert s.count(image) == 1
    s = s.replace(
        image,
        image + "    strategy: {matrix: {n: [1], exclude: [{n: 1}]}}\n",
        1,
    )
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

assert_out=""
assert_status=0
run_assert() {
    assert_status=0
    assert_out=$("$ASSERT" "$@" 2>&1) || assert_status=$?
}

unit_log() {
    python3 - "$1" "$2" <<'PY'
import sys
path, mode = sys.argv[1], sys.argv[2]
samples = {
    "tap": "# tests 2\n# pass 2\n",
    "zero": "# tests 0\n",
    "spec": "\u2139 tests 2\n",
    "ansi": "\x1b[34m# tests 2\x1b[39m\n",
    "below": "# tests 1\n",
    "cargo": (
        "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"
        "test result: ok. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.84s\n"
        "test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.04s\n"
        "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"
    ),
    "ignored": "test result: ok. 2 passed; 0 failed; 5 ignored; 0 measured; 0 filtered out; finished in 0.01s\n",
    "shell": "ok - one\nok - two\nnot ok - three\n",
    "empty": "",
}
if mode not in samples:
    sys.exit("bad mode " + mode)
open(path, "w", encoding="utf-8").write(samples[mode])
PY
}

echo "===== parser ====="
unit_floors=$(mktemp)
cat > "$unit_floors" <<'EOF'
tap node 2
cargo cargo 26
ignored cargo 2
shell shell 2
EOF

expect_count() {
    local name="$1" mode="$2" want="$3"
    local log
    log=$(mktemp)
    unit_log "$log" "$mode" || { bad "could not write $mode log"; rm -f "$log"; return; }
    run_assert "$name" "$log" "$unit_floors"
    printf 'job: %s\n' "$assert_out"
    if [ "$assert_status" -eq 0 ] && printf '%s\n' "$assert_out" | grep -x "$want" >/dev/null; then
        ok "$mode parses as $want"
    else
        bad "$mode parsed as '$assert_out' (exit $assert_status), wanted $want"
    fi
    rm -f "$log"
}

expect_below() {
    local name="$1" mode="$2"
    local log
    log=$(mktemp)
    unit_log "$log" "$mode" || { bad "could not write $mode log"; rm -f "$log"; return; }
    run_assert "$name" "$log" "$unit_floors"
    printf 'job: %s\n' "$assert_out"
    if [ "$assert_status" -ne 0 ] && printf '%s\n' "$assert_out" | grep 'tests is below the floor' >/dev/null; then
        ok "$mode is below the floor"
    else
        bad "$mode was accepted: $assert_out"
    fi
    rm -f "$log"
}

expect_count tap tap "tap: 2 tests (floor 2)"
expect_count tap spec "tap: 2 tests (floor 2)"
expect_count tap ansi "tap: 2 tests (floor 2)"
expect_count cargo cargo "cargo: 26 tests (floor 26)"
expect_count ignored ignored "ignored: 2 tests (floor 2)"
expect_count shell shell "shell: 2 tests (floor 2)"
expect_below tap zero
expect_below tap below
expect_below tap empty
expect_below cargo empty
expect_below shell empty
rm -f "$unit_floors"

echo "===== strategy ====="
expect_strategy_refused() {
    local mode="$1"
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
    if [ "$guard_status" -ne 0 ] && printf '%s\n' "$guard_out" | grep 'strategy disables the check' >/dev/null; then
        ok "guard refuses $mode"
    else
        bad "guard does not refuse $mode (exit $guard_status)"
    fi
    rm -rf "$dir"
}

expect_strategy_refused matrix-exclude-all
expect_strategy_refused strategy-quoted
expect_strategy_refused strategy-program
expect_strategy_refused strategy-scripts

dir=$(scratch)
edit_workflow "$dir" strategy-image
run_guard "$dir"
echo "----- strategy-image (not a check job) -----"
printf '%s\n' "$guard_out" | tail -n 1
if [ "$guard_status" -eq 0 ]; then
    ok "guard accepts strategy on watcher-image"
else
    bad "guard refuses strategy on watcher-image: $(printf '%s\n' "$guard_out" | grep '^not ok' | sed -n '1p')"
fi
rm -rf "$dir"

dir=$(scratch)
run_guard "$dir"
echo "----- unedited -----"
printf '%s\n' "$guard_out" | tail -n 1
if [ "$guard_status" -eq 0 ]; then
    ok "unedited scratch copy passes the guard"
else
    bad "unedited scratch copy fails: $(printf '%s\n' "$guard_out" | grep '^not ok' | sed -n '1p')"
fi
rm -rf "$dir"

tiny_package() {
    local dir
    dir=$(mktemp -d)
    cat > "$dir/package.json" <<'JSON'
{
  "name": "demo",
  "private": true,
  "scripts": {
    "test": "node --test test.js"
  }
}
JSON
    cat > "$dir/test.js" <<'JS'
const test = require("node:test");
test("the suite ran", () => {});
JS
    printf '%s' "$dir"
}

demo_floors=$(mktemp)
printf 'demo node 1\n' > "$demo_floors"

run_npm() {
    local dir="$1"
    npm_status=0
    (
        cd "$dir" || exit 97
        set -o pipefail
        npm test 2>&1 | tee "$npm_log"
    ) || npm_status=$?
}

echo "===== run-time rows ====="
for mode in step-writes-env step-writes-npmrc composite-action container-image; do
    echo "----- $mode -----"
    dir=$(scratch)
    if ! edit_workflow "$dir" "$mode"; then
        bad "could not apply $mode to the scratch workflow"
        rm -rf "$dir"
        continue
    fi
    if [ "$mode" = "composite-action" ]; then
        mkdir -p "$dir/.github/actions/prep"
        cat > "$dir/.github/actions/prep/action.yml" <<'YAML'
name: prep
description: point npm scripts at true
runs:
  using: composite
  steps:
    - shell: bash
      run: echo "npm_config_script_shell=/usr/bin/true" >> "$GITHUB_ENV"
YAML
    fi
    run_guard "$dir"
    printf '%s\n' "$guard_out" | tail -n 1
    if [ "$guard_status" -eq 0 ]; then
        ok "guard stays green with $mode"
    else
        bad "guard went red with $mode: $(printf '%s\n' "$guard_out" | grep '^not ok' | sed -n '1p')"
    fi
    rm -rf "$dir"

    pkg=$(tiny_package)
    npm_log=$(mktemp)
    log_dir=""
    case "$mode" in
        step-writes-env)
            (
                cd "$pkg" || exit 97
                export npm_config_script_shell=/usr/bin/true
                set -o pipefail
                npm test 2>&1 | tee "$npm_log"
            ) || npm_status=$?
            npm_status=${npm_status:-0}
            ;;
        step-writes-npmrc)
            printf 'script-shell=/usr/bin/true\n' > "$pkg/.npmrc"
            run_npm "$pkg"
            ;;
        composite-action)
            (
                cd "$pkg" || exit 97
                export GITHUB_ENV="$pkg/github.env"
                : > "$GITHUB_ENV"
                echo "npm_config_script_shell=/usr/bin/true" >> "$GITHUB_ENV"
                set -a
                # shellcheck disable=SC1090
                . "$GITHUB_ENV"
                set +a
                set -o pipefail
                npm test 2>&1 | tee "$npm_log"
            ) || npm_status=$?
            npm_status=${npm_status:-0}
            ;;
        container-image)
            image_dir=$(mktemp -d)
            cat > "$image_dir/Dockerfile" <<'DOCKER'
FROM alpine:3.20
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/npm && chmod +x /usr/local/bin/npm
DOCKER
            build_log=$(mktemp)
            if ! docker build -t veto-ci-count-proof:npm-true "$image_dir" >"$build_log" 2>&1; then
                echo "docker build failed:"
                sed -n '1,40p' "$build_log"
                rm -f "$build_log"
                bad "could not build the scratch image whose npm exits 0"
                rm -rf "$pkg" "$image_dir"
                rm -f "$npm_log"
                continue
            fi
            rm -f "$build_log"
            rm -rf "$image_dir"
            # The runner's temp file is mode 600. A container user cannot tee
            # onto that mount. A directory it can create in is enough.
            log_dir=$(mktemp -d)
            chmod 777 "$log_dir"
            rm -f "$npm_log"
            npm_log="$log_dir/out.txt"
            docker_err=$(mktemp)
            npm_status=0
            docker run --rm -v "$pkg:/work" -w /work -v "$log_dir:/logs" \
                veto-ci-count-proof:npm-true \
                sh -c 'npm test > /logs/out.txt 2>&1' \
                >"$docker_err" 2>&1 || npm_status=$?
            if [ "$npm_status" -ne 0 ]; then
                echo "docker run failed:"
                sed -n '1,40p' "$docker_err"
            fi
            rm -f "$docker_err"
            ;;
    esac
    printf 'npm_exit: %s\n' "$npm_status"
    echo "log:"
    sed -n '1,30p' "$npm_log"
    if [ "$npm_status" -ne 0 ]; then
        bad "$mode: npm test exited $npm_status, so the escape did not swallow the script"
    else
        ok "$mode: npm test exited 0"
    fi
    if grep -q 'the suite ran' "$npm_log"; then
        bad "$mode: the test script ran"
    else
        ok "$mode: the test script did not run"
    fi
    run_assert demo "$npm_log" "$demo_floors"
    printf 'job: %s\n' "$assert_out"
    if [ "$assert_status" -ne 0 ] && printf '%s\n' "$assert_out" | grep '0 tests is below the floor' >/dev/null; then
        ok "$mode: the count proof fails"
    else
        bad "$mode: the count proof did not fail: $assert_out"
    fi
    rm -rf "$pkg"
    rm -f "$npm_log"
    if [ -n "$log_dir" ]; then
        rm -rf "$log_dir"
    fi
    unset npm_status
done

echo "----- control: tests actually run -----"
pkg=$(tiny_package)
npm_log=$(mktemp)
run_npm "$pkg"
printf 'npm_exit: %s\n' "$npm_status"
echo "log:"
sed -n '1,30p' "$npm_log"
if [ "$npm_status" -eq 0 ] && grep -q 'the suite ran' "$npm_log"; then
    ok "control: the test script ran and npm test exited 0"
else
    bad "control: npm test did not run the suite (exit $npm_status)"
fi
run_assert demo "$npm_log" "$demo_floors"
printf 'job: %s\n' "$assert_out"
if [ "$assert_status" -eq 0 ]; then
    ok "control: the count proof passes"
else
    bad "control: the count proof failed: $assert_out"
fi
rm -rf "$pkg"
rm -f "$npm_log" "$demo_floors"
docker rmi veto-ci-count-proof:npm-true >/dev/null 2>&1 || true

printf 'ci test-ran proof: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
