# Veto watcher

Unattended agent. It reads the live Nordic day-ahead electricity spot, converts a
fixed kWh volume into token base units as integers, and submits `charge` with the
agent key. The program decides. A refusal is a confirmed transaction with a reason,
not an error.

The price is real, public, and independently verifiable against the same URL. The
counterparty is a terminal we run, because no charge point operator accepts this
mint. Without demo calibration, amounts follow the spot price. Optional
calibration (watcher/src/calibration.ts) deliberately sizes some scheduled
requests above the limit for the configured demo rule. Tester rules bypass it.

The hosted demo agent runs in USDC mode, with VETO_QUOTE_CURRENCY=USD and
VETO_KWH_MILLI=6000 (see Quoting USDC).

## What it does

Four times per Stockholm day (00:00, 06:00, 12:00, 18:00) the process:

1. Reads `https://www.elprisetjustnu.se/api/v1/prices/YYYY/MM-DD_SE3.json` for the
   15-minute window that starts on that hour.
2. Converts a fixed 50 kWh volume to mint base units with integer arithmetic only.
   1 token is treated as 1 SEK. The test mint has 6 decimals (see `docs/DEVNET.md`).
   `VETO_QUOTE_CURRENCY=USD` converts that SEK amount into USDC first. See below.
3. Derives the on-chain nonce from the unix seconds of the cadence slot it
   chose, so a restart cannot double-charge a settled window and a feed that
   moves its window start cannot mint a second nonce for that slot.
4. Submits `charge`, signed by `keys/agent.json`.
5. Appends one JSONL row (signature, amount, decision, reason) and prints a
   one-line summary.

A down feed is a gap. The row is recorded, nothing is submitted, and no synthetic
price is invented. An RPC failure backs off and retries the same window. The
thread is not dropped. A rate limit is not a failure. The process logs that it
was throttled, tries the next configured endpoint (and re-walks a single
endpoint with bounded doubling), and leaves the cadence slot due so the next
cycle can still submit it. The outage is written as a gap with a reason that
names the rate limit, so it stays visible after midnight and `status` can
count it. A gap is not terminal.

The `PriceFeed` interface exists because the feed may be revisited
(`docs/internal/DECISIONS.md`, 2026-09-20). The only implementation is `EnergySpotFeed`.

## Every rule that names the agent

Each `once` or `run` pass also charges every other open payment rule on the
program whose agent is this process's agent key. A tester who approves a rule
for the agent's public address gets a request on the same schedule as the
configured rule.

Discovery is one `getProgramAccounts` call filtered on the Mandate
discriminator and the agent pubkey at byte 40, the same filters
`mandatesForAgent` in `sdk/src/read.ts` uses. Rows decode with the bundled IDL.
A rule is skipped, with one log line naming it and the reason, when it is
not open, is past expiry, is for another mint than `VETO_MINT`, pays another
payee than `VETO_MERCHANT`, has nothing left under its cap, or already has a
paid or refused row for this slot's nonce. The configured rule (`VETO_OWNER` +
`VETO_MANDATE_ID`) is left to its own journaled path, so it is charged once,
not twice.

Only the latest due slot is charged. A rule approved at 17:00 gets the 18:00
request, not a catch-up burst for the morning. The nonce is that slot's unix
seconds, the same number the configured rule uses, checked against each
rule's own `last_nonce` and ledger ring. The amount uses the same spot
arithmetic as the configured rule (volume, price, and FX when
`VETO_QUOTE_CURRENCY=USD`). Demo calibration is not applied, because it is
sized to the configured rule's cap. No price means no request.

A pass charges at most `VETO_AGENT_RULES_MAX` rules (default 25, at most 100,
`0` turns this off). When more are eligible, the starting point moves each
slot so every rule gets a turn. VETO_AGENT_RULES_MAX=0 also turns off the
configured rule's allow-once retry. No new charge in this pass starts after
`VETO_AGENT_PASS_BUDGET_MS` (default 480000, eight minutes). In `once` mode, no
new charge in this pass starts after 12 minutes of process uptime. That leaves
time before the job's 15 minute limit for a charge already in progress, but does
not guarantee that it finishes before that limit. Rules left over wait for the
next slot.

This pass runs last, after the configured rule and the hold alerts. Charges
are sequential with a 1.5 second pause. A send that is not confirmed within 90
seconds counts as failed. A rule that fails is logged and the next one is still
charged. A rate limit ends the pass, and the rest are charged next slot. A
failure here never changes the configured rule's outcome or the exit code.

Each charge logs `agent rule <address> paid|refused ... amount=... nonce=... sig=...`.
These charges are not written to the journal, because each rule's on-chain
ledger is the record. The RPC URL and keys are never logged.

The request follows the spot price, not your per-payment limit, so a
tight limit refuses the expensive hours and pays the cheap ones. A refusal
moves no money.

### Get ongoing charges from our demo agent

1. In the Veto app, open Rules, tap Write a rule, keep Payment rule selected
   and paste the agent address `6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w`
   in the Agent field (the Agent row in [docs/DEVNET.md](../docs/DEVNET.md)).
2. Set the payee to the demo payee `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG`.
   A rule with any other payee is skipped.
3. Use devnet USDC with 1 USDC per payment and 10 USDC in total, and approve
   the rule. The 10 USDC moves into the rule's own account.
4. Requests are scheduled for 00:00, 06:00, 12:00 and 18:00 Stockholm time,
   subject to service availability and the pass limits above. Requests above
   1 USDC are refused, and requests at or below it can pay if the other rule
   checks pass. Tester rules bypass calibration, so a mix of paid and
   refused requests is not guaranteed.
5. To request a retry, open the refused decision and press and hold
   "allow this one payment" (the program's `grant_override`). Normally the
   watcher checks on its next scheduled run. It uses the same nonce and
   amount, provided the rule and allowance remain usable, the refusal and
   allowance are still in the ledger ring, and the amount fits the raised
   ceiling and remaining cap. Delegation, balance, frozen accounts and other
   program checks can still stop payment. A recorded refusal after the
   allowance stops another automatic retry for that allowance. Service or
   RPC problems and per-pass limits can delay or prevent a retry. The log
   line is
   `agent rule <address> allow-one retry paid|refused amount=... nonce=... sig=...`.
   The configured rule uses the same retry checks before its slot charge,
   and its retry does not change the journal. A successful retry transaction
   records a paid or refused decision on the chain ledger.

## Hold alerts

`VETO_HOLD_VAULTS` is an optional comma-separated list of Hold vault addresses. When it is unset, the mandate loop is unchanged and no vault is read.

For each hold the watcher records an alert when the hold is created, at 1 hour, at 12 hours, every 12 hours after that, at 6 hours and 1 hour before unlock, and when the hold ends (paid, stopped, recovered, or skipped). Each alert is written once to `hold-alerts.jsonl` next to the decision journal, and printed on the watcher's log line. When `VETO_JOURNAL_GCS` is set, that file is stored beside the decision object, so a restart does not raise the same alert again.

Hold is merged and tested, and live on devnet. The app screens exist. A completed device check of Hold with a real vault is not recorded in this repository yet. Vault `2Tk8Qfd23udSkHZAQvx8x1TXU166n26HtjzCjaSeoqaU` is on the deployed program, recorded in [docs/DEVNET.md](../docs/DEVNET.md).

## Setup

From the repo root. Node 22 or newer. Keypairs live under gitignored `keys/` as
listed in `docs/DEVNET.md`. The typed client is generated from the Anchor IDL
at `watcher/idl/veto.json` (copied from `target/idl/veto.json` when present).

```bash
cd watcher
npm ci
npm test
npm run build
```

Open a mandate once. It takes the owner signature, and the owner key pays the rent.

```bash
npm run open-mandate
```

RPC, program id, mint, and the owner, merchant and agent accounts come from
the environment, `keys/devnet-addresses.env`, `watcher/.env`, or
`terminal/.env`. The configured rule's charge source is `VETO_OWNER_TOKEN`.
A rule opened in the app keeps its budget in `veto-rule-<mandate id>`. The
other rules that name the agent are charged from the source stored in each
rule (see above). There is no hardcoded fallback for those. File keys may be
`VETO_RPC=` or `RPC=`. Both packages read both package env files, so they
cannot silently disagree about the quoted volume. Copy `.env.example` to
`watcher/.env` and uncomment the identity lines with values you supply. The
placeholders do not resolve.

These process defaults cannot select a chain identity, and env overrides each one.

| | |
|---|---|
| RPC | `VETO_RPC`, required. One URL, or several separated by commas, tried in order. |
| Volume | 50 kWh (`VETO_KWH_MILLI=50000`) |
| Cap | 100 tokens |
| Per-payment max | 0.5 tokens |
| Mandate id | 1 |
| Purpose | `SE3 home charging` |
| Other rules per pass | 25 (`VETO_AGENT_RULES_MAX`, `0` turns it off) |
| Pass time budget | 480000 ms (`VETO_AGENT_PASS_BUDGET_MS`) |
| RPC response header timeout | 20000 ms per attempt to one endpoint (`VETO_RPC_TIMEOUT_MS`); body reads are outside this timeout. An endpoint that times out is skipped for the rest of that request, and another endpoint is tried if available. |

0.5 tokens per 50 kWh is 0.01 SEK/kWh. On 2026-09-20 that pays the cheapest night
and midday dips and refuses the evening spike. Raise `VETO_PER_TX_MAX` before
opening if you want a looser ceiling. Opening is a chain instruction, so changing
the env later does not rewrite an existing mandate.

## Quoting USDC

Set `VETO_QUOTE_CURRENCY=USD` to convert the SEK spot into USDC before `charge`.
Unset, empty, or `SEK` keeps the arithmetic above, byte for byte, with 1 token as 1 SEK.

The demo mint for this mode is Circle's devnet USDC,
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals. Set `VETO_MINT` to
that address. The watcher does not assume a rate.

The rate is the European Central Bank daily reference,
`https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`. The file is
public and needs no key. It is one XML document. The watcher reads the `Cube`
whose `time` is `YYYY-MM-DD`, and the `Cube` elements whose `currency` is `USD`
and `SEK`. Both rates are quoted against EUR, so USD per SEK is the USD rate
divided by the SEK rate. The division is integer. A failed read, a non-2xx
response, a body that cannot be parsed, or a missing currency writes a gap
with reason `fx unavailable`, submits nothing, and leaves the slot due. No
rate is invented.

The fixing date has to fall within 4 calendar days of the slot, on the
Stockholm calendar. Friday's fixing serves the weekend and Monday morning.
An older fixing, or one dated after the slot, writes a gap with reason
`fx rate stale (<fixing date>)`, submits nothing, and leaves the slot due.

Paid rows, refused rows, and these fx gap rows may carry `quote_currency`,
`fx_rate`, `fx_date`, and `fx_source`. `fx_rate` is USD per SEK as a decimal
string with 8 places, produced by integer division. Older rows without those
fields still load. The paid and refused log line names the converted amount,
the SEK price, the fx rate, and its date.

The demo is sized at 6 kWh, 0.50 USDC per payment, a 20 USDC cap, and 40 days.
Set `VETO_KWH_MILLI=6000`, `VETO_PER_TX_MAX=500000`, and `VETO_CAP=20000000`.
6 kWh at 0.3 to 1.6 SEK per kWh is about 0.17 to 0.95 USD at roughly 10 SEK
per USD. That 10 is a size check only. The rate on a charge is the ECB rate
that was read, not an assumed rate.

`scripts/deploy-watcher-cloud.sh` passes `VETO_QUOTE_CURRENCY` to both Cloud
Run jobs when the variable is set in the environment. It does not invent a
default. Unset leaves both jobs on the SEK arithmetic.

## Pointing at a dedicated RPC

The public cluster URL is shared and will 429 under load. `VETO_RPC` is a list,
read from the environment (or `watcher/.env`, or `keys/devnet-addresses.env`
`RPC=`). Put a dedicated JSON-RPC URL first and keep the public cluster URL
from `docs/DEVNET.md` after it as fallback. No code change is required.

```bash
VETO_RPC=<dedicated>,<public> npm start
```

On HTTP 429 the watcher backs off, tries the next URL, and logs `rpc rate limited`
rather than `rpc failure`. Those need different responses from a person. A slot
that only saw a rate limit is written as a gap row with reason `rpc rate limited
on all endpoints`. A gap is not terminal, so the slot stays due and is tried again.

## How to run it

Run one pass over due slots, which is useful after a restart.

```bash
npm run once
```

Run a specific elapsed 15-minute window, which must not be in the future.

```bash
node dist/index.js once --window 2026-09-20T01:30:00+02:00
```

Or stay up.

```bash
npm start
```

That is `node dist/index.js run`. It processes any of today's due slots that are
not already in the journal, then sleeps until the next cadence tick. SIGINT and
SIGTERM finish the current slot and exit.

## How to keep it running

The process has to outlive a laptop lid, or the slots that pass while it is down are missing from the journal. Pick one.

With tmux, run this on the machine that can reach the RPC:

```bash
tmux new -s veto-watcher 'cd /path/to/veto/watcher && npm start'
```

Detach with `Ctrl-b d`. Reattach with `tmux attach -t veto-watcher`. A restart
of the box still needs something that launches tmux again.

With launchd on macOS, as a user agent, edit the paths, save the file as
`~/Library/LaunchAgents/se.veto.watcher.plist`, then `launchctl load` it.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>se.veto.watcher</string>
  <key>WorkingDirectory</key><string>/path/to/veto/watcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>dist/index.js</string>
    <string>run</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/veto-watcher.log</string>
  <key>StandardErrorPath</key><string>/tmp/veto-watcher.err</string>
</dict>
</plist>
```

If the laptop cannot stay up, use Cloud Run as described in [CLOUD.md](CLOUD.md). That path
persists the journal in Cloud Storage and runs `once` on the cadence.

## How to read the JSONL

Rows land in `watcher/data/decisions.jsonl` (override with `VETO_JOURNAL`). One
JSON object per line, snake_case keys. `data/` is gitignored.

```bash
npm run status
```

```bash
# counts
jq -r .decision data/decisions.jsonl | sort | uniq -c

# the diary
jq -r '[.ts, .decision, .reason, .amount, .window_start, .signature] | @tsv' data/decisions.jsonl

# one row
jq . data/decisions.jsonl | less
```

| Field | |
|---|---|
| `decision` | `paid`, `refused`, `gap`, or `skipped` |
| `reason` | For example `ok`, the on-chain reason text, `feed unavailable`, `fx unavailable`, `fx rate stale (YYYY-MM-DD)`, `zero amount`, `negative price`, `rpc rate limited on all endpoints`, `window start does not match slot`, `unreadable price: ...`, `stale nonce; chain did not confirm this window paid`, `chain shows this window paid; signature could not be recovered`, `window overtaken by a later settled charge` |
| `quote_currency` | Optional. `USD` on paid, refused, and fx-gap rows when conversion is on. Older rows omit it. |
| `fx_rate` | Optional. USD per SEK, 8 decimal places, integer division of the two EUR rates. Null when the rate was not read. |
| `fx_date` | Optional. ECB fixing date `YYYY-MM-DD`. Null when the fixing was not read. |
| `fx_source` | Optional. The ECB document URL. |
| `reason_code` | on-chain u8, or null when the chain was not called |
| `amount` | mint base units, decimal string of an integer |
| `nonce` | unix seconds of the cadence slot |
| `signature` | confirmed transaction, or null when no transaction confirmed for this row. A gap or skip left by a stale-nonce race carries the refused transaction's signature. A paid row can carry null when the signature could not be recovered |
| `sek_per_kwh` | decimal string copied from the feed body |

`refused` is a success path. Count it and keep going. `gap` means the feed or the
FX source did not yield a rate that could be charged. Nothing is submitted,
and there is no invented price or invented rate in that row. The slot stays due.

The first live rows, on 2026-09-20 with 50 kWh and a 0.5 token per-payment max, ran against the
cluster in `docs/DEVNET.md`.

- paid 446000 base units at 00:00 Stockholm, SEK/kWh 0.00892,
  `4N13AokSVj2A9fJyCZiypzhG9P6mdpMvpjcnDvzVUi2Qp6jUx1Ud34tHUDt1TQENzXu7TFWTfrKHHCLfrpKTBJ9a`,
  block time 2026-09-20 20:58:03 UTC, log `VETO PAID amount=446000`
- refused 6232500 base units at 18:00 Stockholm, SEK/kWh 0.12465, over
  per-payment maximum,
  `3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib`,
  block time 2026-09-20 20:58:12 UTC

On that 00:00 payment alone, the owner token account went from 1000000 to
999999.554 and the merchant received 0.446. The same evening also paid 0.2145
and 0.0055. The refused row moved nothing.

## Regenerating the IDL

Devnet stays upgradeable under the deployer key. Regenerate the IDL when the
program changes, and never from this package. `watcher/idl/veto.json` is the
IDL the image copies. `watcher/src/idl.ts` is a type helper whose header points
at that JSON file. It also carries doc comments. This command writes the JSON
and a types file without those doc comments.

```bash
anchor idl build -p veto -o watcher/idl/veto.json -t watcher/src/idl.ts --no-docs -- --lib
```

`--lib` is required so the build does not compile `tests/` which embed `veto.so`.
Anchor is not required to read the committed JSON.

## Tests

```bash
npm test
```

The tests cover:

- Integer money conversion, with no float in the money or FX source
- A deterministic nonce
- No resubmit when the same window runs again
- A refusal recorded rather than thrown
- A gap written when a feed is down
- Failover on a 429, with a rate limited slot staying due
- An ECB document converting three known rows
- A stale fixing or an unreachable FX source leaving the slot due
- USD off matching today's base units
- For the other rules naming the agent: the discovery filters, the per-pass cap and its rotation, one failing rule not stopping the rest, and no second charge for the configured rule or a slot already decided
