# Build plan

This file is the internal build plan. Product claims live in the [README](../README.md), [PITCH.md](PITCH.md), and [PROBLEM.md](PROBLEM.md).

Solana Mobile "Clock In" hackathon ([Solana Mobile announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon)).

The project is named veto. The recorded refusal is the product. Capped on-chain agent budgets
already exist.

## The claim

Limits on chain already exist. An overspend that is simply impossible protects the money and
leaves only a failed transaction's logs, nothing in program state. Veto makes the refusal legible. A
recorded no, a one-line why, and the override that would have cleared it. On a phone, with the
key in Seed Vault.

AP2 specified the record of a yes. This is the missing half.

The mandate is the prior claim, the ledger is the evidence, and neither is worth anything alone.
Who has the problem, and how a burner wallet compares, is in [PROBLEM.md](PROBLEM.md).

## Prior art

Capped agent spending is not new. The table names the limits that already exist.

| Who | What they do | Relation to this entry |
|---|---|---|
| Squads v4 spending limits | Pre-approved allowances, roles, per-member caps. Audited by Neodyme, OtterSec, Trail of Bits, two formal verifications underway (per the Squads blog, read 2026-09-28) | Treasury operations for humans. An overspend stops as a failed transaction, with no refusal written to program state |
| SPL `approve` / delegate | Caps what a delegate can pull | Cap only. No purpose, no expiry, no reason, no record |
| LazorKit | Passkey smart wallet, session keys with slot-height expiry, on-chain RBAC and spending limits | Wallet infrastructure for app developers |
| Oculus | On-chain policy check per transaction, a USDC reserve reimburses a breach after the fact | Reimburses a breach after the fact. Veto declines before money moves |
| x402 / AP2 | HTTP 402 settlement; signed Checkout and Payment mandates as verifiable digital credentials (per the AP2 specification, read 2026-09-28) | The record of a yes, held off chain as evidence for the merchant |
| Seed Vault | Hardware-held keys, human approves every signature | The default on this platform. Unattended agent spend needs a bound beside that key |

SolAgent Pay was compared here earlier. Its repository, `github.com/altaranexus-ship-it/solagent-pay`, returned HTTP 404 when checked on 2026-09-28, and no archived copy was found, so its row and quote were removed.

By the time this plan was written, capped on-chain agent budgets were already commodity, including
tutorials from infrastructure vendors. The entry is the mobile build, the recorded refusal, and
the demo.

## Solana Mobile

Seed Vault is built so a human approves every signature. That is the right default, and it is
exactly why unattended agent spend has nowhere to live on this platform. A mandate is the Seed
Vault-shaped answer: the key never leaves the vault, and the agent gets bounded authority beside
it rather than a copy of the key.

## Architecture

Three pieces. No server holds money and no server can veto anything.

```
Phone (owner + agent)            Solana devnet              Watcher (unattended)
---------------------            -------------              --------------------
Seed Vault key --MWA-->          open_mandate
                                 grant_override
                                 revoke_mandate
                                 close_mandate
agent hot key  --------->        charge  ---> transfer OR refusal entry  <--- four decisions a Stockholm day
                                 ledger PDA                                    against the live feed
```

### The program

The program enforces the limits on chain and records the refusal. New policy fields are out of
scope.

`charge` returns `Ok` when it declines. An error would roll back every account write, so the
refusal would leave nothing in program state. Declining transfers nothing, writes a ledger entry with a reason
code, logs a readable line, and succeeds. The refusal reason codes are listed in the
[README](../README.md).

Four limits enforced on chain: total cap, per-payment maximum, expiry, one allowed merchant.
A spending rule does not escrow into a vault. `open_mandate` approves the mandate as delegate of
the source it is given. A rule opened in the app moves the cap into a token account derived
from the owner (`veto-rule-<mandate id>`). Close rule returns that balance and the rent.
Revoking one of those rules does not clear another rule's account. A nonce advances only on
payment, so a settled charge cannot be replayed, and a refused one can still be retried after
an override.

The refusal carries the override that would have cleared it. The live devnet line is in the
README: an amount, the per-payment maximum, the remaining cap, and `override_to_clear`.

### Hold

The mandate path above does not escrow. Hold is a separate vault in the same program, for a
balance the owner deposits and cannot move with a raw transfer. The vault PDA (`["hold", owner,
vault_id]`) is the authority of its token account.

An everyday withdrawal is instant only when the vault is not frozen, the destination token
account has already been paid by this vault, and the running 24 hour total stays inside both
the daily limit and `big_share_bps` of the current balance. The usual share is 2500, a quarter
of the vault. Anything else is held, not refused, until `execute` after `delay_secs` on the
chain clock. The delay is 1, 2, or 3 days. The owner or the guardian can `stop` one hold or
`freeze` the vault with no wait. While it is frozen, nothing leaves except `recover`, which
sends the whole balance to the safe address. `unfreeze` and `skip` need the owner and the
guardian together. With no guardian set, `unfreeze` waits out the current delay. Tightening a
limit applies immediately. Loosening one, including the safe address or the guardian, waits out
the current delay, and either key can cancel it. Eight holds can sit at once. A ninth is
recorded as refused and is not paid. Sixteen destination accounts are remembered. Each action
writes a hold ledger entry and an event. Mandate accounts are unchanged.

`@veto-hq/agent-sdk` exports `HoldVault` for those instructions. Install it with `npm install @veto-hq/agent-sdk`. Version 0.1.1 was published to npm on 2026-09-28 (0.1.0 on 2026-09-27). The package is published from this checkout by the maintainer. The watcher reads `VETO_HOLD_VAULTS` and writes hold alerts. The app has the Hold screens and raises the same alerts on the phone. Overview and Rules each open Hold.

Hold is merged and tested, and live on devnet. The app screens exist. A completed device check of Hold with a real vault is not recorded in this repository yet. [DEVNET.md](DEVNET.md) records the 2026-09-20 addresses and the 2026-09-25 program upgrade.

### The feed

`https://www.elprisetjustnu.se/api/v1/prices/YYYY/MM-DD_SE3.json`, verified 2026-09-20: HTTP 200,
no authentication, 15-minute resolution, SEK and EUR per kWh.

The demo pays a bill repriced by that index, on devnet, in our token, to a terminal this
repository runs. It buys no electricity. The bill is paid when the repriced amount is inside
the rule.

The price is a public spot. A DEX price is a trade.

The price is real, public, and independently verifiable against the same URL. The counterparty
is a terminal this repository runs, because no charge point operator accepts this mint
(`2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU`). Calling that terminal a real merchant would
be false. This repository does not describe it as one.

### The watcher

The cloud project for that job is [GCP_SETUP.md](GCP_SETUP.md). The deploy script has been run.
The Cloud Run jobs, scheduler, bucket, secret, and registry are listed there.
`scripts/gcp-verify.sh` checks that document against the live project. Its absence checks fail
because those resources exist.

### History

The on-chain `Ledger` is a 32-entry ring. Four decisions a day is 28 entries in a week, inside
the ring. More than a week wraps it (the 33rd entry). The ring is the authoritative recent
window. The full trail is reconstructed by indexing `Paid` and `Refused` events from transaction
logs. The agent can also fill the window with refusals and push a paid row out of it.

### The app

One APK, in `app/`. The look is Backglass. A fresh install walks five stages: Learn, Connect wallet, Add your agent, Approve the rule, and Live. Connect is Mobile Wallet Adapter against Seed Vault, and `authorize` identifies the app as `https://veto-hq.github.io`. The four tabs are Overview, Rules, Agents, and Decisions. Overview is the home screen. With no rule, Overview shows Open your first rule.

Agents grades each agent with the four rules in `app/lib/grade.ts` (fewer than 1 request in 20 outside the rule, 1 to 4 in 20, more than 4 in 20, or too new: fewer than 10 requests or fewer than 3 days). Plaques, a seven-day week in review, a track record card, renewal in the last seven days, and a quiet note that is off until turned on are in the app. Two Android home screen widgets show what an agent can still spend. They need a prebuild. Expo Go cannot install them.

On an active rule, Connect your agent (Copy all and a QR). Revoke in one tap. Close rule returns the remaining budget on a per-rule token account. A local notification on every decision, raised by an on-device background read (`app/lib/decisionNotifyTask.ts`), because the agent acts while the owner is not looking. Hold screens are in the app. Hold is live on devnet. A completed device check of Hold with a real vault is not recorded in this repository yet.

The agent key is generated in the app and held in `expo-secure-store`. It signs `charge` and
nothing else. It owns no funds and cannot widen any limit.

### The form

No model is involved. The four numbers are typed or taken from a template in `app/lib/templates.ts`.
The why is a fixed sentence per reason code in `app/lib/reasons.ts`. The charge path is in the
program. A refusal is one of the numeric reason codes. Declining on the meaning of the purpose
is not in the program. Issue 24 is still open. The purpose is stored as written, at most 64
characters.

## Milestones

Dates below are the hackathon calendar. The cut lines and the old self-score live in
[internal/BUILD_NOTES.md](internal/BUILD_NOTES.md).

Historical schedule.

| By | Must be true |
|---|---|
| **Sep 23** | Program deployed to devnet. Watcher running against the live feed. First real ledger entries on chain. |
| **Sep 27** | Watcher logging on the six-hour cadence. Indexer reading history from transaction logs. |
| **Oct 1** | Mandate opened from the phone with one signature. Today view and ledger reading real history. Revoke works. |
| **Oct 4** | Override path. Local notifications from an on-device background read. Export and off-phone verify. Release APK. |
| **Oct 6** | Three-minute video shot on device. Deck done. |
| **Oct 8** | Submitted. |

On 2026-09-24 the spending-rule program is on devnet. Mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g` has three paid charges and six refusals from 2026-09-20 20:57:50 UTC through 2026-09-21 22:00:11 UTC. That span is not a week, and it cannot be backfilled. Mobile Wallet Adapter `authorize` and the Seed Vault signatures have not been checked on a Seeker. Hold is live on devnet as of the 2026-09-25 upgrade recorded in [DEVNET.md](DEVNET.md). The app screens exist. A completed device check of Hold with a real vault is not recorded in this repository yet.

## Risks

Snapshot as of 2026-09-24; see [docs/VIDEO.md](VIDEO.md) for the 2026-09-29 device run.

1. **Done: Mobile Wallet Adapter and Seed Vault on a Seeker.** On 2026-09-24 this was open: the unit tests do not cover `authorize` or the Seed Vault signatures. The 2026-09-29 run in [VIDEO.md](VIDEO.md) records the rule open and the allow-once signed by the Seeker owner `GtA2Vxhomfm2WGaBcvz5oCBrqkAecKHMAL3UTn4HVFzq` ([DEVNET.md](DEVNET.md)).
2. **The quoted rule's history is the span above.** A later charge on that mandate does not turn the existing rows into a week.
3. **A refusal has to confirm.** The balance is unchanged and the ledger entry exists in the same confirmed transaction. That is what the refusal test asserts.
4. **A charge the agent never submits has no record.** Nothing on chain can provide one. The record is every decision the program reaches in a charge transaction that succeeds; a charge transaction that fails leaves no decision record. [PROBLEM.md](PROBLEM.md) states that limit.

## House rules

Small conventional commits from day one, because commit history is scored. No invented prices or
fabricated counterparties on any surface. Amounts as integer base units, never floats. Secrets
never in git. No em dash anywhere.
