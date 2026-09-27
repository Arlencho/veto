#!/usr/bin/env bash
# Offline checks for e2e/maestro/helpers/fund-fake-wallet.sh. adb, solana and
# spl-token are stubbed on a private PATH; no device, emulator, cluster or
# real keypair is touched. Proves the helper refuses a missing or non-emulator
# serial, a non-devnet genesis hash and bad amounts before touching adb, reads
# only the newest fake wallet key row, base64-decodes its public_key_b64
# column (standard or URL-safe, padding optional) into 32 bytes and
# base58-encodes them, funds that address with SOL and devnet USDC via
# --fund-recipient, keeps funding noise off stdout, deletes its database
# copies, and never prints private key material.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${ROOT}/e2e/maestro/helpers/fund-fake-wallet.sh"

fail=0
passed=0
pass() { printf 'ok - %s\n' "$1"; passed=$((passed + 1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail + 1)); }

[[ -f "$SCRIPT" ]] || { echo "missing ${SCRIPT}"; exit 1; }
[[ -x "$SCRIPT" ]] || { echo "not executable ${SCRIPT}"; exit 1; }

MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
USDC_MINT="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
# Two fixture keys: public_key_b64 holds base64 of the 32 raw public key
# bytes. The old row uses standard base64 with padding; the newest row uses
# URL-safe base64 without padding, so the happy path proves both alphabets
# and missing padding decode. NEW_PUB is the base58 address of the 32 bytes
# the newest row encodes.
OLD_PUB_B64="+/8+AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxw="
OLD_PUB="Hxh53DDgM5a7GJjTnRrJ3uaMwgYbxR4UZ3DxpejgY4G3"
NEW_PUB_B64="-v79AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxw"
NEW_PUB="HtnSNJvohUmvUjYCk13Fqtn5KDKsrGbBwmCYtNDg6b4o"
DB_SENTINEL="DbPrivateKeySentinelDoNotPrint9f3c"
FUNDER_SENTINEL="FunderKeySentinelDoNotPrint7zQ"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/fund-fake-wallet-test.XXXXXX")"
trap 'rm -rf "$DIR"' EXIT
FAKE_BIN="${DIR}/bin"
mkdir -p "$FAKE_BIN"
export FAKE_ADB_LOG="${DIR}/adb.log"
export FAKE_SOLANA_LOG="${DIR}/solana.log"
export FAKE_SPL_LOG="${DIR}/spl-token.log"
export FAKE_WALLET_DB="${DIR}/keys.db"
FUNDER="${DIR}/funder.json"
printf '[%s]\n' "$FUNDER_SENTINEL" > "$FUNDER"

# The fake wallet key table holds two rows; the helper must pick the newest
# by id. write_key_table builds a fixture database at the given path with the
# given base64 public keys and sentinel private key material.
write_key_table() {
  python3 - "$1" "$2" "$3" "$DB_SENTINEL" <<'PY'
import sqlite3
import sys
path, old_pub_b64, new_pub_b64, sentinel = sys.argv[1:5]
db = sqlite3.connect(path)
db.execute(
    "CREATE TABLE keys ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, "
    "public_key_b64 TEXT NOT NULL, "
    "private_key BLOB NOT NULL)"
)
db.execute("INSERT INTO keys (public_key_b64, private_key) VALUES (?, ?)",
           (old_pub_b64, sentinel.encode()))
db.execute("INSERT INTO keys (public_key_b64, private_key) VALUES (?, ?)",
           (new_pub_b64, sentinel.encode()))
db.commit()
db.close()
PY
}
write_key_table "$FAKE_WALLET_DB" "$OLD_PUB_B64" "$NEW_PUB_B64"

# The adb stub accepts only `-s emulator-* exec-out run-as <fakewallet> cat
# databases/keys*` and serves the fixture database. Anything else exits 1, so
# a test also fails when the helper reaches for an unexpected path or device.
cat > "${FAKE_BIN}/adb" <<'EOF'
#!/usr/bin/env bash
set -u
printf 'adb %s\n' "$*" >> "$FAKE_ADB_LOG"
if [[ "${1:-}" != "-s" ]]; then
  echo "adb stub: expected -s <serial>, got: $*" >&2
  exit 1
fi
serial="$2"
shift 2
case "$serial" in
  emulator-*) ;;
  *) echo "adb stub: refusing non-emulator serial: $serial" >&2; exit 1 ;;
esac
if [[ "${1:-}" != "exec-out" ]]; then
  echo "adb stub: expected exec-out, got: $*" >&2
  exit 1
fi
shift
if [[ "${1:-} ${2:-}" != "run-as com.solana.mobilewalletadapter.fakewallet" ]]; then
  echo "adb stub: expected run-as fakewallet, got: $*" >&2
  exit 1
fi
shift 2
if [[ "${1:-}" != "cat" ]]; then
  echo "adb stub: only cat is permitted, got: $*" >&2
  exit 1
fi
case "${2:-}" in
  databases/keys) cat "$FAKE_WALLET_DB" ;;
  databases/keys-wal) cat "${FAKE_WALLET_DB}-wal" ;;
  databases/keys-shm) cat "${FAKE_WALLET_DB}-shm" ;;
  *) echo "adb stub: refusing unexpected path: ${2:-}" >&2; exit 1 ;;
esac
EOF

# The solana stub answers genesis-hash from FAKE_GENESIS and prints noise on
# stdout for transfer, so the test proves the helper keeps funding output off
# its own stdout.
cat > "${FAKE_BIN}/solana" <<'EOF'
#!/usr/bin/env bash
set -u
printf 'solana %s\n' "$*" >> "$FAKE_SOLANA_LOG"
case "${1:-}" in
  genesis-hash)
    printf '%s\n' "${FAKE_GENESIS:-EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG}"
    ;;
  balance)
    printf '%s lamports\n' "${FAKE_LAMPORTS:-0}"
    ;;
  transfer)
    printf 'Signature: stubSolanaNoiseOnStdout111\n'
    ;;
  *)
    echo "solana stub: unexpected subcommand: $*" >&2
    exit 1
    ;;
esac
EOF

cat > "${FAKE_BIN}/spl-token" <<'EOF'
#!/usr/bin/env bash
set -u
printf 'spl-token %s\n' "$*" >> "$FAKE_SPL_LOG"
case "${1:-}" in
  transfer)
    # The real spl-token rejects --keypair; the funder is --owner and --fee-payer.
    case " $* " in *" --keypair "*) echo "spl-token stub: --keypair is not a transfer flag" >&2; exit 2 ;; esac
    printf 'Signature: stubSplNoiseOnStdout222\n'
    ;;
  *)
    echo "spl-token stub: unexpected subcommand: $*" >&2
    exit 1
    ;;
esac
EOF

chmod +x "${FAKE_BIN}/adb" "${FAKE_BIN}/solana" "${FAKE_BIN}/spl-token"

reset_logs() { rm -f "$FAKE_ADB_LOG" "$FAKE_SOLANA_LOG" "$FAKE_SPL_LOG"; }

run_helper() {
  reset_logs
  PATH="${FAKE_BIN}:$PATH" "$SCRIPT" "$@"
}

# 1. No serial argument: refuse before any adb or solana call.
if out="$(run_helper 2>&1)"; then
  bad "no arguments must refuse"
else
  if printf '%s' "$out" | grep -qi "emulator" \
    && [[ ! -e "$FAKE_ADB_LOG" ]] && [[ ! -e "$FAKE_SOLANA_LOG" ]]; then
    pass "refuses to run without an explicit emulator serial"
  else
    bad "no-argument refusal message: ${out}"
  fi
fi

# 2. Serials that are not emulator-NNNN ids: refuse without touching adb.
for serial in "012abcdef34" "emulator-5554x" "emulator-" "emulator-5554;id" "192.168.1.20:5555"; do
  if out="$(run_helper "$serial" "$FUNDER" 1 2 2>&1)"; then
    bad "serial ${serial} must refuse"
  elif printf '%s' "$out" | grep -q "emulator-NNNN" && [[ ! -e "$FAKE_ADB_LOG" ]]; then
    pass "refuses non-emulator serial: ${serial}"
  else
    bad "serial ${serial} refusal: ${out}"
  fi
done

# 3. Unreadable funder keypair: refuse.
if out="$(run_helper emulator-5554 "${DIR}/absent.json" 1 2 2>&1)"; then
  bad "missing funder keypair must refuse"
else
  if printf '%s' "$out" | grep -q "funder keypair"; then
    pass "refuses an unreadable funder keypair path"
  else
    bad "funder refusal message: ${out}"
  fi
fi

# 4. Bad amounts: zero, negative, non-numeric and injection-shaped.
for amount in "0" "0.00" "-1" "abc" "1;id" ""; do
  if out="$(run_helper emulator-5554 "$FUNDER" "$amount" 2 2>&1)"; then
    bad "SOL amount '${amount}' must refuse"
  elif [[ ! -e "$FAKE_ADB_LOG" ]]; then
    pass "refuses SOL amount: '${amount}'"
  else
    bad "SOL amount '${amount}' reached adb"
  fi
done
if out="$(run_helper emulator-5554 "$FUNDER" 1 "x" 2>&1)"; then
  bad "USDC amount x must refuse"
else
  pass "refuses a non-numeric USDC amount"
fi

# 5. Non-devnet genesis: refuse before adb, never fund.
if out="$(FAKE_GENESIS="$MAINNET_GENESIS" run_helper emulator-5554 "$FUNDER" 1 2 2>&1)"; then
  bad "mainnet genesis must refuse"
else
  if printf '%s' "$out" | grep -q "not devnet" \
    && [[ ! -e "$FAKE_ADB_LOG" ]] \
    && ! grep -q "transfer" "$FAKE_SOLANA_LOG" 2>/dev/null; then
    pass "refuses a non-devnet RPC genesis hash before funding"
  else
    bad "mainnet genesis refusal: ${out}"
  fi
fi

# 6. Unreadable fake wallet key table: refuse, never fund.
if out="$(FAKE_WALLET_DB="${DIR}/no-such.db" run_helper emulator-5554 "$FUNDER" 1 2 2>&1)"; then
  bad "missing key table must refuse"
else
  if ! grep -q "transfer" "$FAKE_SOLANA_LOG" 2>/dev/null \
    && ! grep -q "transfer" "$FAKE_SPL_LOG" 2>/dev/null; then
    pass "refuses when the fake wallet key table cannot be read"
  else
    bad "missing key table still funded: ${out}"
  fi
fi

# 7. Happy path: newest row's public_key_b64 decodes (URL-safe, no padding)
# to the base58 address on stdout, funded with SOL and USDC.
mkdir -p "${DIR}/tmps"
reset_logs
stdout="$(TMPDIR="${DIR}/tmps" PATH="${FAKE_BIN}:$PATH" \
  "$SCRIPT" emulator-5554 "$FUNDER" 0.5 2 2>"${DIR}/happy.stderr")"
rc=$?
stderr="$(cat "${DIR}/happy.stderr")"
if [[ $rc -eq 0 && "$stdout" == "$NEW_PUB" ]]; then
  pass "decodes public_key_b64 and prints only the newest base58 address on stdout"
else
  bad "happy path rc=${rc} stdout: ${stdout}"
fi
if printf '%s' "$stdout$stderr" | grep -qF "$OLD_PUB"; then
  bad "older key address leaked: ${stdout} ${stderr}"
elif printf '%s' "$stdout$stderr" | grep -qF "$OLD_PUB_B64"; then
  bad "older key base64 leaked: ${stdout} ${stderr}"
else
  pass "reads only the newest key table row"
fi
if printf '%s' "$stdout$stderr" | grep -q "$DB_SENTINEL"; then
  bad "database private key material printed"
elif printf '%s' "$stdout$stderr" | grep -q "$FUNDER_SENTINEL"; then
  bad "funder private key material printed"
else
  pass "never prints private key material"
fi
if printf '%s' "$stdout" | grep -q "stubSolanaNoiseOnStdout111\|stubSplNoiseOnStdout222"; then
  bad "funding noise on stdout: ${stdout}"
else
  pass "keeps funding command output off stdout"
fi
if grep -F -q "solana transfer --keypair $FUNDER" "$FAKE_SOLANA_LOG" \
  && grep -F -q "$NEW_PUB 0.5" "$FAKE_SOLANA_LOG"; then
  pass "funds the newest key with the given SOL amount from the funder"
else
  bad "solana transfer log: $(cat "$FAKE_SOLANA_LOG" 2>/dev/null)"
fi
if grep -F -q "spl-token transfer --owner $FUNDER --fee-payer $FUNDER --fund-recipient --allow-unfunded-recipient $USDC_MINT 2 $NEW_PUB" "$FAKE_SPL_LOG"; then
  pass "funds the newest key with devnet USDC using --fund-recipient"
else
  bad "spl-token transfer log: $(cat "$FAKE_SPL_LOG" 2>/dev/null)"
fi
if grep -F -q "adb -s emulator-5554 exec-out run-as com.solana.mobilewalletadapter.fakewallet cat databases/keys" "$FAKE_ADB_LOG"; then
  pass "reads the key table pinned to the emulator serial"
else
  bad "adb log: $(cat "$FAKE_ADB_LOG" 2>/dev/null)"
fi
if [[ -z "$(ls -A "${DIR}/tmps")" ]]; then
  pass "deletes the copied database files"
else
  bad "database copies left behind: $(ls -A "${DIR}/tmps")"
fi

# 8. public_key_b64 that is not base64: refuse, never fund.
write_key_table "${DIR}/bad-b64.db" "$OLD_PUB_B64" "!!!not-base64!!!"
if out="$(FAKE_WALLET_DB="${DIR}/bad-b64.db" run_helper emulator-5554 "$FUNDER" 1 2 2>&1)"; then
  bad "invalid base64 must refuse"
else
  if printf '%s' "$out" | grep -q "public_key_b64" \
    && ! grep -q "transfer" "$FAKE_SOLANA_LOG" 2>/dev/null \
    && ! grep -q "transfer" "$FAKE_SPL_LOG" 2>/dev/null; then
    pass "refuses a public_key_b64 value that is not base64"
  else
    bad "invalid base64 handling: ${out}"
  fi
fi

# 9. public_key_b64 that decodes to other than 32 bytes: refuse, never fund.
write_key_table "${DIR}/short.db" "$OLD_PUB_B64" "AAECAwQFBgcICQoLDA0ODw=="
if out="$(FAKE_WALLET_DB="${DIR}/short.db" run_helper emulator-5554 "$FUNDER" 1 2 2>&1)"; then
  bad "16-byte key must refuse"
else
  if printf '%s' "$out" | grep -q "public_key_b64" \
    && ! grep -q "transfer" "$FAKE_SOLANA_LOG" 2>/dev/null \
    && ! grep -q "transfer" "$FAKE_SPL_LOG" 2>/dev/null; then
    pass "refuses a public_key_b64 value that is not 32 bytes"
  else
    bad "short key handling: ${out}"
  fi
fi

# 10. An account that already holds SOL is skipped, so the helper can loop.
reset_logs
if out="$(FAKE_LAMPORTS=5000 run_helper emulator-5554 "$FUNDER" 1 2 2>/dev/null)"; then
  if [[ "$out" == "$NEW_PUB" ]] \
    && ! grep -q "transfer" "$FAKE_SOLANA_LOG" 2>/dev/null \
    && ! grep -q "transfer" "$FAKE_SPL_LOG" 2>/dev/null; then
    pass "skips an account that already holds SOL"
  else
    bad "funded account handling: ${out}"
  fi
else
  bad "already funded account must exit 0"
fi

# 11. Shellcheck, when available, stays clean on helper and test.
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -S error "$SCRIPT" "${ROOT}/e2e/maestro/helpers/fund-fake-wallet.test.sh"; then
    pass "shellcheck -S error clean"
  else
    bad "shellcheck -S error findings"
  fi
fi

echo "fund-fake-wallet checks: ${passed} passed, ${fail} failed"
[[ $fail -eq 0 ]]
