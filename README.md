# Veto

Seeker owner? [Try Veto on devnet before October 8](docs/TESTERS.md).

**Everyone stops the overspend. Veto also records why it stopped.**

Veto enforces a spending rule on chain: when a charge breaks it, the transfer is never executed
and no tokens move. That much is table stakes, and every serious design does it.

The difference is what the stop leaves behind. Elsewhere a blocked overspend is usually a failed
transaction: Solana keeps its logs and error code, but no program state changes. Here a refusal is a
successful transaction that moves no payment tokens and writes a structured reason to program
state, with the override that would have cleared it. On a phone, with the key in Seed Vault.

Every decision is a confirmed transaction that anyone can look up by its signature. The copy in
program state is the rule's on-chain ledger. It keeps the latest 32 decisions, and it is deleted
when the owner closes the rule.

AP2 standardised the record of a yes. This is the missing half.

> Status: in development for the Solana Mobile "Clock In" hackathon. Submissions close
> October 8, 2026 ([Solana Mobile announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon)).
> See [docs/PLAN.md](docs/PLAN.md) for the build plan,
> [docs/PITCH.md](docs/PITCH.md) for the positioning, and
> [docs/internal/DECISIONS.md](docs/internal/DECISIONS.md) for why each choice was made and what would reverse it.

## Prior art

Capped agent spending on Solana is not new, and this project does not claim it.

| Prior art | What it does | What Veto adds |
|---|---|---|
| [Squads v4 spending limits](https://squads.xyz/blog/spending-limits) | Pre-approved allowances, roles, per-member caps. Audited by Neodyme, OtterSec and Trail of Bits, two formal verifications underway | Treasury operations for humans. An overspend stops as a failed transaction, with no refusal written to program state |
| SPL `approve` / delegate | Caps what a delegate may pull | Cap only. No purpose, no expiry, no reason, no record |
| [LazorKit](https://github.com/lazor-kit/lazor-kit) | Passkey smart wallet, session keys with slot-height expiry, on-chain RBAC and spending limits | Wallet infrastructure for app developers |
| [Oculus](https://github.com/useoculusagent/useoculusagent) | On-chain policy check per transaction, a USDC reserve reimburses a breach after the fact | Reimburses a breach after the fact. Veto declines before money moves, and the decline is a record |
| [x402](https://metamask.io/news/what-is-x402) / [AP2](https://www.cobo.com/post/ap2-protocol-complete-guide-to-agent-payments-for-web3-developers-2026) | HTTP 402 settlement; signed Intent, Cart and Payment mandates as verifiable credentials | The record of a yes, held off chain as the merchant's evidence |

SolAgent Pay was compared here earlier. Its repository, `github.com/altaranexus-ship-it/solagent-pay`, returned HTTP 404 when checked on 2026-09-28, and no archived copy was found, so its row and quote were removed.

Capped on-chain agent budgets are documented well enough that infrastructure vendors publish
tutorials on them. The claim here is narrower: **the refusal is an artifact.**

## The refusal is the product

When a rule fails, the token transfer instruction is never executed, so zero tokens move. The SPL
delegation on the source token account is a second ceiling the program itself cannot exceed.

When `charge` declines it does not return an error. An error would roll back every account write,
and the refusal would leave nothing in program state, only the failed transaction's logs. The instruction transfers nothing, writes a refusal to an
on-chain ledger with a reason code and the override that would have cleared it, logs a readable
line, and returns `Ok`.

A refusal has a signature you can open in an explorer. This refusal is for the 18:00 Stockholm
window. The nonce `1789920000` is 2026-09-20 16:00:00 UTC, which is 18:00 in Stockholm. The
transaction confirmed at 2026-09-20 20:58:12 UTC:

```
VETO REFUSED reason=5 (over per-payment maximum) amount=6232500 per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

The **transaction** succeeded: it succeeded at deciding no. The **payment** did not happen: the
balance is unchanged. A refusal is a transaction that worked and a payment that did not.
Neither party can edit that confirmed transaction or its logs. The ledger entry in program state
is not permanent: the ledger is a 32-entry ring, so every later decision the agent submits, paid or
refused, can overwrite the oldest entry, and the owner can delete the ledger with
`close_mandate` once the rule is no longer active.

The last field is the override that would have cleared the charge.

## See it on devnet

Live on Solana devnet. Open this transaction:

**[A refusal, recorded](https://explorer.solana.com/tx/3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib?cluster=devnet)**

Three things to look at, in this order: the transaction **succeeded**, the token balances are
**unchanged**, and the program log says why.

```
Program log: VETO REFUSED reason=5 (over per-payment maximum)
             amount=6232500 per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

The bill was 6.2325 tokens because 50 kWh was repriced at 0.12465 SEK/kWh. That price is the
only input we do not control. The
mandate allows 0.5 per payment. It did not pay, it said why, and it said what would have cleared
it. That transaction is the record. Solana devnet, our token, our counterparty: when a rule
allows a bill, the program executes an SPL transfer of that token to a token account we created.

Five later decisions on the same mandate confirmed on the six-hour cadence. Each was refused.
The per-payment maximum is 0.5, and each charge was over it. Token balances are unchanged on
all five. A fresh export of the mandate prints nine decisions: three paid and six refused
(this refusal, plus the five below).

| Recorded (UTC) | Stockholm window | Spot price | Charge | Decision |
|---|---|---|---|---|
| 2026-09-20 22:00:00 | 2026-09-21 00:00 | 0.16326 SEK/kWh | 8.163 | [refused](https://explorer.solana.com/tx/5MJLtM92foysaWgfqs6x6oBYxyES2Ra2st8UK47dRX8h1F2wo43qQxJt4GFycEWiLSKJQjWbUBhotHMhkHymLoBU?cluster=devnet) |
| 2026-09-21 04:00:08 | 2026-09-21 06:00 | 0.43085 SEK/kWh | 21.5425 | [refused](https://explorer.solana.com/tx/47PZmcRp85U5s3S9GjKekJ7BYcfLeCvY3MKhcDyhyn8Rt5YRdLL5MviymKfFKBeiswn3owx8P6VianW4MRLfU97N?cluster=devnet) |
| 2026-09-21 10:00:00 | 2026-09-21 12:00 | 0.15807 SEK/kWh | 7.9035 | [refused](https://explorer.solana.com/tx/5HTd7nhtGvz2zpxxbszgVBhRAjcv52MTBRLvVoxRt98LXJvaVsEDRcLSbsAzx1SMdRoxekzhTBtmx6T6xTfDVMdr?cluster=devnet) |
| 2026-09-21 16:00:09 | 2026-09-21 18:00 | 1.27877 SEK/kWh | 63.9385 | [refused](https://explorer.solana.com/tx/59ePBRRBGdu51J7aURacABWNtzqhvpWLFzsSfEcFA5eJd4Zn2y2gtY9MtG6fF6dgG8CdFKbWDzvnKGJRSmZKngyq?cluster=devnet) |
| 2026-09-21 22:00:11 | 2026-09-22 00:00 | 1.29704 SEK/kWh | 64.852 | [refused](https://explorer.solana.com/tx/SNZdXV6H5JCuPKxDB5K7ykMbADByXew2nNRuPiue6ETmSRUP9NZgqMuh3XgoEFDZnv7Ltx15JdBAwV7rrf8Umy8?cluster=devnet) |

The recorded time is the block time. The Stockholm window is the SE3 hour the price belongs to,
the 15-minute window that starts at that hour. The first four prices are the Nordic day-ahead
spot for SE3 on 2026-09-21. The fifth is 2026-09-22 00:00. Both days are on the
[same public URL the agent reads](https://www.elprisetjustnu.se/).
Each charge is that price times 50 kWh, the kWh figure the bill is repriced against. The program
log on each transaction is `reason=5 (over
per-payment maximum)` with `per_tx_max=500000` and these base-unit amounts: 8163000, 21542500,
7903500, 63938500, 64852000.

To take one off chain and check it independently:

```bash
cd indexer && npm ci
cd ../tools && npm ci
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature 3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib --out refusal.json
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts refusal.json
# checked against program 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV (idl)
# Mandate limits, ledger entry, and charge transaction agree.
```

Change the amount in that file to 1 and run verify again. While the ring still holds this row:

```
VERDICT: REJECTED

- amount (instruction): record has 1, chain has 6232500
- amount (ledger): record has 1, chain has 6232500
```

## Why Solana Mobile

Seed Vault is built so a human approves every signature. That is the right default, and it is
exactly why unattended agent spend has nowhere to live on this platform. A mandate is the Seed
Vault-shaped answer: the key never leaves the vault, and the agent gets bounded authority beside
it rather than a copy of the key.

## How authority is split

| | Owner key | Agent key |
|---|---|---|
| Lives in | Seed Vault, reached through Mobile Wallet Adapter | app secure storage on the phone |
| Can | open a mandate, override one payment, revoke, close | submit a charge |
| Cannot | be impersonated by the agent | change any limit, change the merchant, extend the expiry, or move funds outside the mandate |

The program does not escrow a spending rule into a vault. `open_mandate` approves the mandate PDA as an SPL
delegate on the source token account for the cap. `charge` moves tokens only within that
delegation. Hold, below, is a separate vault in the same program. Hold is live on devnet.
The app screens exist, and a device check with a real vault follows.

A rule opened in the app gets its own token account. The address is `createAccountWithSeed`
from the owner, seed `veto-rule-<mandate id>`. One owner signature creates that account, moves
the cap into it from the owner's associated token account, and opens the mandate with that
account as the source. Close rule sends the remaining balance back to the owner and closes the
token account, so that rent comes back together with the mandate rent and the ledger rent.
Revoke clears the delegate on that account only. Another rule's token account is not touched.

SPL allows one delegate per token account. A later `open_mandate` on the same source replaces
that delegate. Rules opened before the app grew a per-rule account can still share the owner's
associated token account. On the demo owner token account
`FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE` the delegate, read 2026-09-24, is mandate
`GVwLhzvRNqa5PnKcLakdocC3czQfYrBXGpbHb7HLPEjG` (id 3, cap 300) for 300 tokens. Mandate
`CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g` (id 1) is still active, its source is that same
account, spent 0.666, and it is not the delegate. A charge against id 1 is reason 5 when the bill is over the per-payment limit and reason 7 when it is inside the limits once the delegation is withdrawn. Closing a rule whose source is still that associated account returns the mandate
rent and the ledger rent and leaves the token account in place.

The owner can revoke in one signature, and can also revoke the SPL delegation directly without
this program. The program notices that and records reason 7.

## Put your agent under a rule

The agent key signs `charge` and pays the transaction fee. It is not the owner key.

Generate a keypair and print its public address:

```bash
solana-keygen new --no-bip39-passphrase --silent -o keys/agent.json
solana-keygen pubkey keys/agent.json
```

Fund that address with a little SOL for fees. `status()` warns when the balance is under 100000 lamports, which is 20 charges at the 5000 lamport base fee.

In the app, open a new rule and paste that public address into the field labeled "Agent address". The same screen takes Cap, Per-payment maximum, Expiry (days from now), Payee, and Purpose. The owner key signs the open.

```bash
npm install @veto-hq/agent-sdk
```

Version 0.1.0 was published to npm on 2026-09-27.

The package is published from this checkout by the maintainer. The same package exports `HoldVault` for the vault instructions. Those instructions are on the deployed devnet program; [docs/DEVNET.md](docs/DEVNET.md) records the upgrade. The field-by-field checks are in [sdk/README.md](sdk/README.md). The example loads the agent key and the JSON block the app copies (Copy all, or the same block a QR scan returns), checks that block against the chain, reads the next nonce, submits one `charge` for the amount you pass, and prints the kind, reason code, reason text, suggested override, signature, and slot.

`loadAgentConfig` accepts the JSON text or the parsed object and refuses a missing or extra field. `VetoAgent.fromConfig` pins the program to the id bundled in `sdk/idl/veto.json` unless the caller passes `{ programId }` in code, and a block whose `programId` differs from that id is refused. `mintDecimals` is checked against the mint account. `cluster` is checked against the endpoint's genesis hash (`devnet`, `testnet`, or `mainnet-beta`). A `Connection` passed to `fromConfig` is the endpoint. When it is omitted, the example opens `rpcUrl` from the block.

```bash
cd sdk
npm ci
npx tsx examples/pay-once.ts ../keys/agent.json <config.json> <amount-in-base-units>
```

`watcher/` is the full reference agent. It prices a public electricity spot and submits `charge` on a schedule. This package is the client for one charge and for reading the mandate, the ledger, and the decisions.

## What the chain enforces

Four limits, all on chain, checked on every charge: **cap**, **per-payment maximum**, **expiry**,
and a single allowed **merchant**. Plus replay protection: only a paid charge advances the nonce,
so a settled payment cannot be replayed while a refused one can still be retried after an override.

The human-readable purpose is stored on chain as written and cannot be edited afterwards. The
chain does not understand the word "groceries". The purpose is an immutable statement of intent,
bound to a merchant the chain does enforce.

### Refusal reasons

| Code | Meaning |
|---|---|
| 1 | mandate not active |
| 2 | past expiry |
| 3 | nonce already settled |
| 4 | merchant not allowed |
| 5 | over per-payment maximum |
| 6 | over remaining cap |
| 7 | delegation withdrawn |
| 8 | insufficient funds |
| 9 | zero amount |
| 10 | account frozen |

## Advisory purpose check

A purpose check is the agent's own check of a charge against the rule's on-chain purpose. The
agent operator supplies it, and it is model-agnostic.

On a decline the agent submits no charge and records a memo signed by its own key that names the
rule. The app and the SDK show it as Agent declined (advisory). It is not a program refusal, and
verify does not treat it as one.

The program still enforces every number. Whoever runs the agent can skip the check.

One such check is [sdk/examples/purpose-check.ts](sdk/examples/purpose-check.ts). From `sdk/`,
after `npm ci`:

```bash
PURPOSE_CHECK_URL=<endpoint> npx tsx examples/purpose-check.ts <agent-key.json> <mandate> <amount> "<description>"
```

`amount` is base units. When `VETO_RPC` is unset, the example uses `https://api.devnet.solana.com`.

## Overrides are on the record

The owner can wave one specific payment through above the per-payment ceiling. It takes an owner
signature, applies to exactly one nonce, and is written to the ledger as an override. An override
raises the per-payment ceiling only. It can never raise the total cap, so the number the owner
committed to stays absolute.

The agent retries that refused charge at the nonce the owner named. `VetoAgent.status()` returns
`overrideAmount` and `overrideNonce`. While `overrideNonce` is above `lastNonce`, `nextNonce()`
returns `overrideNonce`. Charge that nonce for an amount no greater than `overrideAmount`, and
still within the remaining cap. The steps are in [sdk/README.md](sdk/README.md).

## The phone

The Android app uses the Backglass look: the Catch mark, Fraunces and Manrope, and the cabinet colors. The approved screens are in [docs/design/backglass/README.md](docs/design/backglass/README.md). Screen-by-screen notes are in [app/README.md](app/README.md).

A fresh install walks five stages, named on the progress strip: Learn, Connect wallet, Add your agent, Approve the rule, and Live. Learn is four steps: your agent can only ask, you set one rule, a refusal is saved, and you decide. Connect continues through naming the agent, approving the rule in Seed Vault, and the live rule. After Live, the same run hands the agent its setup and offers alerts. Those two screens stay on the Live stage of the strip. Skip stores the seen flag. A later launch does not start at Learn again. Help can open How Veto works without clearing that flag.

The four tabs are Overview, Rules, Agents, and Decisions. Overview is the home screen: what the selected agent can still spend, the day of the rule, the paid count, refusals in a row, and today's latest decisions. Rules lists the owner's rules. Agents groups every rule by agent. Decisions filters All, Paid, Refused, Allowed once, and Agent's own declines.

Authorize identifies the app to the wallet as `https://veto-hq.github.io`, name Veto, icon `/icon.png`.

### Grades

An agent is graded across every rule that agent is on. The name comes from the phone's address book. With no saved name the card says Unnamed agent. How grades work states these four rules, from `app/lib/grade.ts`:

| Grade | Rule |
|---|---|
| Stayed inside its rule | Fewer than 1 request in 20 outside its rule. |
| Tested its limit now and then | 1 to 4 requests in 20 outside its rule. |
| Often asked outside its rule | More than 4 requests in 20 outside its rule. |
| Too new to grade | Fewer than 10 requests, or fewer than 3 days running. The facts still show; the label waits. |

A request is a payment the rule paid inside the rule, or refused. A later payment that settles an allowance is not a payment inside the rule. An allowance whose refusal has fallen off the ring still counts as outside. Outside means the rule refused it. The agent's own signed declines are not requests. Money moved outside the rule is always 0, and it is never credit.

The day count starts at the earliest open on that agent's rules. If there is no open row, days count only once the earliest stamp is already 3 days old. Otherwise the grade stays Too new to grade.

Two or more allowances move the shown grade one step lower, and only after the agent is old enough to grade. Stayed inside its rule becomes Tested its limit now and then. Tested its limit now and then becomes Often asked outside its rule. Often asked outside its rule does not move further.

### Record, week, renewal, quiet note

Plaques come from one rule's history. The five are: First payment inside the rule; First refusal saved; Ten refusals, none allowed (10 refusals, and none allowed by you); 30 days inside the rule; Rule finished, rest returned (the rule ran to its end inside its cap). A revoke before the end does not earn the last one.

Week in review is seven local days of that rule: paid and refused counts, refusals grouped by reason, and save or share.

The track record card is an image. Its QR is the rule address. On devnet the card says Devnet, test tokens. The phone opens the share sheet.

During the last seven days before an active rule ends, a banner on Overview and on the rule page opens renewal. It shows what happened, the highest amount asked against the highest amount paid, and the next rule filled from this one (payee, most per payment, total set aside, how long it runs, and purpose). Change edits a field before signing. Let this one end writes nothing and costs nothing. Set up the next rule opens the existing rule flow, and the owner signs it in Seed Vault. The agent stays the one on this rule.

The quiet note is off until you turn it on. You pick a time and one of three sends: Every evening, Only on days something moved, or Never. It is one local notification, computed from that day's decisions. Refusals still arrive when they happen. The phone checks about every 15 minutes in the background, and battery saving can delay a check, so the note says when it last looked.

### Widget

Two Android home screen widgets ship in a build that runs Expo prebuild (a dev client or a release build). Expo Go cannot install them.

- What this agent can still spend: the rule selected in the app, what it can still spend, the last decision, days left, paid and refused counts, and the time the numbers were read.
- One rule: one card per rule. Placing it asks which rule to show.

Every amount comes from the same chain reads as the app. If there is no signed-in owner, no rule, or the read fails, the card says so and does not invent a balance. The app redraws the widgets when it starts in the foreground, when it returns to the foreground, and from the decision background task (minimum interval 15 minutes). Android also requests an update on its own cadence. The minimum these widgets set is 30 minutes, so the background task is the faster path.

## Hold

Hold is a vault in the same program as a spending rule. A rule still does not escrow: the mandate is a delegate. Hold is for a balance the owner deposits and cannot move with a raw transfer. The vault PDA (`["hold", owner, vault_id]`, `vault_id` as a little-endian u64) is the authority of its token account. It holds SPL tokens. Native SOL goes in as wrapped SOL.

Hold is merged and tested, and live on devnet. The 2026-09-25 upgrade added Hold. The live binary is the 2026-09-26 upgrade built from commit `e2a66db`, SHA-256 `58e6180576f280ba22f42d9ef5927a4d0f872b3ecd0db891390587d678975681` ("Hold migration and safe-address upgrade, 2026-09-26" in [docs/DEVNET.md](docs/DEVNET.md)). The app screens exist. A written device check of Hold with a real vault is not recorded in this repository yet. The guardian rules below (any guardian change waits, and a guardian that is also the safe address cannot recover to itself) are in source and not yet deployed to devnet; the devnet program still applies an added guardian at once.

An everyday withdrawal pays at once only when the vault is not frozen, the destination token account has already been paid by this vault, and the running 24 hour total stays inside both the daily limit and `big_share_bps` of the current balance. The app sets that share at 2500, a quarter of the vault. The delay is 1, 2, or 3 days. Anything else is held until `execute` after `unlock_at` on the chain clock. It is not refused, except when the vault cannot cover the amount, or the pending list is full (8). Those two write a refusal and pay nothing. A full known-destination list (16) still pays, and does not grow.

Instructions, from `programs/veto/src/hold.rs`:

| Instruction | Who | What it does |
|---|---|---|
| `init_vault` | owner | Creates the vault, its token account, and its ledger |
| `deposit` | owner | Moves tokens into the vault |
| `withdraw` | owner | Pays at once, or holds until the chain clock plus `delay_secs` |
| `execute` | anyone | Pays a held withdrawal once the chain clock reaches `unlock_at`, if the vault is not frozen, and remembers the destination |
| `stop` | owner or guardian | Cancels one held withdrawal, with no wait |
| `freeze` | owner or guardian | Nothing leaves except `recover` |
| `unfreeze` | owner and guardian | With no guardian set, the owner waits out the current delay |
| `skip` | owner and guardian | Pays a held withdrawal before `unlock_at`, and not while frozen |
| `recover` | owner or guardian | Sends the whole balance to the safe address, including while frozen. The guardian alone is refused if the safe address is the guardian key |
| `propose_change` | owner | Tightening applies immediately. Loosening, including any guardian change, waits out the current delay |
| `apply_change` | anyone | Applies a pending change after `effective_at` on the chain clock |
| `cancel_change` | owner or guardian | Drops a pending change |

Tightening is a lower daily limit, a longer delay, or a lower share. Loosening is a higher limit, a shorter delay, a higher share, adding, removing or changing the guardian, or changing the safe address. Adding a guardian waits too: a guardian co-signs `skip` and `unfreeze`, so a key added at once would let the owner key alone skip the delay. Until the change applies, the new guardian has no power. A mixed change applies the tightening fields now and holds the loosening fields for the current delay.

The wait uses the chain clock only. A stolen guardian key can move money only to the safe address. On a vault that already has a guardian, an attacker with only the owner key can move at once at most the instant allowance to destinations the vault has paid before, or the whole balance to the safe address, and nothing else. Anything else waits, and after the wait anyone can execute it unless the owner or guardian stops it or freezes the vault first. On such a vault no single key shortens a wait or loosens a rule before the delay. `unfreeze` and `skip` are the exception, and they need both keys. A vault without a guardian is weaker; see the known issue below. Every action writes a hold ledger entry and an event. Mandate accounts are unchanged.

`@veto-hq/agent-sdk` exports `HoldVault`. The package is published from this checkout by the maintainer. The watcher raises hold alerts when `VETO_HOLD_VAULTS` is set. The app has the Hold screens, and the phone raises the same alerts. Overview and Rules each open Hold. Details are in [app/README.md](app/README.md), [sdk/README.md](sdk/README.md), and [watcher/README.md](watcher/README.md).

### If someone forces you

What the deployed program guarantees on a vault that had a guardian before any key was lost, from `programs/veto/src/hold.rs`:

- An instant withdrawal only goes to a destination this vault has paid before. A new address gets money before the wait ends only through `skip`, which needs both keys.
- Anything else waits 1, 2, or 3 days on the chain clock, whichever delay the vault was set to.
- No single key, including the owner's, can shorten a wait. Paying a held withdrawal early (`skip`) needs both the owner key and the guardian key. Loosening any rule, including adding or changing the guardian, waits out the current delay. `recover` only goes to the safe address chosen in advance.
- The guardian is alerted and can stop a held withdrawal, or freeze the whole vault, with one tap.

What it does not do:

- It does not protect a person's physical safety.
- Someone who holds the owner for longer than the delay, or who gets both keys, can still get the money.
- A guardian on the same phone as the owner key is not a second factor. Keep the guardian on a second device kept somewhere else.
- The vault's settings, including the safe address, are public on chain. Anyone can read them.

**Known issue, fix pending.** A vault can be created without a guardian. On such a vault the
deployed program treats adding a guardian as a tightening and applies it at once, so whoever holds
the owner key could add a guardian key and then use `skip` with both keys to pay a held withdrawal
without waiting out the delay. The guarantees above do not hold for that vault. The fix makes any
guardian change wait out the vault's delay. It needs a program upgrade, which is pending; until
that upgrade is recorded in [docs/DEVNET.md](docs/DEVNET.md), the deployed program behaves as
described here.

## The demo

An agent pays a bill repriced by a public index, unattended, against an on-chain rule. The index
is the [Nordic day-ahead electricity spot](https://www.elprisetjustnu.se/). The feed is public,
needs no key, and anyone can verify the same numbers against the same URL. The price is the only
input we do not control, which is why the refusal counts. The demo buys no electricity.

Solana devnet. Our token. Our counterparty. [scripts/devnet-setup.sh](scripts/devnet-setup.sh)
creates the mint, mints the supply the watcher spends, and creates the counterparty token
account. [tools/produce.ts](tools/produce.ts) mints further supply of that same mint into a
separate source account. When the rule allows the bill, the program executes an SPL transfer of
that token to the account we created. The counterparty is a terminal we run. Public addresses
are in [docs/DEVNET.md](docs/DEVNET.md).

## A second mint

The program is tested against a snapshot of the real SKR mint in [programs/veto/tests/skr_mint.rs](programs/veto/tests/skr_mint.rs).

The second mandate on devnet (`7Bns2EMrzw9T8apGLRGynean4mkFMwHsEWoXbeTGnNtj`) is not an SKR
integration. Solana Mobile's SKR mint is `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`. That
account is on mainnet, and the same address is absent on devnet, which is the only cluster this
program is deployed to. The second mandate is open against
`Dcbba8YzbTXM1HQ9EeHW7M21T1Ce5PiBsY1Bpxx5K3Kq`, a classic SPL mint created on devnet at 6
decimals, with its own token account (`66RkDwxF51Vzx6Yc7PAGoqkMY6X6bn74gXjT1CiMLhaV`) and its
own delegate, the new mandate account. It is a second asset. `open_mandate` and `charge` already
take the mint they are given, and [tools/second-mint.ts](tools/second-mint.ts) only configures
that path. SKR is the mainnet asset that mint field would name. This mint is not SKR, and it is
not the demo mint `2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU`.

## Repository layout

```
programs/veto/            the Anchor program: mandates, the refusal ledger, and Hold
app/                      the Android app: Backglass, four tabs, grades, Hold, widgets
sdk/                      @veto-hq/agent-sdk: charge, decisions, and HoldVault
watcher/                  unattended agent, and Hold alerts when VETO_HOLD_VAULTS is set
indexer/                  rebuild Paid and Refused history from transaction logs
tools/                    export one decision as JSON and verify it against the chain
scripts/devnet-setup.sh   recreate the chain deploy and demo fixtures from nothing
docs/DECISION_RECORD.md   stable schema for that JSON
docs/DECISIONS.md         pointer to the decision log under docs/internal/
docs/PROBLEM.md           the problem, who has it, what they do today, what Veto does
docs/PLAN.md              build plan, milestones, and prior art
docs/PITCH.md             the pitch: position and the sixty seconds
docs/DECK.md              the deck, slide by slide
docs/DEVNET.md            public devnet addresses, and every recorded upgrade (live: 2026-09-26, e2a66db)
docs/VIDEO.md             the three-minute shot list
docs/SECURITY_REVIEW.md   review of the mandate program at an earlier commit; Hold is out of scope
docs/GCP_SETUP.md         the watcher GCP project, checked by scripts/gcp-verify.sh
docs/design/backglass/    approved Backglass screens and the screen map
docs/internal/            working notes: decisions, self-review, design brief, design decision
```

## Build and run

Requires Rust, the Solana CLI and Anchor. From a fresh clone:

```bash
make test
```

That builds the program and runs the suite, including the refusal test: a
refused charge produces a transaction that confirms, moves nothing, and records why.

`make test` rather than `anchor build && cargo test` for two reasons, both documented in the
Makefile. Anchor 1.2 emits an SBPFv3 ELF that LiteSVM 0.10 cannot load, so the test build pins
SBPF v0. And `target/` is gitignored, so a fresh clone has no program keypair and Anchor needs
`--ignore-keys` rather than rewriting the program id to match a throwaway key.

`make e2e-devnet` runs the devnet journey through the app and the agent SDK. It needs the gitignored deployer key and writes the summary to `app/e2e/last-run.md`. The steps are in [app/README.md](app/README.md).

To provision a chain and the demo fixtures, `make setup` for devnet or `make localnet` against a
local validator. Both deploy. Both refuse unless `keys/program.json` is restored from the
maintainer backup (the keypair for program `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`). That
file is gitignored, and the script does not create it. Reading devnet does not run those targets
and does not need the keypair: use the verify commands in [docs/DEVNET.md](docs/DEVNET.md), or
export / verify below. `npx tsx produce.ts` is not a read. It needs `keys/owner.json` from the
same backup. See [docs/DEVNET.md](docs/DEVNET.md).

The history indexer lives in `indexer/`. It walks program logs rather than trusting the 32-entry
ring. More than a week of decisions at four a day fills that ring, and the 33rd entry overwrites
the oldest. The agent signs every refusal, so 32 refusals can push a paid row out of the window.
`total` still counts, the transactions remain, and durable history is the RPC's transaction
retention or a running indexer. `make
indexer-test` typechecks and tests it. `make indexer-seed` opens a mandate and submits one paid
charge and several refused ones so the CLI can be compared against the ring. The target passes
`VETO_RPC` (default `https://api.devnet.solana.com`) and `VETO_PROGRAM_ID` (default
`3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`). It still needs `keys/devnet-addresses.env`
plus `keys/owner.json` and `keys/agent.json`. `make setup` writes those files, and setup refuses
without the maintainer backup of `keys/program.json`. Without the address file the seed stops on
`missing MINT`.

To take a decision off the phone and check it from a laptop:

```bash
cd indexer && npm ci
cd ../tools && npm ci
VETO_RPC=https://api.devnet.solana.com npx tsx produce.ts
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature <tx> --out refused.json
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts refused.json
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --mandate <mandate> --format csv --out rule.csv
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts rule.csv
```

The JSON schema, the bulk envelope, and the CSV columns are in
[docs/DECISION_RECORD.md](docs/DECISION_RECORD.md). Verify re-reads the cluster; it does
not trust the file. Bulk rows come from the indexer, not the 32-entry ring. The
file itself states `completeness=payments`: complete over charges that landed,
never over attempts.

## Threat model

What a key can do under a mandate.

- **A compromised agent key** can submit charges to the named merchant, up to the per-payment
  maximum, up to the remaining cap, until the expiry. That is the blast radius, and it is the point:
  the mandate is what the owner agreed to lose in the worst case. The owner revokes in one signature.
- **A compromised agent key cannot** widen any field of the mandate, name a different merchant,
  extend the expiry, grant itself an override, or touch any other mandate. Every widening
  instruction requires the owner's signature, and `charge` requires `has_one = agent`.
- **Outside Hold, the program moves only what the owner delegated.** For a spending rule or a
  trade rule, the SPL delegation is the hard ceiling underneath the program's own accounting.
- **Hold balances are held by the program.** A Hold vault is custody, not a delegation: the vault
  PDA is the authority of the vault's token account, and the program moves a deposited balance
  under the Hold rules above.
- **A malicious merchant** can only receive what the mandate allows. A merchant cannot submit a
  charge at all; only the named agent signs `charge`.
- **A forged mandate account cannot be substituted.** `charge` re-derives the mandate address from
  the fields stored inside it and rejects a mismatch, and the CPI signs as that PDA.
- **Hold is live on devnet.** The vault instructions are in this repository and tested. The
  2026-09-25 upgrade added Hold. The live binary is the 2026-09-26 upgrade built from commit
  `e2a66db`, SHA-256 `58e6180576f280ba22f42d9ef5927a4d0f872b3ecd0db891390587d678975681`,
  recorded in [docs/DEVNET.md](docs/DEVNET.md). The bounds in the bullets above are bounds on
  that binary.
- **Devnet upgrade authority.** The devnet program is owned by the upgradeable loader. Its
  upgrade authority is the deployer key listed in [docs/DEVNET.md](docs/DEVNET.md), confirmed
  on chain. On devnet that is one key, `GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1`, held by the
  maintainer, with no multisig and no timelock. Whoever holds that key can replace the program
  logic and, through it, move anything still delegated to a mandate or trade-rule PDA and every
  Hold vault balance. Every bound in this list is a bound on the program as
  deployed, and every devnet record verified by `tools/verify.ts` rests on that. The intent for
  mainnet, where this program is not deployed, is to set the upgrade authority to none before
  the first mandate is opened, after an external audit. A multisig would shrink the set of
  people who can replace the program and would still leave that replacement possible. A fix
  after the authority is set to none is a new program id and a new mandate. Devnet stays
  upgradeable under the single deployer key so findings can be fixed in place.
- **Known limit.** The ledger records every decision this program reaches. A frozen source or
  destination is inspected in `evaluate` and recorded as a refusal. Anchor account validation
  failures (wrong mint, wrong source, wrong ledger) and token-program declines this program does
  not inspect are errors with no entry. The program ledger has no entry for a charge the agent
  never submitted. A purpose decline is the memo in [Advisory purpose check](#advisory-purpose-check),
  and verify does not treat it as a program decision. No payment happens without a record, and no
  submitted attempt is judged by the agent instead of by the chain.

## License

Apache-2.0
