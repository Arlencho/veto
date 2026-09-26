#!/usr/bin/env bash
# Critic round 2 on PR 209 (docs/phase2-191, closes #191).
#
# Regression check for round 1 finding 3. Round 1 grepped a few corrected lines
# in both the doc and the write_docs template. This check renders the template
# with the addresses docs/DEVNET.md already carries and requires the output to be
# the committed file, byte for byte. RED on 9b21065 (template emitted the old
# steps and commands), green on a107742.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok()  { echo "ok - $1"; pass=$((pass + 1)); }
bad() { echo "not ok - $1"; fail=$((fail + 1)); }

DOC="$ROOT/docs/DEVNET.md"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/docs"

# The python heredoc inside write_docs, and nothing else from the script.
awk '/^write_docs\(\) \{/{p=1} p && /<<'"'"'PY'"'"'$/{q=1; next} q && /^PY$/{exit} q{print}' \
    "$ROOT/scripts/devnet-setup.sh" > "$WORK/render.py"

# Every substituted value comes from the doc itself, so the only thing under
# test is the template text around them.
cell() { grep -E "^\| $1 " "$DOC" | sed -n '1p' | perl -ne 'print $1 if /`([^`]+)`\s*\|\s*$/'; }
when="$(perl -ne 'print $1 if /^Recorded by .* at (\S+) UTC/' "$DOC")"
rpc="$(perl -ne 'print $1 if /^- RPC: `([^`]+)`/' "$DOC")"
program="$(cell Program)"
mint="$(cell 'Test SPL mint \(6 decimals\)')"
owner="$(cell Owner)"
owner_ata="$(cell 'Owner token account')"
merchant="$(cell Merchant)"
merchant_ata="$(cell 'Merchant token account')"
agent="$(cell Agent)"
deployer="$(cell Deployer)"
# The third fenced block after the "Program account" heading is the dump.
awk '/^## Program account/{s=1} s && /^```$/{n++; next} s && n==3{print} s && n==4{exit}' "$DOC" > "$WORK/dump.txt"

# Defaults the script passes: OWNER_FUND_TOKENS, MINT_DECIMALS, AGENT_SOL, CLUSTER_NAME.
fund="$(perl -ne 'print $1 if /^OWNER_FUND_TOKENS="?([0-9]+)"?/' "$ROOT/scripts/devnet-setup.sh")"
decimals="$(perl -ne 'print $1 if /^MINT_DECIMALS=([0-9]+)/' "$ROOT/scripts/devnet-setup.sh")"
agent_sol="$(perl -ne 'print $1 if /^AGENT_SOL="?([0-9.]+)"?/' "$ROOT/scripts/devnet-setup.sh")"

missing=0
for v in when rpc program mint owner owner_ata merchant merchant_ata agent deployer fund decimals agent_sol; do
    if [ -z "${!v}" ]; then echo "  # could not read $v from the doc or the script"; missing=1; fi
done
if [ "$missing" -ne 0 ]; then
    bad "docs/DEVNET.md or scripts/devnet-setup.sh no longer carries the values write_docs substitutes"
else
    (cd "$WORK" && python3 render.py "$when" "$rpc" "$program" "$mint" "$owner" "$owner_ata" \
        "$merchant" "$merchant_ata" "$agent" "$deployer" dump.txt "$fund" "$decimals" "$agent_sol" devnet >/dev/null)
    if [ ! -f "$WORK/docs/DEVNET.md" ]; then
        bad "write_docs template did not render (python3 exit $?)"
    elif diff -u "$DOC" "$WORK/docs/DEVNET.md" > "$WORK/diff.txt"; then
        ok "write_docs renders docs/DEVNET.md byte for byte from the doc's own addresses"
    else
        head -40 "$WORK/diff.txt" | sed 's/^/  # /'
        bad "write_docs renders a different docs/DEVNET.md; the next script run reverts the hand edits"
    fi
fi

echo "docs phase 2 critic r2 checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
