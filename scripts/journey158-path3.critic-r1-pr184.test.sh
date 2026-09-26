#!/usr/bin/env bash
# Ground Truth: the commands the README and docs/DEVNET.md print run on a
# fresh clone, and the numbers the docs state match what the chain and the
# cloud project print today.
#
# Critic round 1 fixture for PR 184 (the fix for the issue 158 path 3 walk).
# One check per issue: #174, #175, #176, #177, #178, #179, #180, #182.
# Every check is red on main 68d372f and green on the fix branch.
# No network, no cloud, no vendor CLIs: the live values were read from
# devnet and from gcp-verify.sh on 2026-09-23 and are pinned here.
# Piped checks must consume all input: quiet grep can close early and make
# a successful match fail under pipefail when the writer receives SIGPIPE.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

# #174: scripts/devnet-setup.sh dies on a missing keys/program.json, so the
# docs must say so before the command and must not claim the script creates
# every keypair.
if grep -qE 'Creates `keys/` and the keypairs above when they are missing' "$ROOT/docs/DEVNET.md"; then
    bad "#174 docs/DEVNET.md step 2 says the script creates every keypair; it dies on a missing keys/program.json"
elif ! grep -q 'maintainer backup of `keys/program.json`' "$ROOT/README.md"; then
    bad "#174 README.md never names the maintainer backup of keys/program.json next to make setup / make localnet"
else
    ok "#174 README and docs/DEVNET.md name the program keypair backup before the deploy targets"
fi

# #175: the indexer-seed recipe passes VETO_RPC and VETO_PROGRAM_ID.
recipe=$(awk '/^indexer-seed:/{getline; print}' "$ROOT/Makefile")
if printf '%s' "$recipe" | grep 'VETO_RPC=' >/dev/null && printf '%s' "$recipe" | grep 'VETO_PROGRAM_ID=' >/dev/null; then
    ok "#175 indexer-seed recipe names VETO_RPC and VETO_PROGRAM_ID"
else
    bad "#175 indexer-seed recipe is '$recipe'; it names neither VETO_RPC nor VETO_PROGRAM_ID"
fi

# #176: every export, verify and produce command printed in the README, in
# docs/DECISION_RECORD.md and in the Makefile comment sets VETO_RPC or --rpc.
bare=$(grep -nE '^\s*(#\s*cd tools && )?npx tsx (produce|export|verify)\.ts' "$ROOT/README.md" "$ROOT/docs/DECISION_RECORD.md" "$ROOT/Makefile" \
    | grep -vE 'VETO_RPC=|--rpc' || true)
if [ -z "$bare" ]; then
    ok "#176 every printed npx tsx command sets VETO_RPC or passes --rpc"
else
    bad "#176 printed npx tsx commands with no VETO_RPC and no --rpc:"
    printf '%s\n' "$bare" | sed 's/^/    /'
fi

# #177: the DEVNET.md verify command must not require a gitignored keypair.
if grep -E '^solana program show ' "$ROOT/docs/DEVNET.md" "$ROOT/scripts/devnet-setup.sh" | grep -- '-k keys/deployer.json' >/dev/null; then
    bad "#177 solana program show still carries -k keys/deployer.json in docs/DEVNET.md or the devnet-setup.sh template"
else
    ok "#177 solana program show runs without a key file in the doc and the template"
fi

# #178: the three charges on 2026-09-20 paid 0.666. Later journeys pay the
# same merchant, so a live owner or merchant balance in the doc goes stale.
# The doc and the write_docs template state the payment and print no live figure.
template=$(awk '/^write_docs\(\) \{/{p=1} p{print} p && /^\}$/{exit}' "$ROOT/scripts/devnet-setup.sh")
if grep -E '^- Merchant token account' "$ROOT/docs/DEVNET.md" | grep 'holding zero' >/dev/null; then
    bad "#178 docs/DEVNET.md says the merchant token account holds zero; the three charges paid 0.666"
elif grep -q '999999\.334' "$ROOT/docs/DEVNET.md" || printf '%s\n' "$template" | grep '999999\.334' >/dev/null; then
    bad "#178 docs/DEVNET.md or the write_docs template prints the live owner balance 999999.334"
elif ! grep -q 'paid 0\.666 of that supply to the merchant across three charges' "$ROOT/docs/DEVNET.md"; then
    bad "#178 docs/DEVNET.md does not state that 0.666 was paid across three charges"
elif ! printf '%s\n' "$template" | grep 'paid 0\.666 of that supply to the merchant across three charges' >/dev/null; then
    bad "#178 the write_docs template does not state that 0.666 was paid across three charges"
elif ! grep -q 'A printed figure goes stale when a charge pays' "$ROOT/docs/DEVNET.md"; then
    bad "#178 docs/DEVNET.md does not say a printed figure goes stale"
elif ! printf '%s\n' "$template" | grep 'A printed figure goes stale when a charge pays' >/dev/null; then
    bad "#178 the write_docs template does not say a printed figure goes stale"
else
    ok "#178 docs/DEVNET.md states 0.666 paid across three charges and no live balance"
fi

# #179: a fresh export of CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g is nine
# decisions, six refused. The README table needs the fifth later refusal and
# DECISION_RECORD.md must not describe a five-row file.
fifth=SNZdXV6H5JCuPKxDB5K7ykMbADByXew2nNRuPiue6ETmSRUP9NZgqMuh3XgoEFDZnv7Ltx15JdBAwV7rrf8Umy8
rows=$(grep -cE '^\| 2026-09-2[0-9] [0-9:]+ \|.*\[refused\]\(https://explorer.solana.com/tx/' "$ROOT/README.md")
if [ "$rows" -ne 5 ] || ! grep -q "$fifth" "$ROOT/README.md" || ! grep -q '64852000' "$ROOT/README.md"; then
    bad "#179 README.md refusal table has $rows rows; a fresh export shows five later refusals including $fifth (64852000)"
elif grep -qE 'five paid|confirmed all five|\(`confirmed: 4`, `rejected: 1`\)' "$ROOT/docs/DECISION_RECORD.md"; then
    bad "#179 docs/DECISION_RECORD.md still describes a five-row export with confirmed: 4, rejected: 1"
elif ! grep -q 'confirmed: 9' "$ROOT/docs/DECISION_RECORD.md"; then
    bad "#179 docs/DECISION_RECORD.md does not state confirmed: 9 for the worked mandate"
else
    ok "#179 README table has five later refusals and DECISION_RECORD.md states nine decisions"
fi

# #180: scripts/gcp-verify.sh finds the deployed resources, so the doc must
# not say the deploy script has not been run, and every anchor it links must
# resolve to a heading in the same file.
gdoc="$ROOT/docs/GCP_SETUP.md"
if grep -qE 'has not been run|not in the project yet|do not exist' "$gdoc" "$ROOT/docs/PLAN.md"; then
    bad "#180 docs say the deploy has not been run; gcp-verify.sh lists the bucket, secret, jobs, scheduler and registry"
else
    missing=""
    for a in $(grep -oE '\]\(#[a-z-]+\)' "$gdoc" | tr -d '](#)' | sort -u); do
        heading=$(grep -E '^## ' "$gdoc" | sed 's/^## //' | tr 'A-Z' 'a-z' | tr ' ' '-')
        printf '%s\n' "$heading" | grep -x "$a" >/dev/null || missing="$missing $a"
    done
    for name in veto-watcher-260921-journal veto-agent-keypair veto-watcher-stale veto-watcher-cadence veto-watcher-stale-hourly 'passed: 30  failed: 6'; do
        grep -q -- "$name" "$gdoc" || missing="$missing $name"
    done
    if [ -n "$missing" ]; then
        bad "#180 docs/GCP_SETUP.md is missing:$missing"
    else
        ok "#180 docs/GCP_SETUP.md lists the deployed inventory and every anchor resolves"
    fi
fi

# #182: terminal typechecks against ../../watcher/src, so the terminal-test
# recipe has to install watcher deps the way ci.yml does.
trecipe=$(awk '/^terminal-test:/{getline; print}' "$ROOT/Makefile")
if printf '%s' "$trecipe" | grep -E 'watcher && npm (ci|install)' >/dev/null; then
    ok "#182 terminal-test recipe installs watcher deps"
else
    bad "#182 terminal-test recipe is '$trecipe'; it never installs watcher deps, so tsc fails on ../watcher/src"
fi

echo "journey 158 path 3 fix checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
