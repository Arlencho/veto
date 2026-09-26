#!/usr/bin/env bash
# Round 3: the runtime image runs compiled JavaScript, ships no build-only
# toolchain, and carries no key, endpoint, program id, mint, or account in
# its environment or a baked .env.
set -euo pipefail

IMAGE="${IMAGE:-veto-watcher:critic-r3}"
fail=0
pass() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "missing image ${IMAGE}; build it first (docker build -t ${IMAGE} watcher)"
  exit 1
fi

meta="$(docker inspect "$IMAGE" --format 'User={{.Config.User}} Cmd={{json .Config.Cmd}} Env={{json .Config.Env}}')"
printf '%s\n' "$meta"

if printf '%s' "$meta" | grep 'User=veto' >/dev/null; then
  pass "runtime user is veto"
else
  bad "runtime user is not veto: ${meta}"
fi

if printf '%s' "$meta" | grep 'Cmd=\["node","dist/index.js","once"\]' >/dev/null; then
  pass "CMD is node dist/index.js once (compiled JavaScript)"
else
  bad "CMD is not compiled JS once: ${meta}"
fi

if printf '%s' "$meta" | grep -E 'VETO_|AGENT_KEY|PRIVATE|SECRET' >/dev/null; then
  bad "image env contains a key, secret, or VETO_ identity: ${meta}"
else
  pass "image env has no VETO_ identity, key, or secret"
fi

if out="$(docker run --rm --user veto --entrypoint sh "$IMAGE" -c 'ls /app/node_modules | grep -E "^(typescript|@types|tsx)$"' 2>/dev/null)"; then
  bad "build-only toolchain still in node_modules: ${out}"
else
  pass "node_modules has no typescript, @types, or tsx"
fi

if docker run --rm --user veto --entrypoint sh "$IMAGE" -c \
  'if command -v tsc >/dev/null 2>&1; then exit 1; fi'; then
  pass "tsc is not a working binary on PATH"
else
  bad "tsc is still on PATH in the runtime image"
fi

if docker run --rm --user veto --entrypoint sh "$IMAGE" -c 'test -f /app/dist/index.js && test ! -e /app/src && test ! -e /app/tsconfig.json'; then
  pass "runtime has dist/index.js and no src or tsconfig"
else
  bad "runtime is missing dist/index.js or still has source/tsconfig"
fi

if head_out="$(docker run --rm --user veto --entrypoint sh "$IMAGE" -c 'head -8 /app/dist/index.js')" \
  && printf '%s' "$head_out" | grep 'from "node:fs"' >/dev/null \
  && printf '%s' "$head_out" | grep 'from "./cadence.js"' >/dev/null; then
  pass "dist/index.js is compiled JavaScript"
else
  bad "dist/index.js is not compiled JavaScript: ${head_out-}"
fi

if docker run --rm --user veto --entrypoint sh "$IMAGE" -c \
  'if /app/node_modules/.bin/tsc -v >/dev/null 2>&1; then exit 1; fi; if test -d /app/node_modules/typescript; then exit 1; fi'; then
  pass "typescript package is gone and tsc does not run"
else
  bad "typescript compiler still runs or the package directory is present"
fi

if env_files="$(docker run --rm --user veto --entrypoint sh "$IMAGE" -c 'ls -d /app/.env /app/.env.* 2>/dev/null' || true)" \
  && [[ -z "${env_files}" ]]; then
  pass "runtime has no .env file"
else
  bad "runtime still has a .env file: ${env_files}"
fi

# Grep the image filesystem for a private-key JSON array, a baked RPC, and
# identity env files. The bundled IDL address and public program constants
# are expected; a keypair array or a .env is not.
hits="$(docker run --rm --user veto --entrypoint sh "$IMAGE" -c '
  grep -R --binary-files=without-match -nE "\\[0, 0, 0, 0|BEGIN (OPENSSH|PRIVATE)|VETO_RPC=|VETO_AGENT_KEY|id.json" /app 2>/dev/null | sed -n "1,50p" || true
')"
if [[ -n "$hits" ]]; then
  bad "image grep found a key or baked identity: ${hits}"
else
  pass "image grep found no keypair, private key, or baked VETO_RPC"
fi

set +e
run_out="$(docker run --rm "$IMAGE" 2>&1)"
run_exit=$?
set -e
if [[ "$run_exit" -eq 1 ]] && printf '%s' "$run_out" | grep 'missing VETO_RPC' >/dev/null; then
  pass "image entrypoint refuses without VETO_RPC (no baked endpoint)"
else
  bad "image entrypoint did not refuse missing VETO_RPC (exit ${run_exit}): ${run_out}"
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'watcher-image-round3 checks: passed\n'
