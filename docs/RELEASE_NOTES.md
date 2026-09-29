# Veto APK v1.0.0-devnet.4: devnet

Veto is an Android app for setting rules on what an agent can spend or trade
on Solana. You approve the rule with your wallet. The program checks requests
against it and records payments, trades and refusals. Hold is a separate vault
that makes withdrawals wait when they cross its rules, giving you or a guardian
time to stop them.

**This release is devnet only. All money used here is test money with no value.**

## Changed since v1.0.0-devnet.3

- **Allowed-once payments say so.** A payment or trade above the rule's
  per-payment or per-trade limit can only go through after you allow it once.
  Decisions, the decision screen, notifications, trade rows and the Today card
  now say the payment was allowed once by you, above your limit, instead of
  describing it as within the limit. Amounts are rounded so the shown payment
  never equals the shown limit.
- **Plain words.** Screens say "request" where they said "nonce". Exported
  records keep the program's exact reason text, so they still verify.

## What the app does

- **Payment rule.** Choose an agent, payee, purpose, maximum per payment,
  total budget and expiry. Review the terms before signing. Requests that
  break the enforced limits are refused without moving payment tokens.
- **Trade rule and hacked-agent demo.** Set a pool, output account, maximum
  per trade, rolling daily allowance, total budget and price floor. The demo
  uses an agent key to try a different destination, an unapproved pool,
  too much per trade, a quote below the floor and too much in a day.
  These attempts are refused and recorded; trades within the rule can go
  through. See the recorded devnet run in [Devnet deployment](DEVNET.md).
- **Hold with a guardian.** Fund a vault, set its limits and waiting period,
  and choose a separate guardian key and an explicit safe address that is
  neither the owner nor the guardian. Withdrawals to new addresses wait. The guardian can stop a waiting withdrawal, freeze
  the vault or recover its balance to the chosen safe address.
- **Owner-direct connect.** Paste or scan an existing agent's public address
  into the app, review a rule and approve it with your wallet. An agent can
  also supply a rule-request link or QR for you to review.
- **Decisions and export.** Read paid and refused decisions and their reasons.
  Payment records can be shared as JSON or CSV for one decision, a date range
  or a rule. See [Decision records](DECISION_RECORD.md) for the file format
  and verification instructions.

## What testers need

- A Seeker or another Android phone with a Solana wallet that supports
  Mobile Wallet Adapter and devnet.
- Free devnet SOL for transaction fees and free devnet USDC for payment
  rules and Hold. The [tester guide](TESTERS.md) links to the faucets and
  explains setup.
- For Hold, access to a separate guardian key and a safe wallet you own
  that the guardian does not control. A guardian on the same phone is
  convenient for testing but is not a separate device for protection.

Start with the [tester guide](TESTERS.md) or the Try page at
<https://veto-hq.github.io/try/>. The APK is attached to the
[latest release](https://github.com/Arlencho/veto/releases/latest).

## Known limits

- Devnet only, with test money. Do not send real funds.
- **Send two test requests** on the first-run live screen or payment rule detail
  sends a small payment and an above-limit request for an active, unexpired
  devnet payment rule belonging to this phone's stored test agent. It asks for
  one wallet transfer of 0.01 devnet SOL only if the agent has less than 0.005 SOL
  for fees. An empty remaining cap skips the payment. Outcomes and explorer
  links appear inline, then Decisions refreshes. Other agents and trade requests
  still need a separately running agent; the hacked-agent trade demo is scripted.
- A Hold vault created before the 2026-09-26 upgrade can have a safe address
  equal to its guardian or its owner. The key that equals the safe address can
  no longer recover to itself, and the owner cannot close a vault whose safe
  address is the owner; the other key can still recover. Change the safe
  address first; the change waits the vault's delay.
- The trade demo uses a test pool. Its rate is not a market-price claim.
- Records describe requests that reach the program's decision logic, not
  every possible attempt. An unsubmitted request or an account-validation
  error can leave no decision record. Export does not prove that no other
  attempts occurred.
- Network reads, faucets and wallet confirmations can fail or take time.
  Background alerts depend on Android scheduling and are not immediate.

## Report a problem

Use the [tester issue form](https://github.com/Arlencho/veto/issues/new?template=tester-feedback.yml).
It asks which phone and wallet you used, how far you got, where you got stuck
and whether you would use Veto with a real agent. Add the APK version and any
visible error text when available. Issues are public. Never include a recovery
phrase or private key.
