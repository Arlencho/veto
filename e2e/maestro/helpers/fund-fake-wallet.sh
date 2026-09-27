#!/usr/bin/env bash
# Fund the Solana Mobile fake wallet's current devnet account from a local
# funder keypair. The operator runs this on the laptop between Maestro flows
# 02 and 04: the fake wallet creates a new key each time it authorizes, so
# the flows that sign need that newest key funded.
#
# Usage: fund-fake-wallet.sh <emulator-serial> <funder-keypair.json> <sol-amount> <usdc-amount>
#
# Safety rules:
# - The serial argument is required and must be an emulator-NNNN id, so this
#   script can never address a physical phone.
# - The configured Solana RPC must report the devnet genesis hash; anything
#   else refuses before adb is touched.
# - The fake wallet key table is copied into a private temporary directory,
#   only the public_key_b64 column of the newest row is read, and the copies
#   are deleted on exit. No private key is printed or copied out of that
#   directory.
# - public_key_b64 stores base64 (standard or URL-safe, padding optional) of
#   the 32 raw public key bytes. The helper decodes it and base58-encodes the
#   bytes to get the Solana address it funds.
# - stdout carries only the base58 address, so callers can capture it.
#   Progress and funding command output go to stderr.
set -euo pipefail

DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
DEVNET_USDC_MINT="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
FAKE_WALLET="com.solana.mobilewalletadapter.fakewallet"

refuse() {
  echo "refusing: $*" >&2
  exit 1
}

if [[ $# -ne 4 ]]; then
  echo "usage: fund-fake-wallet.sh <emulator-serial> <funder-keypair.json> <sol-amount> <usdc-amount>" >&2
  exit 2
fi
SERIAL="$1"
FUNDER="$2"
SOL_AMOUNT="$3"
USDC_AMOUNT="$4"

[[ "$SERIAL" =~ ^emulator-[0-9]+$ ]] \
  || refuse "serial must be an emulator-NNNN id, got: ${SERIAL}"
[[ -f "$FUNDER" && -r "$FUNDER" ]] \
  || refuse "funder keypair not readable: ${FUNDER}"
is_amount() {
  [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]] && [[ ! "$1" =~ ^0*\.?0*$ ]]
}
is_amount "$SOL_AMOUNT" \
  || refuse "SOL amount must be a positive number, got: ${SOL_AMOUNT}"
is_amount "$USDC_AMOUNT" \
  || refuse "USDC amount must be a positive number, got: ${USDC_AMOUNT}"

command -v adb >/dev/null 2>&1 || refuse "adb is not on PATH"
command -v solana >/dev/null 2>&1 || refuse "solana is not on PATH"
command -v spl-token >/dev/null 2>&1 || refuse "spl-token is not on PATH"
command -v python3 >/dev/null 2>&1 || refuse "python3 is not on PATH"

GENESIS="$(solana genesis-hash)" || refuse "could not read the RPC genesis hash"
[[ "$GENESIS" == "$DEVNET_GENESIS" ]] \
  || refuse "RPC genesis hash is not devnet: ${GENESIS}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fund-fake-wallet.XXXXXX")"
chmod 700 "$TMP_DIR"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# exec-out avoids the pseudo-terminal newline translation that `adb shell`
# can apply, which would corrupt the sqlite copy.
copy_db() {
  local name="$1"
  if adb -s "$SERIAL" exec-out run-as "$FAKE_WALLET" cat "databases/${name}" \
    > "${TMP_DIR}/${name}" 2>/dev/null && [[ -s "${TMP_DIR}/${name}" ]]; then
    return 0
  fi
  rm -f "${TMP_DIR}/${name}"
  return 1
}

copy_db keys \
  || refuse "could not read the fake wallet key table; is ${FAKE_WALLET} installed on ${SERIAL}?"
# The write-ahead log and shared memory files carry the newest row when the
# database was not checkpointed. They are absent after a clean close.
copy_db keys-wal || true
copy_db keys-shm || true

read_newest_public_key_b64() {
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${TMP_DIR}/keys" \
      "SELECT public_key_b64 FROM keys ORDER BY id DESC LIMIT 1;" 2>/dev/null || true
  else
    python3 - "${TMP_DIR}/keys" <<'PY' || true
import sqlite3
import sys
try:
    db = sqlite3.connect(sys.argv[1])
    row = db.execute(
        "SELECT public_key_b64 FROM keys ORDER BY id DESC LIMIT 1"
    ).fetchone()
    db.close()
    print(row[0] if row else "")
except Exception:
    print("")
PY
  fi
}

# public_key_b64 stores base64 of the 32 raw public key bytes. The fake
# wallet may write standard or URL-safe base64 and may drop the padding, so
# decode tolerantly, then base58-encode the bytes into a Solana address.
b64_to_base58() {
  python3 - "$1" <<'PY'
import base64
import sys
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
text = sys.argv[1].strip().replace("-", "+").replace("_", "/")
text += "=" * (-len(text) % 4)
try:
    raw = base64.b64decode(text, validate=True)
except Exception:
    sys.exit(1)
if len(raw) != 32:
    sys.exit(1)
n = int.from_bytes(raw, "big")
out = ""
while n:
    n, r = divmod(n, 58)
    out = ALPHABET[r] + out
pad = 0
for b in raw:
    if b == 0:
        pad += 1
    else:
        break
print("1" * pad + out)
PY
}

PUBKEY_B64="$(read_newest_public_key_b64)"
[[ -n "$PUBKEY_B64" ]] \
  || refuse "no usable public key in the newest fake wallet key row"
PUBKEY="$(b64_to_base58 "$PUBKEY_B64")" \
  || refuse "newest fake wallet public_key_b64 is not base64 of 32 bytes: ${PUBKEY_B64}"
[[ "$PUBKEY" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] \
  || refuse "decoded fake wallet address is not valid base58: ${PUBKEY}"

echo "fake wallet account: ${PUBKEY}" >&2
echo "funding ${SOL_AMOUNT} SOL and ${USDC_AMOUNT} devnet USDC from ${FUNDER}" >&2
solana transfer --keypair "$FUNDER" --allow-unfunded-recipient "$PUBKEY" "$SOL_AMOUNT" >&2
spl-token transfer --owner "$FUNDER" --fee-payer "$FUNDER" --fund-recipient --allow-unfunded-recipient \
  "$DEVNET_USDC_MINT" "$USDC_AMOUNT" "$PUBKEY" >&2

printf '%s\n' "$PUBKEY"
