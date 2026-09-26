#!/usr/bin/env bash
# Ensure the merchant and deployer devnet USDC accounts, then print balances.
#
# Circle's devnet USDC cannot be minted here. The founder requests it from
# the faucet. Re-running with the same keys directory is a no-op: an account
# that already exists is left alone, and an address key already present in
# keys/devnet-addresses.env is not rewritten.
#
# The RPC and mainnet guards match scripts/devnet-setup.sh. This file does
# not source that script, because sourcing it would build and deploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.cargo/bin:${HOME}/.avm/bin:${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

# Circle devnet USDC. Classic Token program, 6 decimals. Public addresses.
USDC_MINT="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
TOKEN_PROGRAM="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
MERCHANT="6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG"
DEPLOYER="GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1"
SEEKER_OWNER="GtA2Vxhomfm2WGaBcvz5oCBrqkAecKHMAL3UTn4HVFzq"
MERCHANT_USDC_ATA="GDb2L2oQc6LP4nii8ahUX3pqDUNVUn36nPNVafhhtZ7i"
DEPLOYER_USDC_ATA="8fhPw3vpLmxcVFfsUpqC7g2wHMYc7egw9fJi6ydcHAjz"
SEEKER_USDC_ATA="4Q489otVJQruMgPUYWc6aZfUq3uGYN9dc751PGuQahXC"
FAUCET_URL="https://faucet.circle.com"
NO_VALUE_SENTENCE="Devnet USDC is Circle's test token. It has no value."

RPC=""
KEYS="${VETO_KEYS_DIR:-${ROOT}/keys}"
DEPLOYER_KP="${KEYS}/deployer.json"
ADDRESSES_FILE="${KEYS}/devnet-addresses.env"

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_rpc() {
  if [[ -z "${VETO_RPC:-}" ]]; then
    die "missing VETO_RPC"
  fi
  RPC="$VETO_RPC"
}

is_mainnet_url() {
  printf '%s' "$1" | grep -Ei 'mainnet' >/dev/null
}

# Show a public URL as itself. A query string, userinfo, or a path token is
# where hosted RPCs put an api key, so those forms are replaced outright.
display_url() {
  python3 -c '
import sys
from urllib.parse import urlsplit
url = sys.argv[1] if len(sys.argv) > 1 else ""
parts = urlsplit(url)
path = parts.path or ""
low = url.lower()
keyed = bool(
    parts.username
    or parts.password
    or parts.query
    or path not in ("", "/")
    or "api-key" in low
    or "api_key" in low
    or "apikey" in low
)
sys.stdout.write("[redacted rpc]" if keyed else url)
' "$1"
}

assert_devnet() {
  local url="$1"
  local shown
  shown="$(display_url "$url")"
  if is_mainnet_url "$url"; then
    die "refusing to run against mainnet (url=${shown})"
  fi
  printf '%s' "$url" | grep -Ei 'devnet|127\.0\.0\.1|localhost' >/dev/null \
    || die "refusing to run against a url that is neither devnet nor local: ${shown}"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# Replace the RPC, and any query value or path token it carried, before output
# from the Solana tools is printed.
scrub_text() {
  python3 -c '
import sys
from urllib.parse import parse_qsl, urlsplit
rpc = sys.argv[1] if len(sys.argv) > 1 else ""
data = sys.stdin.read()
if rpc:
    data = data.replace(rpc, "[redacted rpc]")
    parts = urlsplit(rpc)
    for _key, value in parse_qsl(parts.query, keep_blank_values=False):
        if len(value) >= 4:
            data = data.replace(value, "[redacted]")
    path = (parts.path or "").strip("/")
    if len(path) >= 8:
        data = data.replace(path, "[redacted]")
sys.stdout.write(data)
' "${RPC:-}"
}

capture() {
  local __var="$1"
  shift
  # The body name must not match the caller's variable. printf -v assigns in
  # this function's scope, and a local of the same name would hide the caller.
  local _body="" status=0
  set +e
  _body="$("$@" 2>&1)"
  status=$?
  set -e
  _body="$(printf '%s' "$_body" | scrub_text)"
  printf -v "$__var" '%s' "$_body"
  return "$status"
}

require_deployer_keypair() {
  if [[ ! -f "$DEPLOYER_KP" ]]; then
    die "keys/deployer.json is missing"
  fi
  local got
  if ! got="$(solana-keygen pubkey "$DEPLOYER_KP" 2>/dev/null)"; then
    die "keys/deployer.json is not a keypair"
  fi
  if [[ "$got" != "$DEPLOYER" ]]; then
    die "keys/deployer.json pubkey ${got} does not match the recorded deployer ${DEPLOYER}"
  fi
}

account_exists() {
  local pk="$1"
  solana account "$pk" -u "$RPC" >/dev/null 2>&1
}

ata_of() {
  local mint="$1"
  local owner="$2"
  local out="" addr=""
  if ! capture out spl-token address \
      --token "$mint" \
      --owner "$owner" \
      --program-id "$TOKEN_PROGRAM" \
      --verbose \
      --output json \
      -u "$RPC"; then
    printf '%s\n' "$out" >&2
    return 1
  fi
  if ! addr="$(printf '%s' "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if isinstance(d, dict) and isinstance(d.get("commandOutput"), dict):
    d = d["commandOutput"]
addr = d.get("associatedTokenAddress") if isinstance(d, dict) else None
if not addr:
    sys.exit(1)
sys.stdout.write(addr)
')"; then
    printf 'error: could not parse the USDC account for %s\n' "$owner" >&2
    return 1
  fi
  printf '%s\n' "$addr"
}

ensure_usdc_account() {
  local owner="$1"
  local label="$2"
  local expected="$3"
  local ata
  ata="$(ata_of "$USDC_MINT" "$owner")" || die "could not derive the USDC account for ${owner}"
  if [[ "$ata" != "$expected" ]]; then
    die "${label} USDC account derived ${ata}, expected ${expected}"
  fi
  if account_exists "$ata"; then
    log "${label} USDC account exists ${ata}"
    return 0
  fi
  log "creating ${label} USDC account ${ata}"
  local out=""
  if ! capture out spl-token create-account "$USDC_MINT" \
      --owner "$owner" \
      --fee-payer "$DEPLOYER_KP" \
      --program-id "$TOKEN_PROGRAM" \
      -u "$RPC"; then
    if account_exists "$ata"; then
      log "${label} USDC account exists ${ata}"
      return 0
    fi
    printf '%s\n' "$out" >&2
    die "could not create ${label} USDC account ${ata}"
  fi
  if ! account_exists "$ata"; then
    printf '%s\n' "$out" >&2
    die "create-account did not produce ${label} USDC account ${ata}"
  fi
  log "created ${label} USDC account ${ata}"
}

print_usdc_balance() {
  local label="$1"
  local owner="$2"
  local ata="$3"
  if ! account_exists "$ata"; then
    log "USDC balance ${label} ${owner}: no account yet"
    return 0
  fi
  local out="" bal=""
  if ! capture out spl-token balance \
      --address "$ata" \
      --program-id "$TOKEN_PROGRAM" \
      -u "$RPC"; then
    if ! account_exists "$ata"; then
      log "USDC balance ${label} ${owner}: no account yet"
      return 0
    fi
    printf '%s\n' "$out" >&2
    die "could not read the USDC balance for ${label}"
  fi
  bal="$(printf '%s\n' "$out" | awk 'NF { line = $0 } END { print line }')"
  if [[ -z "$bal" ]]; then
    die "empty USDC balance for ${label}"
  fi
  log "USDC balance ${label} ${owner}: ${bal}"
}

# Append KEY=VALUE when that exact key is absent. An existing line is kept,
# including a different value. MINT and MERCHANT_TOKEN_ACCOUNT are not this
# function's keys, and the file is not rewritten when nothing is missing.
# watcher/src/config.ts errors when one normalized key carries two values.
append_absent_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "refusing to append an unsafe key name"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "refusing to append a multiline value"
  python3 - "$file" "$key" "$value" <<'PY'
import os
import sys
from pathlib import Path

path, key, value = sys.argv[1:]
file = Path(path)
prefix = key + "="
if file.exists():
    raw = file.read_bytes()
    for line in raw.decode().splitlines():
        if line.strip().startswith(prefix):
            sys.stdout.write("kept")
            sys.exit(0)
    out = raw
    if out and not out.endswith(b"\n"):
        out += b"\n"
    out += f"{key}={value}\n".encode()
    file.write_bytes(out)
else:
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(f"{key}={value}\n".encode())
os.chmod(file, 0o600)
sys.stdout.write("appended")
PY
}

record_address() {
  local key="$1"
  local value="$2"
  local result
  result="$(append_absent_key "$ADDRESSES_FILE" "$key" "$value")"
  case "$result" in
    kept|appended) log "${key} ${result}" ;;
    *) die "could not record ${key}" ;;
  esac
}

main() {
  require_rpc
  if is_mainnet_url "${SOLANA_CLUSTER:-}" || is_mainnet_url "${CLUSTER:-}"; then
    die "SOLANA_CLUSTER/CLUSTER points at mainnet; refusing to run"
  fi
  assert_devnet "$RPC"

  need_cmd solana
  need_cmd solana-keygen
  need_cmd spl-token
  need_cmd python3

  require_deployer_keypair
  umask 077

  ensure_usdc_account "$MERCHANT" "merchant" "$MERCHANT_USDC_ATA"
  ensure_usdc_account "$DEPLOYER" "deployer" "$DEPLOYER_USDC_ATA"

  local seeker_ata
  seeker_ata="$(ata_of "$USDC_MINT" "$SEEKER_OWNER")" || die "could not derive the USDC account for ${SEEKER_OWNER}"
  if [[ "$seeker_ata" != "$SEEKER_USDC_ATA" ]]; then
    die "seeker owner USDC account derived ${seeker_ata}, expected ${SEEKER_USDC_ATA}"
  fi

  log "USDC mint: ${USDC_MINT}"
  print_usdc_balance "seeker owner" "$SEEKER_OWNER" "$SEEKER_USDC_ATA"
  print_usdc_balance "merchant" "$MERCHANT" "$MERCHANT_USDC_ATA"
  print_usdc_balance "deployer" "$DEPLOYER" "$DEPLOYER_USDC_ATA"
  log "$FAUCET_URL"
  log "Seeker owner: ${SEEKER_OWNER}"
  log "Deployer: ${DEPLOYER}"
  log "$NO_VALUE_SENTENCE"

  record_address USDC_MINT "$USDC_MINT"
  record_address MERCHANT_USDC_TOKEN "$MERCHANT_USDC_ATA"
  record_address DEPLOYER_USDC_TOKEN "$DEPLOYER_USDC_ATA"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
