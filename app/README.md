# Veto Android app

Expo custom-dev-client app for a Solana Seeker. Android only. Expo Go cannot
load Mobile Wallet Adapter native modules, so this project is built as a
custom dev client APK.

Do not add an iOS or web target.

## Headless checks

From this directory:

```bash
npm run typecheck
npx expo config
npm test
```

`npm test` runs the pure module tests (wallet, templates, reason text, ring
decode, amount formatting, config, ruleset apply, purpose stamping, export
scope, read states). They do not need a device. Mobile Wallet Adapter
`authorize` and the Seed Vault signature for `open_mandate` /
`grant_override` / `revoke_mandate` still have to be checked on a Seeker.

## Devnet journey

From the repo root:

```bash
make e2e-devnet
```

That runs `app/e2e/devnetJourney.test.ts` with `VETO_E2E=1`. Without that
variable the file skips, so `npm test` does not talk to a cluster. The target
installs `app`, `sdk`, `indexer`, and `tools`, then drives devnet.

It needs `keys/deployer.json` (gitignored). That key is the mint authority for
the demo mint in `docs/DEVNET.md`. The run generates a fresh owner and a fresh
agent, funds the owner with SOL and that mint, and funds the agent with SOL
for fees. The payee is the merchant already on devnet.

Owner transactions go through `openMandate`, `grantOverride`, `revokeMandate`,
`closeMandate`, `readRuleFunds`, and `probeOverride`, signed by a keypair
stand-in for the Mobile Wallet Adapter `signAndSendTransactions` interface.
Charges go through `@veto-hq/agent-sdk`. Each step is checked against token
balances, delegates, account existence, ledger rows, and events. Every charge
is then exported with `tools/export.ts` and checked with `tools/verify.ts`.

The run prints a summary table. While the steps are in progress it writes
that table to a temporary file, and it replaces `app/e2e/last-run.md` only
when the run completes. A run that stops early leaves the committed file
alone and keeps the partial table in `app/e2e/last-run.partial.md`, which is
gitignored. This does not replace the Seeker check above. Seed Vault is
still required for a signature on a device.

## First launch

A fresh install, with no stored session and with `veto.onboarding.seen` unset, starts at Learn. The progress strip names five stages: Learn, Connect wallet, Add your agent, Approve the rule, and Live.

Learn is four steps: "Your agent can only ask.", "You set one rule.", "Ask too much, get nothing.", and "You decide." The first step says the owner key stays in Seed Vault. Skip or Connect stores `veto.onboarding.seen`. Connect continues. After the wallet is connected the run adds the agent (scan, paste, or create a test agent), names it, approves the rule with Press and hold to approve in Seed Vault, and shows the rule live. After Live, the same run hands the agent its setup (the same JSON as Copy all, and a QR) and offers alerts. Those two screens stay on the Live stage of the strip.

A later launch, or an owner restored from the session, does not start at Learn again. Help opens How Veto works at `/onboarding` and does not clear the seen flag. The introduction route itself has no Help control.

With no rule on chain, Overview shows Open your first rule.

## Sign-in

Connect runs `transact`, then `authorize`, against the Seed Vault wallet through
Mobile Wallet Adapter. `authorize` identifies the app as name `Veto`, uri
`https://veto-hq.github.io`, icon `/icon.png`. The agent public key is shown truncated on Overview,
Rules, Agents, Decisions, and the rule screen. The rule screen also truncates the
payee. The owner public key is not rendered. The authorization token is stored
in `expo-secure-store` so a returning user is not prompted again. Disconnect
deauthorizes that token and clears it.

When the new rule screen leaves the agent address empty, the phone generates
an agent keypair with `@solana/web3.js` and stores it in `expo-secure-store`.
A filled address is the public key of an agent that runs elsewhere, and this
phone does not store a secret for it. The agent is a different key from the
owner. It holds authority and no funds. The owner private key is never written
to storage.

Opening a rule derives a token account from the owner with the seed
`veto-rule-<mandate id>` (`createAccountWithSeed`). The same owner signature
creates that account, moves the cap into it from the owner's associated token
account, and opens the mandate with that account as the source. Close rule
returns the remaining balance and closes the token account, so the rent comes
back with the mandate rent and the ledger rent. Revoke clears the delegate on
that account only. A rule whose source is still the associated token account
still closes, and that token account stays.

## Owner screens

Four tabs, all Android. The labels are Overview, Rules, Agents, and Decisions. Overview is the home screen. Share is an action on a decision. Revoke is an action on a rule. Neither is a tab. Help is reachable from every tab. Overview and Rules each have one entry that opens Hold.

- **Overview.** What the selected agent can still spend, the day of the rule, the paid count, refusals in a row, and the latest decisions from today. A refusal is the inverted block: "Your rule held. No payment made." Never styled as an error. A renewal banner appears during the last seven days before an active rule ends. The quiet note is opened from here.
- **Rules.** Every rule the owner holds, each with purpose, spent against cap, time left, its own agent key, and its state. Switching one makes Overview and Decisions about it. Templates still prefill a blank form and never ship history or prices. A ruleset is authored on the phone; applying one to a new agent is one action. The ruleset itself is not on chain. Its name and version are written into the purpose, which is.
- **Agents.** One card per agent, grouped across every rule that agent is on. The name comes from the phone address book. With no saved name the title is Unnamed agent, with Name this agent, and the address once. The card opens that agent's record: the grade, paid and refused counts, the request strip, why the rule refused, and the latest plaques. How grades work states the four rules below.
- **Decisions.** Filters are All, Paid, Refused, Allowed once, and Agent's own declines. Rows say in plain words what happened. Numbers come from the chain. Amounts on screen show at most two decimal places. The decision detail and the export keep the exact amount. A paid row names the rule's payee. When the signature is found, the row links See it on the blockchain. When it is not, the row says Saved on the blockchain. A refusal that names a suggested override offers granting it as one action, after a live check that the rule is still active and the nonce is still unsettled. The owner sees what they are about to sign. The result is read back from chain as its own kind of decision, never as a settings change. A charge blocked by the total cap offers nothing and says an override cannot raise the cap. Share is the full-width primary action on a paid or refused decision, never an overflow menu. The header says Export.

The grade rules, from `app/lib/grade.ts`:

| Grade | Rule |
|---|---|
| Stayed inside its rule | Fewer than 1 request in 20 outside its rule. |
| Tested its limit now and then | 1 to 4 requests in 20 outside its rule. |
| Often asked outside its rule | More than 4 requests in 20 outside its rule. |
| Too new to grade | Fewer than 10 requests, or fewer than 3 days running. The facts still show; the label waits. |

A request is a payment the rule paid inside the rule, or refused. A later payment that settles an allowance is not a payment inside the rule. An allowance whose refusal has fallen off the ring still counts as outside. The agent's own signed declines are not requests. Money moved outside the rule is always 0, and it is never credit. Fewer than 10 requests, or fewer than 3 days running, or a start that is not yet old enough to date, is Too new to grade. The facts still show. Two or more allowances, once the agent can be graded, move the shown grade one step lower: stayed becomes tested, tested becomes pushed, and pushed does not move further.

Plaques on an agent's record, from that rule's history: First payment inside the rule, First refusal saved, Ten refusals, none allowed, 30 days inside the rule, and Rule finished, rest returned. Ten refusals requires 10 refusals and no allowance. The last plaque is earned when the rule runs to its end inside its cap. A revoke before the end does not earn it.

Week in review is seven local days of the rule: paid and refused counts, refusals grouped by reason, save as a file, or share as a card.

The track record card is an image. The QR is the rule address. On devnet it says Devnet, test tokens. Share opens the phone share sheet.

Renewal opens from the banner on Overview and on the rule page while an active rule has seven days or less left, and more than none. It shows what happened, the highest amount asked, and the highest amount paid. The next rule is filled from this one: payee, most per payment, total set aside, how long it runs, and purpose. Change edits each of those before signing. The agent stays the one on this rule. Let this one end writes nothing and costs nothing. Set up the next rule opens the existing new-rule flow, and the owner signs it in Seed Vault.

The quiet note is off until you turn it on. You pick a time and one send: Every evening, Only on days something moved, or Never. It is one local notification whose text comes from that day's decisions. Refusals still arrive when they happen, whatever you pick here. The screen says the phone checks the blockchain about every 15 minutes in the background, and that battery saving can delay a check.

## Widget

Two Android home screen widgets. They are native. They show up after a build that runs Expo prebuild: a dev client or an EAS build. Expo Go cannot install them.

- **What this agent can still spend.** The rule selected in the app. What that agent can still spend, the block bar, the last decision in plain words, days left and when the rule ends, the paid and refused counts, and the date and time the numbers were read. Tap opens that rule.
- **One rule.** One card per rule. When it is placed, the app asks which rule to show. It shows what that rule can still spend, the last decision, and when the numbers were read. Tap opens that rule.

Every amount, count, and date comes from the same chain reads as the app. If there is no signed-in owner, no rule, or the read fails, the card says so and does not invent a balance.

The widgets redraw when the app process starts in the foreground, when the app returns to the foreground, and after the decision background task (minimum interval 15 minutes). Android also requests an update on its own cadence. The minimum these widgets set is 30 minutes, so the background task is the faster path.

## Hold

Hold on the phone: big money waits, and a second key can say no. Overview and Rules each open it. The first screen states the promise: if someone gets your key, a big withdrawal or one to a new address has to wait, and you or your guardian can stop it before it goes through.

The screens set the amount moved in, the everyday limit, a wait of 1, 2, or 3 days, and the four triggers (more than the daily limit in one day, any amount to an address this vault has never paid, more than a quarter of the vault within 24 hours, and any change that loosens these rules). Then the guardian key and the safe address, the live vault, a held withdrawal with a countdown from the chain clock (Stop is the main action, Freeze is beside it), the alert plan, the frozen state (Recover to the safe address, Unfreeze with both keys), skip a wait with both keys, and send from the vault.

Every owner or guardian signature goes through the Mobile Wallet Adapter and Press and hold to approve. A cancelled or failed signature arms the button again.

The 15 minute local check also raises hold alerts: at creation, at 1 hour, at 12 hours, every 12 hours after that, at 6 hours and 1 hour before the end, and when the wait ends. Hold alerts cannot be muted in the app. The watcher raises the same alerts when `VETO_HOLD_VAULTS` is set. See [watcher/README.md](../watcher/README.md).

The phone builds Hold instructions itself. It does not import `@veto-hq/agent-sdk`. That package is for agents, and version 0.1.0 is on npm. The program instructions are in the root [README](../README.md).

Hold is merged and tested, and live on devnet. The app screens exist, and a device check with a real vault follows.

Export offers three scopes (this decision, a date range, everything under
this rule) and two shapes (CSV with the documented columns, JSON as in
`docs/DECISION_RECORD.md`). The file states the honest limit: complete
over payments, never over attempts.

A rate-limited RPC read is its own state and says so. It is not a stalled
fetch and it is not an absence of a rule.

Chain reads and writes live in `lib/`. RPC url and program id come from config
(`EXPO_PUBLIC_VETO_*` via `app.config.js` extra). The app does not hardcode an
RPC url.

## Cluster config

Copy `app/.env.example` to `app/.env` (gitignored) and fill the values from
`docs/DEVNET.md` / `keys/devnet-addresses.env`. Restart Metro after changing
them.

```bash
cd app
cp .env.example .env
```

Required:

- `EXPO_PUBLIC_VETO_RPC` (the cluster RPC; blank in `.env.example`, set for release builds as a sensitive EAS environment variable in the production environment, so a dedicated devnet RPC key stays out of the repository; the program id and the mint stay in the `eas.json` production profile)
- `EXPO_PUBLIC_VETO_PROGRAM_ID`
- `EXPO_PUBLIC_VETO_MINT` (needed to open a mandate). On devnet the default is Circle USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals. Nobody can mint it. The owner gets it from https://faucet.circle.com. VTEST stays in the app for rules that already use it.

Optional:

- `EXPO_PUBLIC_VETO_EXPLORER_CLUSTER` (default `devnet`)
- `EXPO_PUBLIC_VETO_MINT_DECIMALS` (fallback if the mint account cannot be read)

EAS secrets:

- `VETO_MAINNET_PREVIEW_RPC` (sensitive EAS environment variable in the preview environment). The `mainnet-preview` build profile points at mainnet-beta with the SKR mint and refuses to build without this secret, and the app refuses the `EXPO_PUBLIC_VETO_RPC` fallback at runtime on mainnet-beta, so the preview build never talks to a devnet RPC.

## Connect an agent

The rule screen shows Connect your agent. Copy all and the QR appear only
while the rule is active (status active, and not past expiry) and the mint
decimals and payee token account have been read. Both controls carry the same
JSON. A rule that is not active shows "This rule is not active, so there is
no config to hand an agent." and shows neither control. `loadAgentConfig`
reads that block.
`VetoAgent.fromConfig` checks it against the chain. The mandate must be owned
by the program bundled with the SDK, and a block whose `programId` differs is
refused. A different program id is accepted only as an argument passed in
code. The mandate agent must be the key in the key file. The mint, source,
and payee token account must agree, and `mintDecimals` must match the mint
account. The cluster name must match the endpoint's genesis hash. A
connection passed to `fromConfig` is used instead of `rpcUrl`. The example
then charges:

```bash
npx tsx examples/pay-once.ts <agent-key.json> <config.json> <amount>
```

This is the shape:

```json
{
  "mandate": "<mandate address>",
  "programId": "<program id>",
  "mint": "<mint address>",
  "mintDecimals": 6,
  "sourceTokenAccount": "<rule token account>",
  "payeeTokenAccount": "<payee token account>",
  "agent": "<agent address>",
  "cluster": "devnet",
  "rpcUrl": "https://api.devnet.solana.com"
}
```

`mintDecimals` is checked against the mint account. `payeeTokenAccount` is the
token account a charge pays: the payee's associated token account for this
mint when that account exists, otherwise the payee's only token account for
the mint. `cluster` is checked against the endpoint's genesis hash (`devnet`,
`testnet`, or `mainnet-beta`). `rpcUrl` is the public endpoint for the cluster.
The app's configured endpoint and credentials are never included in the setup.
The agent can pass its own connection for production.

## One-time: Expo account

These commands are interactive. Do not run them from an unattended agent.
Do not commit a keystore, a `.jks`, or `credentials.json`.

```bash
cd app
npm install
npx eas-cli login
```

A project is already linked in `app.json` (`extra.eas.projectId`). The first
cloud build will ask EAS to generate a keystore. Let EAS store the keystore.

## Development client APK

Builds a custom dev client APK (not Expo Go, not an AAB):

```bash
cd app
npx eas-cli build --profile development --platform android
```

When the build finishes, EAS prints a download URL.

1. Put the APK on the Seeker. Either open the URL on the device or copy it
   with adb:

   ```bash
   adb install path/to/the-downloaded.apk
   ```

2. Start Metro from this directory:

   ```bash
   npx expo start --dev-client
   ```

3. Open the installed Veto app on the Seeker and connect it to the bundler.

Test on the Seekers. Seed Vault is not available on an emulator.

## Production APK

A person builds the signed Android APK with the production EAS environment,
then downloads it. From the repository root, run these two commands in order
(replace the example APK path with the downloaded file):

```bash
(cd app && npx eas-cli build --profile production --platform android)
./scripts/release-apk.sh /path/to/release.apk
```

Put Android SDK `aapt2` or `apkanalyzer`, plus `apksigner`, on PATH. The
inspection also needs Node.js, `unzip` and `sha256sum` or `shasum`. It writes
`release-notes.md` beside the APK with the targetSdk, the full permission
list, and the URL schemes, and records the checkout `HEAD` commit at inspection
time (not proof of the build's source commit). It refuses a package that is
not `com.veto.app`, a targetSdk below 36, any permission blocked in
`app.json` (read at inspection time), a missing `veto` scheme or any `exp+`
scheme, an embedded config with a non-devnet cluster or wrong program id or
devnet USDC mint, or a failed signature. For older APKs without embedded
config, it checks those addresses in the bundle and refuses a bundle that
names `mainnet-beta` or never names devnet. A failed check is
not a release. Run the printed install command from the APK's directory.

For older APKs without embedded config, the RPC presence check recognizes
common Solana RPC providers. For a custom host in those APKs, supply
`EXPO_PUBLIC_VETO_RPC` through the environment for an exact match.
It never prints that value. A yes is not a connectivity check. An EAS sensitive
variable inlined during the build remains extractable from the APK.

Attach the inspected APK and its notes to the GitHub release, then walk the
[device checklist](../docs/internal/DEVICE_CHECK.md) on a wiped Seeker using
that release link. Keep the completed checklist as release evidence. A
production build runs without Metro.

## Public tester APK

The `tester` profile builds the public devnet APK in the EAS `preview`
environment. The owner sets `VETO_TESTER_RPC` there to a separate, capped
devnet RPC key. It must not be the production key. EAS builds fail if it is
missing or blank. Tester config never reads `EXPO_PUBLIC_VETO_RPC`, and the
app refuses that fallback if its embedded tester RPC is missing.

```bash
cd app
npx eas-cli build -p android --profile tester
```

This standalone APK runs without Metro and uses the production package
`com.veto.app`, program id, devnet cluster and devnet USDC mint. It replaces
the production app when signed with the same key. It has the same permission
policy and dev-client scheme stripping as production.

After downloading, run `./scripts/release-apk.sh /path/to/tester.apk` from
the repository root. Inspection reads the tester marker and selected RPC
from the APK's embedded Expo config and prints the profile and RPC host only,
with the key masked. Production APKs have no profile marker, so their profile
is reported as inferred from the devnet release identity. Older APKs without
embedded config use the existing provider or exact-match heuristic.

The capped key remains extractable from a public APK. Keep its quota separate
from the owner's production usage. Never put it in the repository or release
notes. Production and mainnet-preview keep their existing RPC sources.

## Mainnet preview APK

The `mainnet-preview` EAS profile builds an internal APK that installs beside
the devnet app: its own name (Veto Mainnet preview), package
(`com.veto.app.mainnetpreview`), and URL scheme (`veto-mainnet-preview`). It
targets mainnet-beta with the SKR mint and the same program id as production.
Set the `VETO_MAINNET_PREVIEW_RPC` EAS secret in the preview environment first;
the build refuses to proceed without it.

```bash
cd app
npx eas-cli build --profile mainnet-preview --platform android
```

## Entry file

`package.json` `main` is `index.js`. That file installs the Buffer and
crypto polyfills, then imports `expo-router/entry`. That order is required
for `@solana/web3.js`. See the comment at the top of `index.js`.
