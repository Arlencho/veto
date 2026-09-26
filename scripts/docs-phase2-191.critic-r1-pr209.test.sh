#!/usr/bin/env bash
# Critic round 1 on PR 209 (docs/phase2-191, closes #191).
#
# Two checks that were RED on 9b21065:
#   1. docs/DEVNET.md was corrected by hand, but the write_docs template in
#      scripts/devnet-setup.sh still emits the old text, and the doc itself says
#      re-running the script replaces the file.
#   2. The submission deadline carries a clock time (23:59 Pacific, 08:59 in
#      Stockholm) while the only linked source names a date and no time.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok()  { echo "ok - $1"; pass=$((pass + 1)); }
bad() { echo "not ok - $1"; fail=$((fail + 1)); }

DOC="$ROOT/docs/DEVNET.md"
# The write_docs function body only (the real deploy commands further down the
# script already carry the corrections; the template that rewrites the doc does not).
SCRIPT="$(mktemp)"
awk '/^write_docs\(\) \{/{p=1} p{print} p && /^\}$/{exit}' "$ROOT/scripts/devnet-setup.sh" > "$SCRIPT"
trap 'rm -f "$SCRIPT"' EXIT

# 1. Every correction in the rendered DEVNET.md steps and command block has to be
#    in the template that regenerates the file, or the next run reverts it.
drift=0
if ! grep -q -- 'git checkout -- programs/veto/src Anchor.toml' "$SCRIPT"; then
    echo "  # template restores programs/veto/src without Anchor.toml (scripts/devnet-setup.sh write_docs)"; drift=1
fi
if ! grep -q -- 'rm -f target/deploy/veto.so' "$SCRIPT" || ! grep -q 'rm -f target/deploy/veto.so' "$DOC"; then
    echo "  # rm -f target/deploy/veto.so is in the doc or the template but not both"; drift=1
fi
if grep -q -- '--provider.cluster {cluster}' "$SCRIPT"; then
    echo "  # template step 5 and command block still print --provider.cluster {cluster}; the script passes the RPC URL"; drift=1
fi
if ! grep -q -- '--with-compute-unit-price 5000' "$SCRIPT" || ! grep -q -- '--with-compute-unit-price 5000' "$DOC"; then
    echo "  # the compute-unit-price retry is in the doc or the template but not both"; drift=1
fi
if [ "$drift" -eq 0 ]; then
    ok "docs/DEVNET.md steps and commands match the write_docs template in scripts/devnet-setup.sh"
else
    bad "docs/DEVNET.md corrections are not in the write_docs template that rewrites the file"
fi

# 2. A deadline clock time needs a source on the same line. The organizer page
#    (linked from README.md) says "Submissions close: October 8, 2026" and no time.
clock=0
while IFS= read -r hit; do
    line="${hit#*:*:}"
    if ! printf '%s' "$line" | grep -E 'https?://' >/dev/null; then
        echo "  # ${hit#"$ROOT"/}"; clock=1
    fi
done < <(grep -rn -E 'October 8, 2026 at [0-9]{1,2}:[0-9]{2}' "$ROOT/README.md" "$ROOT/docs" --include='*.md')
if [ "$clock" -eq 0 ]; then
    ok "no deadline clock time without a source link on the same line"
else
    bad "deadline clock time (23:59 Pacific / 08:59 Stockholm) has no linked source; the organizer page names only October 8, 2026"
fi

echo "docs phase 2 critic r1 checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
