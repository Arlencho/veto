# Android Maestro suite

These flows target `com.veto.app` on devnet using the Solana Mobile fake wallet,
`com.solana.mobilewalletadapter.fakewallet`. Device execution is reserved for the
lead. Authoring validation is offline YAML parsing only; no device run is claimed.

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
   menus or onboarding overlays. Do not force-stop the fake wallet between flows.
   Its test account can change when its process exits, as described in
   [Solana Mobile's development wallet setup](https://docs.solanamobile.com/get-started/development-setup).

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

Run 01 and 02, then pause before approval flows. Copy the full account address
from the fake wallet's authorization/account UI, not Veto's shortened display.
Fund that account with devnet SOL for rent, fees and the trade rule's 0.20 SOL
cap. A devnet faucet allocation of 1 SOL leaves room for these operations.
Use the Solana devnet faucet or an already funded devnet wallet on the laptop.
Fund the laptop agent with SOL for request transaction fees too.

Send the fake wallet at least 2 units of the configured payment/Hold token:
flow 04 sets aside 1 token, and flow 06 deposits 1 token. With the standard
USDC build, use the [Circle faucet](https://faucet.circle.com/) for devnet USDC.
With a custom mint, transfer that exact mint from the existing funded devnet
setup. The `OWNER` in the env file is not necessarily the fake wallet account.
If the fake wallet account changes, reconnect Veto and fund the new account.

## Run each flow

Execute these separately, in order, from the repository root. Do not pass the
whole directory to Maestro: 01 resets Veto, 02 continues its pending wallet
request, and 07 needs laptop-generated chain history. None of 02 through 07
restarts the fake wallet, and only 04 relaunches Veto to leave the unsigned
first-run review, so screen and session prerequisites matter.

```bash
maestro --device emulator-5554 test e2e/maestro/01-onboarding.yaml
maestro --device emulator-5554 test e2e/maestro/02-connect.yaml
# Pause here to fund the fake wallet account.
maestro --device emulator-5554 test -e AGENT="$AGENT" e2e/maestro/03-add-agent-paste.yaml
maestro --device emulator-5554 test -e AGENT="$AGENT" -e PAYEE="$PAYEE" e2e/maestro/04-payment-rule.yaml
maestro --device emulator-5554 test -e AGENT="$AGENT" e2e/maestro/05-trade-rule.yaml
maestro --device emulator-5554 test -e GUARDIAN="$GUARDIAN" -e SAFE="$SAFE" e2e/maestro/06-hold.yaml
# Generate a refusal and select its rule as described below before 07.
maestro --device emulator-5554 test e2e/maestro/07-decisions.yaml
```

| Flow | Starting state | Observable result |
| --- | --- | --- |
| 01 | Installed Veto, fake wallet available | Four introduction cards, then pending AUTHORIZE |
| 02 | Pending authorization from 01 | Connected, Add your agent opens paste choice |
| 03 | Agent choices from 02 | Address and local name entered, rule review shown unsigned |
| 04 | Relaunched Veto on the main tabs | Rules > Write a rule, typed 0.1 per payment and 1 total, active chain rule |
| 05 | Rules tab | Trade rule, supplied agent, unchanged Trading bot defaults, chain detail |
| 06 | Rules tab | Hold, amount 1, wait 1 day, second Seeker and reviewed safe address, live vault |
| 07 | Main tab, selected rule with a recorded refusal | Pull refresh, refused row, detail says No money moved. |

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

03 tests paste/name/review without signing its first-run proposal, leaving the
app on a review screen with no Rules tab. 04 relaunches Veto, opens Rules from
the main tabs and explicitly enters the same agent in a new payment rule. This
keeps the requested Rules entry covered. Trade defaults are 0.01 SOL per trade,
0.05 SOL per day, 0.20 SOL total, 90 percent floor and 7 days. The listed pool
comes from `app/lib/pools.ts` and must exist on the configured devnet deployment.

Repeated approval flows create additional funded rules or vaults. Clearing
Veto data does not remove chain accounts. Before a new full run, return unused
funds through the app's normal close actions or fund a fresh test wallet, then
start at 01. To retry only a failed flow, restore its starting screen first.
If a transaction was submitted, inspect its chain result before submitting again.

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

Before 07, open the payment rule (or the trade rule after a successful hostile
run) from Rules to select it, then use its Rules back control to return to the
main tabs. If Hold's Done left you on the vault home, use Close first. 07 reads
the currently selected rule. Its `Refused, recorded` assertion targets a real
row's accessibility text, not the `Refused` filter, and opens that row to assert
`No money moved.`. A missing refusal should fail, not be skipped.

## Offline validation

From the repository root, Ruby's standard YAML parser can parse every document
without invoking Maestro or connecting to a device:

```bash
ruby -ryaml -e 'Dir["e2e/maestro/**/*.yaml"].sort.each { |f| docs = YAML.load_stream(File.read(f)); abort "Invalid flow: #{f}" unless docs.size == 2 && docs[0]["appId"] == "com.veto.app" && docs[1].is_a?(Array); puts "OK #{f}" }'
git diff --check
```

This checks YAML syntax and document shape only. It does not verify Android
layout, MWA interoperability, devnet availability or transaction success. Those
remain the lead's emulator checks. No production code is changed by this suite.
