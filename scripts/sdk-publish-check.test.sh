#!/usr/bin/env bash
# Static checks for scripts/sdk-publish-check.sh.
# No network, no registry, no npm publish. git and npm are fakes on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT}/scripts/sdk-publish-check.sh"
NODE_DIR="$(dirname "$(command -v node)")"

pass=0
fail=0
CASE=""
rc=0

ok() { printf 'ok - %s\n' "$1"; pass=$((pass + 1)); }
bad() {
  printf 'not ok - %s\n' "$1"
  fail=$((fail + 1))
  if [[ -n "$CASE" && -f "$CASE/stderr" ]]; then
    sed 's/^/    /' "$CASE/stderr"
  fi
}

CASES=()
cleanup() {
  if [[ ${#CASES[@]} -gt 0 ]]; then
    rm -rf "${CASES[@]}"
  fi
}
trap cleanup EXIT

[[ -f "$SRC" ]] || { echo "missing $SRC"; exit 1; }

stage() {
  CASE="$(mktemp -d "${TMPDIR:-/tmp}/sdk-publish-check-test.XXXXXX")"
  CASES+=("$CASE")
  mkdir -p "$CASE/scripts" "$CASE/sdk/dist/fixtures" "$CASE/sdk/idl" "$CASE/bin"
  cp "$SRC" "$CASE/scripts/sdk-publish-check.sh"
  chmod +x "$CASE/scripts/sdk-publish-check.sh"
  cat >"$CASE/sdk/package.json" <<'EOF'
{
  "name": "@veto-hq/agent-sdk",
  "version": "0.1.0",
  "private": false
}
EOF
  printf 'readme\n' >"$CASE/sdk/README.md"
  printf 'license\n' >"$CASE/sdk/LICENSE"
  printf '{}\n' >"$CASE/sdk/idl/veto.json"
  printf 'export {}\n' >"$CASE/sdk/dist/index.js"
  printf '{"ok":true}\n' >"$CASE/sdk/dist/fixtures/plain.json"

  cat >"$CASE/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_GIT_LOG}"
if [[ "$*" == *rev-parse* ]]; then
  printf '%s\n' "${FAKE_GIT_BRANCH:-main}"
  exit 0
fi
if [[ "$*" == *status* ]]; then
  if [[ -n "${FAKE_GIT_STATUS:-}" ]]; then
    printf '%s\n' "${FAKE_GIT_STATUS}"
  fi
  exit 0
fi
printf 'unexpected git: %s\n' "$*" >&2
exit 1
EOF

  cat >"$CASE/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_NPM_LOG}"
if [[ "$1" == "view" ]]; then
  case "${FAKE_NPM_VIEW:-404}" in
    404)
      printf '%s\n' 'npm error code E404' 'npm error 404 Not Found - GET https://registry.npmjs.org/@veto-hq/agent-sdk' >&2
      exit 1
      ;;
    published)
      printf '%s\n' '0.1.0'
      exit 0
      ;;
    *)
      printf '%s\n' 'npm error code ECONNREFUSED' >&2
      exit 1
      ;;
  esac
fi
if [[ "$1" == "run" && "${2:-}" == "build" ]]; then
  exit 0
fi
if [[ "$1" == "pack" ]]; then
  cat "${FAKE_NPM_PACK}"
  exit 0
fi
if [[ "$1" == "publish" ]]; then
  printf 'publish was invoked\n'
  exit 0
fi
printf 'unexpected npm: %s\n' "$*" >&2
exit 1
EOF
  chmod +x "$CASE/bin/git" "$CASE/bin/npm"

  FAKE_GIT_BRANCH=main
  FAKE_GIT_STATUS=
  FAKE_NPM_VIEW=404
  write_pack \
    README.md \
    LICENSE \
    idl/veto.json \
    package.json \
    dist/index.js \
    dist/fixtures/plain.json
}

write_pack() {
  local first=1
  local path
  {
    printf '%s\n' '[' '  {"files":['
    for path in "$@"; do
      if [[ "$first" -eq 0 ]]; then
        printf ',\n'
      fi
      first=0
      printf '    {"path":"%s","size":1,"mode":420}' "$path"
    done
    printf '\n  ]}\n]\n'
  } >"$CASE/pack.json"
}

run_check() {
  : >"$CASE/npm.log"
  : >"$CASE/git.log"
  set +e
  PATH="${CASE}/bin:${NODE_DIR}:/usr/bin:/bin" \
    FAKE_GIT_BRANCH="$FAKE_GIT_BRANCH" \
    FAKE_GIT_STATUS="$FAKE_GIT_STATUS" \
    FAKE_GIT_LOG="$CASE/git.log" \
    FAKE_NPM_VIEW="$FAKE_NPM_VIEW" \
    FAKE_NPM_LOG="$CASE/npm.log" \
    FAKE_NPM_PACK="$CASE/pack.json" \
    "$CASE/scripts/sdk-publish-check.sh" >"$CASE/stdout" 2>"$CASE/stderr"
  rc=$?
  set -e
}

assert_refuses() {
  local name="$1"
  local needle="$2"
  run_check
  if [[ "$rc" -eq 0 ]]; then
    bad "$name"
    return
  fi
  if ! grep -q "$needle" "$CASE/stderr"; then
    bad "$name"
    return
  fi
  if grep -q 'npm publish' "$CASE/stdout"; then
    bad "$name"
    return
  fi
  ok "$name"
}

stage
FAKE_GIT_BRANCH='chore/sdk-release-pr'
assert_refuses "refuses a branch that is not main" "publish from a clean main"

stage
FAKE_GIT_STATUS=' M sdk/package.json'
assert_refuses "refuses a dirty working tree" "working tree is not clean"

stage
node -e '
const fs = require("fs");
const path = process.argv[1];
const doc = JSON.parse(fs.readFileSync(path, "utf8"));
doc.name = "veto-agent-sdk";
fs.writeFileSync(path, JSON.stringify(doc));
' "$CASE/sdk/package.json"
assert_refuses "refuses a package name other than @veto-hq/agent-sdk" "@veto-hq/agent-sdk"

stage
node -e '
const fs = require("fs");
const path = process.argv[1];
const doc = JSON.parse(fs.readFileSync(path, "utf8"));
doc.private = true;
fs.writeFileSync(path, JSON.stringify(doc));
' "$CASE/sdk/package.json"
assert_refuses "refuses a private package" "private is true"

stage
FAKE_NPM_VIEW=published
assert_refuses "refuses a version already on the registry" "already on the registry"

stage
FAKE_NPM_VIEW=error
assert_refuses "refuses an npm view failure that is not a 404" "not a 404"

stage
write_pack README.md LICENSE idl/veto.json package.json dist/index.js .env
assert_refuses "refuses a tarball that contains an env file" ".env file"

stage
write_pack README.md LICENSE idl/veto.json package.json dist/index.js dist/agent.test.js
assert_refuses "refuses a tarball that contains a test file" "test file"

stage
write_pack README.md LICENSE idl/veto.json package.json dist/index.js keys/agent.json
assert_refuses "refuses a tarball that contains a key file" "key file"

stage
write_pack README.md LICENSE idl/veto.json package.json dist/index.js dist/api_key.txt
assert_refuses "refuses a tarball file that names an api key" "names an api key"

stage
printf 'const leaked = "api-key=abc";\n' >"$CASE/sdk/dist/note.js"
write_pack README.md LICENSE idl/veto.json package.json dist/index.js dist/note.js
assert_refuses "refuses a packed file whose text names an api key" "names an api key"

stage
printf '{"rpcUrl":"https://api.devnet.solana.com"}\n' >"$CASE/sdk/dist/fixtures/endpoint.json"
write_pack README.md LICENSE idl/veto.json package.json dist/index.js dist/fixtures/endpoint.json
assert_refuses "refuses a fixture that contains an RPC URL" "fixture with an RPC URL"

stage
write_pack README.md LICENSE idl/veto.json package.json dist/index.js src/extra.md
assert_refuses "refuses a file outside dist, idl, README.md, and LICENSE" "outside dist, idl, README.md, and LICENSE"

stage
write_pack README.md idl/veto.json package.json dist/index.js
assert_refuses "refuses a tarball without LICENSE" "missing LICENSE"

stage
run_check
if [[ "$rc" -ne 0 ]]; then
  bad "prints the publish command when main is clean and the version is free"
else
  if grep -Fxq 'cd sdk && npm publish --access public' "$CASE/stdout" \
    && grep -Fxq 'dist/fixtures/plain.json' "$CASE/stdout" \
    && grep -q 'view ' "$CASE/npm.log" \
    && grep -q 'run build' "$CASE/npm.log" \
    && grep -q 'pack ' "$CASE/npm.log" \
    && ! grep -Eq '^publish($| )' "$CASE/npm.log"; then
    ok "prints the publish command when main is clean and the version is free"
  else
    bad "prints the publish command when main is clean and the version is free"
    printf '    stdout:\n'
    sed 's/^/    /' "$CASE/stdout"
    printf '    npm log:\n'
    sed 's/^/    /' "$CASE/npm.log"
  fi
fi

if grep -n 'npm publish' "$SRC" | grep -v 'cd sdk && npm publish --access public' | grep -v ':[[:space:]]*#' >/dev/null; then
  bad "the check script does not run npm publish"
else
  ok "the check script does not run npm publish"
fi

printf 'sdk-publish-check: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
