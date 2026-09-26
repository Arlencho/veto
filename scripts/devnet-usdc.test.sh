#!/usr/bin/env bash
# Prove the USDC fixture refuses a missing or mainnet RPC, does not print
# keypair files, and appends only keys that are not already set.
#
# These checks read source and exercise the guards. They do not talk to a
# cluster and do not need a funded key. CI runs this file as-is.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/devnet-usdc.sh"

fail=0
passed=0
pass() { printf 'ok - %s\n' "$1"; passed=$((passed + 1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail + 1)); }

[[ -f "$SCRIPT" ]] || { echo "missing ${SCRIPT}"; exit 1; }
[[ -x "$SCRIPT" ]] || { echo "not executable ${SCRIPT}"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

run_refused() {
  env -u VETO_KEYS_DIR VETO_KEYS_DIR="$TMP" "$@"
}

if out="$(run_refused env -u VETO_RPC "$SCRIPT" 2>&1)"; then
  bad "unset VETO_RPC must refuse"
else
  if printf '%s' "$out" | grep "missing VETO_RPC" >/dev/null && [[ -z "$(ls -A "$TMP")" ]]; then
    pass "refuses without VETO_RPC"
  else
    bad "unset VETO_RPC message: ${out}"
  fi
fi

if out="$(run_refused env VETO_RPC= "$SCRIPT" 2>&1)"; then
  bad "empty VETO_RPC must refuse"
else
  if printf '%s' "$out" | grep "missing VETO_RPC" >/dev/null; then
    pass "refuses an empty VETO_RPC"
  else
    bad "empty VETO_RPC message: ${out}"
  fi
fi

if out="$(run_refused env VETO_RPC=https://api.mainnet-beta.solana.com "$SCRIPT" 2>&1)"; then
  bad "mainnet url must refuse"
else
  if printf '%s' "$out" | grep -F "refusing to run against mainnet (url=https://api.mainnet-beta.solana.com)" >/dev/null; then
    pass "refuses a mainnet url"
  else
    bad "mainnet url message: ${out}"
  fi
fi

secret="sentinelApiKey9f3c"
keyed="https://api.mainnet-beta.solana.com/?api-key=${secret}"
printf '%s\n' 'not-a-keypair sentinelKeyMaterial9f3c' > "${TMP}/deployer.json"
if out="$(env VETO_KEYS_DIR="$TMP" VETO_RPC="$keyed" "$SCRIPT" 2>&1)"; then
  bad "mainnet url with an api key must refuse"
else
  redacted="$(printf '%s' "$out" | sed "s/${secret}/[redacted]/g; s/sentinelKeyMaterial9f3c/[redacted]/g")"
  if printf '%s' "$out" | grep "refusing to run against mainnet" >/dev/null \
    && ! printf '%s' "$out" | grep -F "$secret" >/dev/null \
    && ! printf '%s' "$out" | grep -F "sentinelKeyMaterial9f3c" >/dev/null; then
    pass "refuses mainnet without printing an api key or a key file"
  else
    bad "mainnet api key message: ${redacted}"
  fi
fi

if out="$(run_refused env VETO_RPC=https://api.devnet.solana.com SOLANA_CLUSTER=mainnet "$SCRIPT" 2>&1)"; then
  bad "SOLANA_CLUSTER=mainnet must refuse"
else
  if printf '%s' "$out" | grep "SOLANA_CLUSTER/CLUSTER points at mainnet; refusing to run" >/dev/null; then
    pass "refuses when SOLANA_CLUSTER names mainnet"
  else
    bad "SOLANA_CLUSTER message: ${out}"
  fi
fi

# shellcheck source-path=SCRIPTDIR
# shellcheck source=devnet-usdc.sh
source "${ROOT}/scripts/devnet-usdc.sh"

if out="$(
  exec 2>&1
  VETO_RPC="https://api.testnet.solana.com"
  require_rpc
  assert_devnet "$VETO_RPC"
)"; then
  bad "testnet url must refuse"
else
  if printf '%s' "$out" | grep "neither devnet nor local" >/dev/null; then
    pass "refuses a url that is neither devnet nor local"
  else
    bad "testnet url message: ${out}"
  fi
fi

if out="$(
  exec 2>&1
  VETO_RPC="https://api.devnet.solana.com"
  require_rpc
  assert_devnet "$VETO_RPC"
  printf '%s\n' "$RPC"
)"; then
  if [[ "$out" == "https://api.devnet.solana.com" ]]; then
    pass "accepts a devnet url"
  else
    bad "devnet url accepted as: ${out}"
  fi
else
  bad "devnet url must be accepted: ${out}"
fi

shown="$(display_url "https://devnet.example.test/?api-key=${secret}")"
path_shown="$(display_url "https://devnet.example.test/${secret}")"
if [[ "$shown" == "[redacted rpc]" && "$path_shown" == "[redacted rpc]" ]] \
  && ! printf '%s' "$shown$path_shown" | grep -F "$secret" >/dev/null; then
  pass "display_url redacts an api key"
else
  bad "display_url redacts an api key"
fi

public_shown="$(display_url "https://api.devnet.solana.com")"
if [[ "$public_shown" == "https://api.devnet.solana.com" ]]; then
  pass "display_url keeps a public devnet url"
else
  bad "display_url keeps a public devnet url (got ${public_shown})"
fi

caller_slot=""
if capture caller_slot printf '%s' 'captured-text' && [[ "$caller_slot" == "captured-text" ]]; then
  pass "capture stores command output in the caller variable"
else
  bad "capture stores command output in the caller variable"
fi

unexpected=""
# The patterns below are literal excerpts of the script, not expansions.
# shellcheck disable=SC2016
while IFS= read -r line; do
  body="${line#*:}"
  case "$body" in
    *'DEPLOYER_KP="${KEYS}/deployer.json"'*) ;;
    *'[[ ! -f "$DEPLOYER_KP" ]]'*) ;;
    *'keys/deployer.json is missing'*) ;;
    *'keys/deployer.json is not a keypair'*) ;;
    *'keys/deployer.json pubkey'*) ;;
    *'solana-keygen pubkey "$DEPLOYER_KP"'*) ;;
    *'--fee-payer "$DEPLOYER_KP"'*) ;;
    *)
      stripped="${body#"${body%%[![:space:]]*}"}"
      if [[ "$stripped" != \#* ]]; then
        unexpected="${unexpected}
${line}"
      fi
      ;;
  esac
done < <(grep -n 'deployer\.json\|DEPLOYER_KP' "$SCRIPT" || true)

# shellcheck disable=SC2016
if [[ -z "$unexpected" ]] \
  && ! grep -nE '(^|[[:space:]])(cat|head|tail|less|more|od|xxd|base64|jq|strings)[[:space:]]' "$SCRIPT" | grep -E '\.json|DEPLOYER_KP|keys/' >/dev/null \
  && ! grep -nE '\$\(<' "$SCRIPT" >/dev/null \
  && grep -q -- '--owner' "$SCRIPT" \
  && grep -q -- '--fee-payer "$DEPLOYER_KP"' "$SCRIPT"; then
  pass "never echoes keys/*.json contents"
else
  bad "never echoes keys/*.json contents${unexpected}"
fi

env_file="${TMP}/devnet-addresses.env"
printf '%s\n' \
  'CLUSTER=devnet' \
  'RPC=https://rpc.test.invalid' \
  'MINT=vtest-mint' \
  'MERCHANT_TOKEN_ACCOUNT=vtest-merchant-ata' \
  'USDC_MINT=keep-this' \
  > "$env_file"
before="$(cat "$env_file")"
chmod 640 "$env_file"

kept="$(append_absent_key "$env_file" USDC_MINT "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")"
merchant_added="$(append_absent_key "$env_file" MERCHANT_USDC_TOKEN "GDb2L2oQc6LP4nii8ahUX3pqDUNVUn36nPNVafhhtZ7i")"
deployer_added="$(append_absent_key "$env_file" DEPLOYER_USDC_TOKEN "8fhPw3vpLmxcVFfsUpqC7g2wHMYc7egw9fJi6ydcHAjz")"

mode_after="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$env_file")"
mint_lines="$(grep -c '^MINT=' "$env_file")"
usdc_lines="$(grep -c '^USDC_MINT=' "$env_file")"
merchant_token_lines="$(grep -c '^MERCHANT_TOKEN_ACCOUNT=' "$env_file")"
merchant_usdc_lines="$(grep -c '^MERCHANT_USDC_TOKEN=' "$env_file")"
deployer_usdc_lines="$(grep -c '^DEPLOYER_USDC_TOKEN=' "$env_file")"

if [[ "$kept" == "kept" \
  && "$merchant_added" == "appended" \
  && "$deployer_added" == "appended" \
  && "$mint_lines" -eq 1 \
  && "$usdc_lines" -eq 1 \
  && "$merchant_token_lines" -eq 1 \
  && "$merchant_usdc_lines" -eq 1 \
  && "$deployer_usdc_lines" -eq 1 \
  && "$(grep '^MINT=' "$env_file")" == "MINT=vtest-mint" \
  && "$(grep '^MERCHANT_TOKEN_ACCOUNT=' "$env_file")" == "MERCHANT_TOKEN_ACCOUNT=vtest-merchant-ata" \
  && "$(grep '^USDC_MINT=' "$env_file")" == "USDC_MINT=keep-this" \
  && "$(grep '^RPC=' "$env_file")" == "RPC=https://rpc.test.invalid" ]] \
  && ! grep -q '^VETO_MINT=' "$env_file"; then
  pass "appends only absent keys"
else
  bad "appends only absent keys (kept=${kept} merchant=${merchant_added} deployer=${deployer_added})"
fi

cp "$env_file" "${env_file}.once"
kept_again="$(append_absent_key "$env_file" USDC_MINT "other-mint")"
merchant_again="$(append_absent_key "$env_file" MERCHANT_USDC_TOKEN "other-merchant")"
deployer_again="$(append_absent_key "$env_file" DEPLOYER_USDC_TOKEN "other-deployer")"
if [[ "$kept_again" == "kept" && "$merchant_again" == "kept" && "$deployer_again" == "kept" ]] \
  && cmp -s "$env_file" "${env_file}.once"; then
  pass "appending again leaves existing keys untouched"
else
  bad "appending again leaves existing keys untouched"
fi

# The first append of a new key may tighten the mode. A later keep must not
# rewrite the file, so the mode stays where the append left it.
if [[ "$mode_after" == "0o600" ]]; then
  chmod 640 "$env_file"
  append_absent_key "$env_file" USDC_MINT "ignored" >/dev/null
  mode_kept="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$env_file")"
  if [[ "$mode_kept" == "0o640" ]] && cmp -s "$env_file" "${env_file}.once"; then
    pass "keeping an existing key does not rewrite the file"
  else
    bad "keeping an existing key does not rewrite the file (mode ${mode_kept})"
  fi
else
  bad "a new key is written with mode 600 (got ${mode_after})"
fi

bare="${TMP}/no-newline.env"
printf 'MINT=vtest-mint' > "$bare"
append_absent_key "$bare" USDC_MINT "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" >/dev/null
if [[ "$(grep '^MINT=' "$bare")" == "MINT=vtest-mint" \
  && "$(grep '^USDC_MINT=' "$bare")" == "USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" \
  && "$(grep -c '^MINT=' "$bare")" -eq 1 ]]; then
  pass "append keeps the previous line when the file has no trailing newline"
else
  bad "append keeps the previous line when the file has no trailing newline"
fi

# The original lines of a file that already had a trailing newline stay put.
if [[ "$(printf '%s\n' "$before" | sed -n '1,4p')" == "$(head -n 4 "$env_file")" ]]; then
  pass "leaves MINT and MERCHANT_TOKEN_ACCOUNT untouched"
else
  bad "leaves MINT and MERCHANT_TOKEN_ACCOUNT untouched"
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'devnet-usdc checks: %d passed\n' "$passed"
