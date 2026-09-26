#!/usr/bin/env bash
# Critic fixture, PR 102 round 2. The guard at 37b2da9 refuses a paths or
# paths-ignore key on any trigger instead of matching the glob. This fixture
# asks two things of that refusal.
#
# must-reject (counted): the refusal must not depend on how the key is
# written. A flow map, a quoted key, the key on the push trigger, and an
# empty list are all the same key.
#
# counted rejections, any failure reason: ways to leave a package's checks
# unrun on a pull request that are not a paths key. The edit text is unchanged.
#   esc-pr-target        pull_request_target in place of pull_request, so
#                        the checks run against the base branch's code
#   esc-job-shell-noop   a job-level defaults.run.shell of bash -n, which
#                        parses every run: step and executes none of it
#   esc-job-env-npm      a job-level env npm_config_script_shell of
#                        /usr/bin/true, so npm test spawns nothing
#   esc-wf-env-npm       the same env at workflow level, every job at once
#   esc-alias-trigger    the pull_request body is a YAML alias to an anchor
#                        that carries paths-ignore; the guard reads a string
#   esc-alias-flow       the same alias, anchor on a flow map the parser
#                        survives; whether GitHub honours it is not checked here
#   esc-br-zz-glob       push and pull_request both name zz-*; documents the
#                        stricter branch handling after the placeholder fix
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD=ci-covers-packages.test.sh

pass=0; fail=0
ok()   { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

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

trigger = 'on:\n  push:\n    branches: [main]\n  pull_request:\n'
app_head = '  app:\n    runs-on: ubuntu-latest\n'
app_wd = '        working-directory: app\n'
name_line = 'name: ci\n'
for needle in (trigger, app_head, app_wd, name_line):
    assert s.count(needle) == 1, (mode, needle)

def under_pr(extra):
    return s.replace(trigger, trigger + extra)

def whole(new):
    return s.replace(trigger, new)

def once(old, new):
    return s.replace(old, new)

edits = {
    # the same key, written four other ways
    'paths-flow-map':      whole('on:\n  push:\n    branches: [main]\n  pull_request: {paths-ignore: ["app/src/**"]}\n'),
    'paths-quoted-key':    under_pr('    "paths-ignore": ["app/src/**"]\n'),
    'paths-on-push':       whole('on:\n  push:\n    branches: [main]\n    paths-ignore: ["app/src/**"]\n  pull_request:\n'),
    'paths-empty-list':    under_pr('    paths: []\n'),
    # not a paths key
    'esc-pr-target':       whole('on:\n  push:\n    branches: [main]\n  pull_request_target:\n'),
    'esc-job-shell-noop':  once(app_wd, app_wd + '        shell: bash -n {0}\n'),
    'esc-job-env-npm':     once(app_head, app_head + '    env:\n      npm_config_script_shell: /usr/bin/true\n'),
    'esc-wf-env-npm':      once(name_line, name_line + 'env:\n  npm_config_script_shell: /usr/bin/true\n'),
    'esc-alias-trigger':   whole('') .replace(app_head, app_head + '    strategy:\n      matrix: &pr\n        paths-ignore: ["app/src/**"]\n')
                           + 'on:\n  push:\n    branches: [main]\n  pull_request: *pr\n',
    'esc-alias-flow':      whole('') .replace(app_head, app_head + '    strategy:\n      matrix: &pr {paths-ignore: ["app/src/**"]}\n')
                           + 'on:\n  push:\n    branches: [main]\n  pull_request: *pr\n',
    'esc-br-zz-glob':      whole('on:\n  push:\n    branches: ["zz-*"]\n  pull_request:\n    branches: ["zz-*"]\n'),
}
if mode not in edits:
    sys.exit('unknown mode ' + mode)
open(path, 'w').write(edits[mode])
PY
}

guard_reason() {
    "$1/scripts/$GUARD" 2>/dev/null | grep '^not ok' | sed -n '1p'
}

guard_passes() {
    "$1/scripts/$GUARD" >/dev/null 2>&1
}

MUST_REJECT="paths-flow-map paths-quoted-key paths-on-push paths-empty-list"
INFO_ESCAPE="esc-pr-target esc-job-shell-noop esc-job-env-npm esc-wf-env-npm esc-alias-trigger esc-alias-flow esc-br-zz-glob"

for mode in $MUST_REJECT; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        bad "guard stays green with $mode; the paths refusal depends on how the key is written"
    else
        case "$(guard_reason "$dir")" in
            *"declares a paths filter"*) ok "guard refuses $mode as a paths filter" ;;
            *) bad "guard fails with $mode for another reason: $(guard_reason "$dir")" ;;
        esac
    fi
    rm -rf "$dir"
done

for mode in $INFO_ESCAPE; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        bad "guard stays green with $mode; a construct that can stop a check is still allowed"
    else
        ok "guard fails with $mode"
    fi
    rm -rf "$dir"
done

dir=$(scratch)
if guard_passes "$dir"; then
    ok "unedited scratch copy passes the guard (control)"
else
    bad "unedited scratch copy fails the guard"
fi
rm -rf "$dir"

printf 'ci coverage critic r5 checks: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
