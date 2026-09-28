#!/usr/bin/env bash
# Run this from the repository root, on main, with a clean tree, immediately
# before publishing. It builds sdk/, asks the registry whether this version
# already exists (a 404 is "not published"), and checks the dry-run tarball.
# It prints the publish command. It does not publish.
#
#   ./scripts/sdk-publish-check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ROOT}/sdk"
PKG_JSON="${SDK}/package.json"

die() {
  printf 'sdk-publish-check: %s\n' "$1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "refusing: git is not on PATH"
command -v npm >/dev/null 2>&1 || die "refusing: npm is not on PATH"
command -v node >/dev/null 2>&1 || die "refusing: node is not on PATH"
[[ -f "$PKG_JSON" ]] || die "refusing: missing ${PKG_JSON}"

branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || die "refusing: git branch is ${branch}, publish from a clean main"

status="$(git -C "$ROOT" status --porcelain)"
[[ -z "$status" ]] || die "refusing: git working tree is not clean"

meta="$(node -e '
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const name = typeof doc.name === "string" ? doc.name : "";
const version = typeof doc.version === "string" ? doc.version : "";
const priv = doc.private === false ? "false" : String(doc.private);
process.stdout.write(name + "\n" + version + "\n" + priv + "\n");
' "$PKG_JSON")"
name="$(printf '%s\n' "$meta" | sed -n '1p')"
version="$(printf '%s\n' "$meta" | sed -n '2p')"
private_flag="$(printf '%s\n' "$meta" | sed -n '3p')"

[[ "$name" == "@veto-hq/agent-sdk" ]] || die "refusing: package name is ${name}, publish @veto-hq/agent-sdk"
[[ -n "$version" ]] || die "refusing: package version is empty"
[[ "$private_flag" == "false" ]] || die "refusing: package.json private is ${private_flag}, publish needs false"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sdk-publish-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

set +e
npm view "${name}@${version}" version >"$WORK/view.out" 2>"$WORK/view.err"
view_rc=$?
set -e
if [[ "$view_rc" -eq 0 ]]; then
  die "refusing: ${name}@${version} is already on the registry"
fi
if ! grep -q 'E404' "$WORK/view.err"; then
  cat "$WORK/view.err" >&2 || true
  die "refusing: npm view failed and it was not a 404"
fi

set +e
(
  cd "$SDK"
  npm run build
) >"$WORK/build.out" 2>"$WORK/build.err"
build_rc=$?
set -e
if [[ "$build_rc" -ne 0 ]]; then
  cat "$WORK/build.err" >&2 || true
  die "refusing: npm run build failed"
fi

# --ignore-scripts keeps the file list on stdout. Publish still runs
# prepublishOnly, which builds and tests, after this check has passed.
set +e
(
  cd "$SDK"
  npm pack --dry-run --json --ignore-scripts
) >"$WORK/pack.json" 2>"$WORK/pack.err"
pack_rc=$?
set -e
if [[ "$pack_rc" -ne 0 ]]; then
  cat "$WORK/pack.err" >&2 || true
  die "refusing: npm pack --dry-run failed"
fi

set +e
files="$(node -e '
const fs = require("fs");
const raw = fs.readFileSync(process.argv[1], "utf8");
const start = raw.search(/[\[{]/);
if (start < 0) {
  console.error("npm pack did not print JSON");
  process.exit(2);
}
let data;
try {
  data = JSON.parse(raw.slice(start));
} catch (err) {
  console.error("npm pack JSON did not parse");
  process.exit(2);
}
const doc = Array.isArray(data) ? data[0] : data;
if (!doc || !Array.isArray(doc.files)) {
  console.error("npm pack JSON has no files array");
  process.exit(2);
}
for (const entry of doc.files) {
  const path = typeof entry === "string" ? entry : entry && entry.path;
  if (typeof path !== "string" || path.length === 0) {
    console.error("npm pack JSON has a file with no path");
    process.exit(2);
  }
  process.stdout.write(path + "\n");
}
' "$WORK/pack.json")"
files_rc=$?
set -e
[[ "$files_rc" -eq 0 ]] || die "refusing: could not read the npm pack file list"
[[ -n "$files" ]] || die "refusing: dry-run tarball has no files"

# A listed path is allowed only as package.json (npm adds it), README.md,
# LICENSE, idl/, or dist/. A fixture is refused when its text contains an http(s) URL.
classify() {
  local rel="$1"
  local base
  local base_lower
  local lower
  local file
  base="$(basename "$rel")"
  base_lower="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
  lower="$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')"
  file="${SDK}/${rel}"

  case "$rel" in
    /*|../*|*/../*|..|*/..)
      printf 'tarball path escapes the package: %s' "$rel"
      return 1
      ;;
  esac

  if [[ "$base" == .env || "$base" == .env.* ]]; then
    printf '.env file %s' "$rel"
    return 1
  fi

  case "$base_lower" in
    *.test.ts|*.test.tsx|*.test.js|*.test.jsx|*.test.mjs|*.test.cjs|*.spec.ts|*.spec.tsx|*.spec.js|*.spec.jsx|*.spec.mjs|*.spec.cjs)
      printf 'test file %s' "$rel"
      return 1
      ;;
  esac

  case "$lower" in
    test/*|*/test/*|tests/*|*/tests/*|__tests__/*|*/__tests__/*)
      printf 'test file %s' "$rel"
      return 1
      ;;
  esac

  if printf '%s' "$lower" | grep -E 'api[-_]?key' >/dev/null; then
    printf 'file names an api key: %s' "$rel"
    return 1
  fi

  case "$base_lower" in
    *.pem|*.key|*.p12|*.pfx|id_rsa|id_dsa|id_ecdsa|id_ed25519)
      printf 'key file %s' "$rel"
      return 1
      ;;
  esac

  case "$lower" in
    keys/*|*/keys/*)
      printf 'key file %s' "$rel"
      return 1
      ;;
  esac

  if [[ "$base_lower" == *keypair* || "$base_lower" == *private-key* || "$base_lower" == *private_key* || "$base_lower" == *key* ]]; then
    printf 'key file %s' "$rel"
    return 1
  fi

  case "$rel" in
    package.json|README.md|LICENSE|idl/*|dist/*) ;;
    *)
      printf 'file outside dist, idl, README.md, and LICENSE: %s' "$rel"
      return 1
      ;;
  esac

  if [[ ! -f "$file" ]]; then
    printf 'listed file is not in the checkout: %s' "$rel"
    return 1
  fi

  if grep -E -i -q -a 'api[-_]?key|BEGIN (OPENSSH |RSA |EC )?PRIVATE KEY' "$file"; then
    printf 'file names an api key: %s' "$rel"
    return 1
  fi

  if printf '%s' "$lower" | grep -E 'fixture' >/dev/null; then
    if grep -E -i -q 'https?://' "$file"; then
      printf 'fixture with an RPC URL: %s' "$rel"
      return 1
    fi
  fi

  return 0
}

normalized=""
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  rel="$path"
  case "$rel" in
    package/*) rel="${rel#package/}" ;;
  esac
  reason=""
  if ! reason="$(classify "$rel")"; then
    die "refusing: ${reason}"
  fi
  normalized="${normalized}${rel}"$'\n'
done <<< "$files"

[[ -n "$normalized" ]] || die "refusing: dry-run tarball has no files"

require_listed() {
  local want="$1"
  if ! printf '%s\n' "$normalized" | grep -Fx "$want" >/dev/null; then
    die "refusing: tarball is missing ${want}"
  fi
}
require_listed "README.md"
require_listed "LICENSE"
require_listed "idl/veto.json"
require_listed "dist/index.js"
require_listed "package.json"

printf 'sdk-publish-check: %s@%s is not on the registry\n' "$name" "$version" >&2
printf 'tarball files:\n'
printf '%s' "$normalized"
printf 'cd sdk && npm publish --access public\n'
