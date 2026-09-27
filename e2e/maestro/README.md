# Android Maestro suite

These flows target `com.veto.app` on devnet using the Solana Mobile fake wallet,
`com.solana.mobilewalletadapter.fakewallet`. Device execution is reserved for the
lead. All seven flows have passed on an Android emulator with the fake wallet
against the devnet deployment; the offline checks below cover YAML syntax and the funding helper.

## Prepare the emulator later

1. In Android Studio Device Manager, create an Android virtual device compatible
   with the Veto APK. Start it and confirm its serial is `emulator-5554`. Use the
   emulator only, with the owner's phone left alone. Every command below pins the
   emulator explicitly.
2. Install Maestro following its [installation guide](https://docs.maestro.dev/getting-started/installing-maestro).
3. Obtain the fake wallet from the official
   [Mobile Wallet Adapter releases](https://github.com/solana-mobile/mobile-wallet-adapter/releases),
   or build the `fakewallet` Android module from that repository. Inspect the APK
   in Android Studio APK Analyzer and confirm its application ID is
   `com.solana.mobilewalletadapter.fakewallet`. Drag the APK onto the emulator to
   install it. Use the version with `AUTHORIZE` and `SEND TRANSACTION TO CLUSTER`.
   Keep it as the emulator's only MWA wallet so no wallet chooser interrupts flows.
4. Configure Veto with `app/.env.example`, the devnet RPC and program from
   `keys/devnet-addresses.env`, and the desired payment/Hold mint. The standard
   build uses devnet USDC with six decimals. Install a `com.veto.app` APK by
   dragging it onto the emulator. Use a bundled build or open the custom dev
   client and connect it to Metro before starting flow 01. Expo Go cannot load
   the wallet native modules. See [app setup](../../app/README.md).
5. Keep Android display/font scaling at its default and dismiss development
   menus or onboarding overlays. The fake wallet creates a new test account on
   every authorization (see
   [Solana Mobile's development wallet setup](https://docs.solanamobile.com/get-started/development-setup));
   the funding loop below covers each one.

## Addresses and funds

From the repository root, load the existing local devnet setup. `keys/` is
ignored and is provisioned separately; the suite does not generate owner keys.

```bash
set -a
source keys/devnet-addresses.env
set +a
export VETO_RPC="$RPC"
export PAYEE="$MERCHANT"
export GUARDIAN='<public address of the second Seeker key>'
export SAFE='<public address of an independent recovery wallet>'
: "${AGENT:?required}" "${PAYEE:?required}" "${GUARDIAN:?required}" "${SAFE:?required}"
```

`AGENT` must match the laptop signer in `keys/agent.json`. `PAYEE` is a wallet
address, not its token account. Owner, agent and payee must be distinct. Use a
valid guardian address different from the owner and a safe wallet controlled
independently of the owner. The Hold flow deliberately supplies the safe address
and reviews it; it does not accept the owner-wallet recovery-risk exception.

The fake wallet creates a new account every time it authorizes, and every
flow authorizes again when it replays its prerequisites. The account a flow
signs with therefore exists only once that flow is running, so fund it while
the flow runs. From the repository root, with the emulator running and
`solana` on PATH configured for the devnet RPC, keep this loop running in a
second terminal during the flows, with a funded devnet keypair as the funder:

```bash
while sleep 6; do
  e2e/maestro/helpers/fund-fake-wallet.sh emulator-5554 keys/deployer.json 1 2
done
```

Each call sends SOL and devnet USDC to the newest account only where it lacks
them, so later calls leave a funded account alone and an account left with SOL
but no USDC still gets its USDC. A balance that cannot be read counts as empty. Before approving, the payment
flow waits up to 90 seconds for the app's wallet checks to see the funds.

The helper requires an explicit `emulator-NNNN` serial and refuses any other,
so it cannot address a physical phone. It refuses unless the configured RPC
reports the devnet genesis hash. It reads only the `public_key_b64` column of
the newest row in the fake wallet key table through `adb exec-out run-as`,
base64-decodes the 32 raw public key bytes (standard or URL-safe base64,
padding optional), base58-encodes them into the account address, prints that
address, and funds it from the given funder keypair with 1 SOL and 2 devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), passing
`--fund-recipient` so the token account is created. One SOL covers rent, fees
and the trade rule's 0.20 SOL cap; flow 04 sets aside 1 token and flow 06
deposits 1 token. Fund the laptop agent with SOL for request transaction fees
too.

With a custom payment/Hold mint, fund the fake wallet manually instead: copy
the full account address from the fake wallet's authorization/account UI, not
Veto's shortened display, transfer that exact mint from the existing funded
devnet setup, and add SOL from the Solana devnet faucet or an already funded
devnet wallet on the laptop.
The `OWNER` in the env file is not necessarily the fake wallet account.
Every authorization creates a new fake wallet account; the funding loop above
covers each one.

## Run each flow

Flows 01 to 06 are independently runnable from a cleared app. Each one starts with
`launchApp` with `clearState: true` and replays the steps it depends on through
the chained helpers in `e2e/maestro/helpers/`, so no flow relies on screen
state left by a previous Maestro invocation. 07 is the exception: it runs right
after a rule-creating flow (04 to 06) and a refusal sent from the laptop. The replay chain is:

| Helper | Replays | Ends on |
| --- | --- | --- |
| `helpers/reach-authorize.yaml` | nothing (clears Veto, taps the cards, Connect wallet) | Pending AUTHORIZE sheet |
| `helpers/connect-wallet.yaml` | reach-authorize | Agent paste choice |
| `helpers/enter-agent.yaml` | connect-wallet | Unsigned first-run review |
| `helpers/approve-payment-rule.yaml` | enter-agent | First-run live screen |
| `helpers/reach-main-tabs.yaml` | approve-payment-rule, then relaunches Veto | Main tabs |

The top-level flows are thin wrappers: 01 runs reach-authorize, 02 runs
connect-wallet, 03 runs enter-agent, 04 runs reach-main-tabs, and 05 and 06
run reach-main-tabs before their own steps. 07 replays nothing: it relaunches
Veto without clearing it, because the fake wallet creates a new account on
every authorization and a reconnect would land on an account with no rules. Because
each flow replays its prerequisites, environment requirements accumulate: 05
also needs `PAYEE`, and 06 also needs `AGENT` and `PAYEE` for the replayed
payment rule.

Execute from the repository root, one flow per invocation, with the funding
loop running. Run 01 to 06 in any order; run 07 last, right after a
rule-creating flow and a refusal generated from the laptop against that
flow's payment rule, as described below.

```bash
maestro --device emulator-5554 test e2e/maestro/01-onboarding.yaml
maestro --device emulator-5554 test e2e/maestro/02-connect.yaml
maestro --device emulator-5554 test -e AGENT="$AGENT" e2e/maestro/03-add-agent-paste.yaml
maestro --device emulator-5554 test -e AGENT="$AGENT" -e PAYEE="$PAYEE" e2e/maestro/04-payment-rule.yaml
maestro --device emulator-5554 test -e AGENT="$AGENT" -e PAYEE="$PAYEE" e2e/maestro/05-trade-rule.yaml
maestro --device emulator-5554 test -e AGENT="$AGENT" -e PAYEE="$PAYEE" -e GUARDIAN="$GUARDIAN" -e SAFE="$SAFE" e2e/maestro/06-hold.yaml
# Right after 04, 05 or 06, generate a refusal against that invocation's
# payment rule from the laptop as described below, then run 07.
maestro --device emulator-5554 test e2e/maestro/07-decisions.yaml
```

| Flow | Replays | Adds | Observable result |
| --- | --- | --- | --- |
| 01 | nothing | Introduction and Connect wallet | Four introduction cards, then pending AUTHORIZE |
| 02 | 01 | AUTHORIZE approval | Connected, Add your agent opens paste choice |
| 03 | 01, 02 | Agent address and name | Address and local name entered, review sentence shown unsigned |
| 04 | 01, 02, 03 | Payee, limits, approval | Agent entered, payee pasted on the scan fallback, 0.1 per payment and 1 total typed, rule live, main tabs |
| 05 | 01 through 04 | Trade rule | Trade rule, supplied agent, unchanged Trading bot defaults, chain detail |
| 06 | 01 through 04 | Hold vault | Hold, amount 1, wait 1 day, second Seeker and reviewed safe address, live vault |
| 07 | nothing (keeps the previous flow's state) | Refusal read | Pull refresh, refused row, detail says No money moved. |

The Connect wallet and Add your agent taps use anchored text with the inline
`(?-i)` case-sensitive flag. Maestro text matching is case-insensitive by
default and selects the deepest matching element before filtering for
clickability, so the strip labels CONNECT WALLET and ADD YOUR AGENT, which are
plain non-clickable Text, would otherwise match and win over the button; the
flag limits the match to the button's exact-cased label.
Amount fields use the current form's
accessibility labels, including `Most per payment` and `Most in total, ever`.
Approvals use [Maestro longPressOn](https://docs.maestro.dev/reference/commands-available/longpresson),
which holds for 3 seconds. The full button label includes its hint, so its
selector allows a suffix. The shared wallet subflow accepts AUTHORIZE when
reauthorization appears and always requires SEND TRANSACTION TO CLUSTER.
Chain confirmation is asserted back in Veto, not inferred from the wallet tap.
Hold also handles the authorization request made when its guardian screen reads
the wallet account list, before showing the guardian fields.

03 tests paste/name/review without signing its first-run proposal. It ends on
the review sentence, because the approve button only renders once a payee is
set. 04 replays 01 through 03 back to that first-run review, where the pasted
agent is already kept, pastes the payee through the payee scan's paste field, types
0.1 per payment and 1 total, and approves with the long press. The first-run
live screen confirms the rule, then 04 relaunches Veto so it and every later
flow start their own steps on the main tabs. The
new rule is listed under Rules like any other. Trade defaults are 0.01 SOL per trade,
0.05 SOL per day, 0.20 SOL total, 90 percent floor and 7 days. The listed pool
comes from `app/lib/pools.ts` and must exist on the configured devnet deployment.

Every run of 04, 05 or 06 replays first-run and approves fresh on-chain rules
or vaults, and clearing Veto data does not remove chain accounts. Each
invocation signs with a new fake wallet account, so its Rules list shows only
what that invocation approved.
Before a new full pass, return unused
funds through the app's normal close actions or fund a fresh test wallet.
To retry a failed flow, just run it again; its replay rebuilds everything it
needs. If a transaction was submitted, inspect its chain result before
submitting again.

## Drive requests from the laptop

Keep the same exported `keys/devnet-addresses.env` variables loaded. Install SDK
dependencies with `npm ci --prefix sdk`. Use the rules just created by the fake
wallet, not an old rule owned by the setup wallet.

For the payment rule, open its detail from Rules, use its agent setup panel's
`Copy all`, and save the JSON locally as `keys/maestro-payment-config.json`.
For the trade rule, obtain its full rule address from the opening transaction's
explorer record and set `TRADE_RULE` to that address. The SDK supports `--rule`
so no trade config export is needed. Return to Rules after recording these.
All example amounts below are integer base units.

```bash
export TRADE_RULE='<full address of the trade rule from flow 05>'
cd sdk
# With the standard six-decimal payment mint: 0.05 paid, then 0.20 refused
# by the 0.10 per-payment maximum, without exceeding the remaining total cap.
npx tsx examples/pay-once.ts ../keys/agent.json ../keys/maestro-payment-config.json 50000
npx tsx examples/pay-once.ts ../keys/agent.json ../keys/maestro-payment-config.json 200000
# Honest trade of 0.001 SOL, below the unchanged template limits.
npx tsx examples/trade-once.ts ../keys/agent.json --rule "$TRADE_RULE" 1000000
# Full hostile trade demonstration, using a separate funded trader key.
npx tsx examples/hacked-agent.ts ../keys/agent.json --rule "$TRADE_RULE" 1000000 ../keys/second-trader.json
cd ..
```

Adjust payment base units if the configured mint has different decimals. Expect
`paid` then `refused` from pay-once, and `traded` from trade-once. Save the printed
transaction signatures for debugging and check their results before flow 07.

The hostile example requires `TOKEN_SWAP_POOL`, `TOKEN_SWAP_AUTHORITY`,
`TOKEN_SWAP_WSOL_VAULT`, `TOKEN_SWAP_USDC_VAULT`, `TOKEN_SWAP_POOL_MINT` and
`TOKEN_SWAP_FEE_ACCOUNT` from the existing devnet pool setup in the env file.
They must match the live trade rule. See [devnet deployment](../../docs/DEVNET.md)
and `sdk/examples/hacked-agent.ts`. Provision `keys/second-trader.json` separately
with SOL for fees and enough wrapped SOL to move that demo pool's rate; it must
differ from owner and agent. The script checks destination, pool, per-trade,
price floor and daily refusals, restores its price-moving swap, then exhausts
the daily allowance. Run the honest trade first. Rerunning the hostile script
against an exhausted rule needs a new rule or a new allowance day. Do not run
it against any pool other than the designated devnet demo pool.

Before 07, run a rule-creating flow (04 or later) in its own invocation. Each
of them approves a payment rule, and Decisions shows that payment rule, also
after 05 or 06 add a trade rule or a vault. Generate the refusal against that
payment rule from the laptop with `pay-once`, not against a trade rule. Do not
run another flow between the refusal and 07: 07 relaunches Veto without
clearing it and reads Decisions for the connected account. It never reconnects, because the fake wallet would create a new
account with no rules. Its `Refused, recorded` assertion targets a real
row's accessibility text, not the `Refused` filter, and opens that row to assert
`No money moved.`. A missing refusal should fail, not be skipped.

## Offline validation

From the repository root, Ruby's standard YAML parser can parse every document
without invoking Maestro or connecting to a device:

```bash
ruby -ryaml -e 'Dir["e2e/maestro/**/*.yaml"].sort.each { |f| docs = YAML.load_stream(File.read(f)); abort "Invalid flow: #{f}" unless docs.size == 2 && docs[0]["appId"] == "com.veto.app" && docs[1].is_a?(Array); puts "OK #{f}" }'
git diff --check
```

The funding helper is checked the same way, with adb, solana and spl-token
stubbed so no device, emulator or cluster is touched:

```bash
e2e/maestro/helpers/fund-fake-wallet.test.sh
shellcheck -S error e2e/maestro/helpers/fund-fake-wallet.sh e2e/maestro/helpers/fund-fake-wallet.test.sh
```

These check YAML syntax and document shape, and exercise the funding helper
against stubbed tools. They do not verify Android
layout, MWA interoperability, devnet availability or transaction success; the
emulator runs above do. No production code is changed by this suite.
