#!/usr/bin/env bash
# Prove that a declare_id mismatch is a loud refusal naming both ids, and that
# a missing program keypair is refused rather than minted.
#
# These checks read source and exercise the keypair guards. They do not talk
# to a cluster and do not need a funded key. CI runs this file as-is.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=devnet-setup.sh
source "${ROOT}/scripts/devnet-setup.sh"

fail=0
# The summary line used to carry a hardcoded number, and the merge produced
# two of them disagreeing. Count what actually ran instead.
passed=0
pass() { printf 'ok - %s\n' "$1"; passed=$((passed+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

[[ -f "${ROOT}/programs/veto/src/lib.rs" ]] || { echo "missing programs/veto/src/lib.rs"; exit 1; }

id="$(declared_program_id)"
expected="$(sed -n 's/^[[:space:]]*declare_id!("\([^"]*\)");/\1/p' "${ROOT}/programs/veto/src/lib.rs" | sed -n '1p')"
if [[ -n "$id" && "$id" == "$expected" ]]; then
  pass "declared_program_id reads lib.rs"
else
  bad "declared_program_id reads lib.rs (got '${id}', expected '${expected}')"
fi

if assert_program_keypair_matches_declare_id "$id"; then
  pass "matching id is accepted"
else
  bad "matching id is accepted"
fi

fake="11111111111111111111111111111111"
if out="$(assert_program_keypair_matches_declare_id "$fake" 2>&1)"; then
  bad "mismatch must refuse"
else
  if printf '%s' "$out" | grep -F "$fake" >/dev/null \
    && printf '%s' "$out" | grep -F "$id" >/dev/null \
    && printf '%s' "$out" | grep "the program keypair must be restored from backup" >/dev/null; then
    pass "mismatch names both ids and says restore from backup"
  else
    bad "mismatch message: ${out}"
  fi
fi

saved_kp="$PROGRAM_KP"
PROGRAM_KP="${ROOT}/keys/does-not-exist-program.json"
if out="$(require_backed_up_program_keypair 2>&1)"; then
  bad "missing program keypair must refuse"
else
  if printf '%s' "$out" | grep "keys/program.json is missing" >/dev/null \
    && printf '%s' "$out" | grep "the program keypair must be restored from backup" >/dev/null \
    && printf '%s' "$out" | grep -F "$id" >/dev/null; then
    pass "missing program keypair names declare_id and says restore from backup"
  else
    bad "missing keypair message: ${out}"
  fi
fi
PROGRAM_KP="$saved_kp"

# make localnet sets VETO_CLUSTER=localnet. The generated files must say so.
# A hardcoded devnet label points explorer links at public devnet for
# addresses that exist only on the local validator.
if grep -q '^CLUSTER=${CLUSTER_NAME}$' "${ROOT}/scripts/devnet-setup.sh"; then
  pass "addresses file writes CLUSTER from VETO_CLUSTER"
else
  bad "addresses file writes CLUSTER from VETO_CLUSTER"
fi

if grep -q 'cluster={cluster}' "${ROOT}/scripts/devnet-setup.sh" \
  && ! grep -q '?cluster=devnet' "${ROOT}/scripts/devnet-setup.sh"; then
  pass "docs template uses the cluster name in explorer links"
else
  bad "docs template uses the cluster name in explorer links"
fi
if out="$(env -u VETO_RPC "${ROOT}/scripts/devnet-setup.sh" 2>&1)"; then
  bad "unset VETO_RPC must refuse"
else
  if printf '%s' "$out" | grep "missing VETO_RPC" >/dev/null; then
    pass "unset VETO_RPC names the variable"
  else
    bad "unset VETO_RPC message: ${out}"
  fi
fi

if out="$(env VETO_RPC= "${ROOT}/scripts/devnet-setup.sh" 2>&1)"; then
  bad "empty VETO_RPC must refuse"
else
  if printf '%s' "$out" | grep "missing VETO_RPC" >/dev/null; then
    pass "empty VETO_RPC names the variable"
  else
    bad "empty VETO_RPC message: ${out}"
  fi
fi

VETO_RPC="https://rpc.test.invalid"
if require_rpc && [[ "$RPC" == "https://rpc.test.invalid" ]]; then
  pass "set VETO_RPC is used as the endpoint"
else
  bad "set VETO_RPC should become RPC (got '${RPC:-}')"
fi
unset VETO_RPC
RPC=""

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'devnet-setup checks: %d passed\n' "$passed"
