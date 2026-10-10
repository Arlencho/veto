# Try Veto on your Seeker or Android phone

This guide is for Seeker owners and other Android testers trying the devnet APK.

Veto lets you set payment and trade rules for an agent and see which requests were paid or refused. Its Hold vault makes withdrawals to new addresses wait, so you can stop them. Everything here is devnet test money with no value.

The [release notes](RELEASE_NOTES.md) list features and known limits. The Try page is <https://veto-hq.github.io/try/>.

## Setup

1. Download and install the APK from the [latest release](https://github.com/Arlencho/veto/releases/latest).
   The release page lists the APK's SHA-256 so you can check the download.
2. Use Seed Vault on Seeker, or a Solana wallet supporting Mobile Wallet Adapter
   on another Android phone. Set the wallet to devnet and copy your own wallet address.
3. Get free devnet SOL at [Solana Faucet](https://faucet.solana.com) and free devnet USDC at
   [Circle Faucet](https://faucet.circle.com). Choose Solana devnet for USDC.
   Use your own wallet address at both faucets.
4. Open Veto and follow the first-run steps. When asked to add an agent, use the test-agent choice below.

Faucets and confirmations can take time. In the steps below, approve in your
connected wallet. Seed Vault is the Seeker example.

To check your balance on the explorer, open
`https://explorer.solana.com/address/<your address>?cluster=devnet`. Testnet is
a different network, so a `cluster=testnet` link shows an empty wallet. Phantom
may warn that the app's identity could not be verified. That is expected for the
devnet test build, so tap **Connect**.

## Three things to try

### 1. Write a rule and look for a payment and a refusal

Choose **Create a test agent on this phone**, name it, then **Review the rule**.
Set **Payee**, **Purpose**, **Most per payment** and **Most in total, ever** to a
small test budget you can fund. Use a payee address you control, different from the
agent address. Use **Press and hold to approve rule** and approve in Seed Vault.

On the live screen or the payment rule detail, tap **Send two test requests**.
Review the exact amounts and payee, then confirm. If the test agent has less than
0.005 SOL for fees, approve one transfer of 0.01 devnet SOL in your wallet.
The phone then signs both requests with its stored agent key, and no other owner
signature is needed. Read the inline paid or refused outcomes and explorer links,
then open **Decisions**, which refreshes after the run. If the remaining cap is
empty, the paid request is skipped with a message.

The button appears only for an active, unexpired payment rule that uses this phone's
stored test agent on devnet. Other agents and trade rules need a separately
running agent. If a request fails, check the inline outcome and the explorer before
retrying, because submitted transactions may still land.

### 2. Hold a withdrawal, then stop it

From **Overview**, open **Hold**, then **Set up a vault**. Enter a small amount,
such as 1 devnet USDC. Choose **Next: set the rules**, set a daily limit and wait,
then **Next: choose a guardian key**.

Choose **A second key in Seed Vault on this phone** if available, or **Your second Seeker**
and enter its address. The guardian must be a different key from the owner.
Enter a **Safe address** explicitly. It must be a wallet you own that the guardian
does not control. It cannot be the guardian address or the owner wallet you sign with,
and the program refuses both.
If you cannot access a separate guardian key and a suitable safe wallet, report
this task as blocked. A second key on the same phone is useful for testing,
but it does not give the separation of a guardian on another device.
Use **Press and hold to sign with your key on this phone**, approve in Seed Vault,
then tap **Done**.

Open your vault and enter an **Amount** (for example 0.1 USDC) and a **Destination address**
the vault has never paid. Use another wallet address you control.
Check that the button says **Press and hold to sign. This will be held.**, then hold it
and sign. On the held withdrawal, use **Press and hold to stop this withdrawal** and
sign. Check that the withdrawal is no longer waiting and the money remains in the vault.

### 3. Look at your agent's grade

Open **Agents** and find your agent. A new agent shows **Too new to grade** until it
has at least 10 requests and three days of history. Open **See how grades work**.
Does the explanation make sense? A grade describes behaviour, not safety.

## More to explore

You can connect an agent you already run. Paste or scan its public address, then
review and approve its rule. The agent must run separately to submit requests.

You can write a trade rule by choosing a listed pool, limits and a price floor. The
hacked-agent demo described in the [release notes](RELEASE_NOTES.md) uses a separate
script, and there is no in-app button to run it.

Once you have a paid or refused payment decision, open it and use **Share** to reach
**Export**, then choose JSON or CSV. Records cannot show requests an agent never submitted.

## Get ongoing charges from our demo agent

Our demo agent runs all the time and sends a request to every open payment rule
that names it. Approve one rule for it to get paid and refused notifications for days.

1. Open **Rules**, tap **Write a rule**, keep **Payment rule** selected and paste
   the agent address `6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w` in the
   **Agent** field (the Agent row in [DEVNET.md](DEVNET.md)). This is the demo
   agent, not your own wallet. The app refuses a rule where the agent is the
   wallet that approves it.
2. Set **Payee** to the demo payee `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG`.
   A rule with another payee is skipped.
3. Fund it with devnet USDC and set **Most per payment** to 1 and
   **Most in total, ever** to 10. Approve the rule. The 10 USDC moves into the
   rule's own account, which you control, so hold at least that much devnet
   USDC first.
4. Expect a request every six hours, at 00:00, 06:00, 12:00 and 18:00 Stockholm
   time. The amount follows the Swedish electricity spot price for a 6 kWh top-up.

The request follows the spot price, not your per-payment limit. Requests above
1 USDC are refused, and requests at or below it can pay if the other rule checks
pass. Tester rules do not use demo calibration, so you may see only payments or
only refusals. A refusal moves no payment tokens. To stop the requests, use
**Stop the rule** on the rule's screen.

When a request is refused as over your per-payment limit, open that decision
and press and hold **allow this one payment**. The demo agent normally checks
for the retry on its next scheduled run (00:00, 06:00, 12:00 or 18:00 Stockholm
time). It retries the same nonce and amount only while the rule and allowance
remain usable, the refusal and allowance are still in the ledger ring, and the
amount fits the allowance and remaining budget. Other program checks can still
refuse it, and service or RPC problems can delay or prevent it. A successful
retry consumes the allowance without changing your normal per-payment limit.
The agent then processes the scheduled request if it remains eligible.

## Tell us

[Send tester feedback](https://github.com/Arlencho/veto/issues/new?template=tester-feedback.yml) with the phone and wallet you used, how far you got, and where you got stuck. The optional wallet address lets us match your feedback with what happened on devnet. Issues are public, so never include a recovery phrase or private key.

## Building the public tester APK

The owner sets `VETO_TESTER_RPC` in the EAS `preview` environment to a
separate, capped devnet RPC key, then builds.

```bash
cd app
npx eas-cli build -p android --profile tester
```

The build refuses a missing key and never uses `EXPO_PUBLIC_VETO_RPC`.
The key can be extracted from the public APK, so its quota is separate from
production. Do not put the key in feedback or release notes.

The tester APK uses `com.veto.app` and the same program, devnet cluster and
devnet USDC mint as production. It runs without Metro and replaces the
production app when signed with the same key. Before publishing, run
`./scripts/release-apk.sh /path/to/tester.apk` from the repository root.
The inspection reports the profile and the selected RPC host with the key masked,
and enforces the release permission, scheme, signature and devnet checks.
