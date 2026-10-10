# Veto

## Judges start here

Give your AI agent a spending rule and keep your wallet key. You approve the rule in Seed Vault, and the agent pays with its own key. Every charge transaction that succeeds records a payment, or a refusal with its reason. A charge transaction that fails, for example on invalid accounts, leaves no decision record. From your phone you can allow one payment over the per-payment limit, or stop the rule.

The recorded example is a [12.90 USDC refusal](https://explorer.solana.com/tx/26xUMWrTZhNekv3WMczdeQHd1omrG6MyWrKGbbKfzDi3nRbtmdbQSxCiffu9LtiqS3UTBq2we2Vqmwbfg4pVSXjC?cluster=devnet) against a 5 USDC limit, followed by [the payment after owner approval](https://explorer.solana.com/tx/261ED3JCVMXWxFuRxckJ5ZkxHu9RLLRdNFDxJSdkENw76cmb8t6oGRwF9gWDZQG7J1xwv6uqBFikvLxe1AyVFwQ9?cluster=devnet).

To try it, install the [Android APK](https://github.com/Arlencho/veto/releases/latest) and follow the [setup guide](https://veto-hq.github.io/try/). Fund a test-agent rule, then tap **Send two test requests**.

To verify the refusal yourself, run the [export and verification commands](#see-it-on-devnet) on signature `26xUMWrTZhNekv3WMczdeQHd1omrG6MyWrKGbbKfzDi3nRbtmdbQSxCiffu9LtiqS3UTBq2we2Vqmwbfg4pVSXjC`.

Veto runs on devnet with test money only. It is not externally audited, and [one deployer key can upgrade the program](#threat-model).

## What Veto is

Everyone stops the overspend. Veto also records why it stopped.

Veto enforces a spending rule on chain. When a charge breaks the rule, the transfer is never executed and no tokens move. That much is table stakes, and most of the prior art below already caps agent spending on chain.

The difference is what the stop leaves behind. Elsewhere a blocked overspend is usually a failed transaction. Solana keeps its logs and error code, but no program state changes. In Veto a refusal is a successful transaction that moves no payment tokens and writes a structured reason to program state, with a suggested one-time allowance when one applies. On a phone, with the key in Seed Vault.

Every decision is a confirmed transaction that anyone can look up by its signature. The copy in program state is the rule's on-chain ledger. It keeps the latest 32 decisions and is deleted when the owner closes the rule.

Seed Vault is built so a human approves every signature. That is the right default, and it is exactly why unattended agent spend has nowhere to live on this platform. A mandate is the answer that fits Seed Vault. The key never leaves the vault, and the agent gets bounded authority beside it rather than a copy of the key.

We built Veto for the Solana Mobile "Clock In" hackathon ([Solana Mobile announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon)). The build plan is in [docs/PLAN.md](docs/PLAN.md), the positioning in [docs/PITCH.md](docs/PITCH.md), and the problem and who has it in [docs/PROBLEM.md](docs/PROBLEM.md).

## Prior art

Capped agent spending on Solana is not new, and we do not claim it.

| Prior art | What it does | What Veto adds |
|---|---|---|
| [Squads v4 spending limits](https://squads.xyz/blog/spending-limits) | Pre-approved allowances, roles, per-member caps. Audited by Neodyme, OtterSec and Trail of Bits, two formal verifications underway (per the Squads blog, read 2026-09-28) | Treasury operations for humans. An overspend stops as a failed transaction, with no refusal written to program state |
| SPL `approve` / delegate | Caps what a delegate may pull | Cap only. No purpose, no expiry, no reason, no record |
| [LazorKit](https://github.com/lazor-kit/lazor-kit) | Passkey smart wallet, session keys with slot-height expiry, on-chain RBAC and spending limits | Wallet infrastructure for app developers |
| [Oculus](https://github.com/useoculusagent/useoculusagent) | On-chain policy check per transaction, a USDC reserve reimburses a breach after the fact | Reimburses a breach after the fact. Veto declines before money moves, and the decline is a record |
| [x402](https://metamask.io/news/what-is-x402) / [AP2](https://ap2-protocol.org/) | HTTP 402 settlement. Signed Checkout and Payment mandates as verifiable digital credentials (per the AP2 specification, read 2026-09-28) | AP2 provides signed authorization mandates, and x402 settles payments over HTTP. Veto adds a structured refusal record on chain |

SolAgent Pay was compared here earlier. Its repository, `github.com/altaranexus-ship-it/solagent-pay`, returned HTTP 404 when checked on 2026-09-28. No archived copy was found, so we removed its row and quote.

Capped on-chain agent budgets are documented well enough that infrastructure vendors publish tutorials on them. Our claim is narrower. The refusal is an artifact.

## How a refusal works

When a rule fails, the token transfer instruction is never executed, so zero tokens move. The SPL delegation on the source token account is a second ceiling that the program itself cannot exceed.

When `charge` declines, it does not return an error. An error would roll back every account write, and the refusal would leave nothing in program state, only the failed transaction's logs. Instead the instruction transfers nothing, writes a refusal to an on-chain ledger with a reason code and a suggested one-time allowance when one applies, logs a readable line, and returns `Ok`. Other checks can still stop the payment.

A refusal is a transaction that worked and a payment that did not. The transaction succeeded at deciding no, and the balance is unchanged. Neither party can edit that confirmed transaction or its logs. The ledger entry in program state is not permanent. The ledger is a 32-entry ring, so every later decision the agent submits, paid or refused, can overwrite the oldest entry. The owner can also delete the ledger with `close_mandate` once the rule is no longer active.

## See it on devnet

Veto is live on Solana devnet. To take a decision off chain and check it independently, start with the refusal from [Judges start here](#judges-start-here), the 12.90 USDC request against a 5 USDC limit.

```bash
cd indexer && npm ci
cd ../tools && npm ci
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature 26xUMWrTZhNekv3WMczdeQHd1omrG6MyWrKGbbKfzDi3nRbtmdbQSxCiffu9LtiqS3UTBq2we2Vqmwbfg4pVSXjC --out refusal.json
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts refusal.json
```

Checked against public devnet on 2026-10-09, verify prints:

```
VERDICT: CONFIRMED

rpc                 https://api.devnet.solana.com
cluster             devnet
genesis_hash        EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
program_id          3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
checked against program 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV (idl)
mandate             EWz9bHJVySsdqMSsLp7nsp7T4FheUkdE6pY8MgomYa4v
signature           26xUMWrTZhNekv3WMczdeQHd1omrG6MyWrKGbbKfzDi3nRbtmdbQSxCiffu9LtiqS3UTBq2we2Vqmwbfg4pVSXjC
kind                refused
amount              12900000
counterparty        GDb2L2oQc6LP4nii8ahUX3pqDUNVUn36nPNVafhhtZ7i
timestamp           1790680742
nonce               2
reason              5 (over per-payment maximum)
suggested_override  12900000
limits              cap=20000000 per_tx_max=5000000 expires_at=1794133794
merchant            6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG
purpose             Charging top-ups at the SE3 spot rate

Mandate limits, ledger entry, and charge transaction agree.
```

Change `amount` in that file to 1 and run verify again. While the ring still holds this row, verify rejects the file.

```
VERDICT: REJECTED

- amount (instruction): record has 1, chain has 12900000
- amount (ledger): record has 1, chain has 12900000
```

### The electricity rule

An earlier refusal comes from the electricity demo described [below](#the-demo). Open [this refusal](https://explorer.solana.com/tx/3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib?cluster=devnet) and check three things in order. The transaction succeeded, the token balances are unchanged, and the program log says why.

```
VETO REFUSED reason=5 (over per-payment maximum) amount=6232500 per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

This refusal is for the 18:00 Stockholm window. The nonce `1789920000` is 2026-09-20 16:00:00 UTC, which is 18:00 in Stockholm. The transaction confirmed at 2026-09-20 20:58:12 UTC.

The bill was 6.2325 tokens because 50 kWh was repriced at 0.12465 SEK/kWh. That price is the only input we do not control. The mandate allows 0.5 per payment. The program did not pay, it said why, and the last log field is the one-time allowance it suggests for this charge. That transaction is the record.

Five later decisions on the same mandate confirmed on the six-hour cadence. Each charge was over the 0.5 per-payment maximum and was refused, and token balances are unchanged on all five. A fresh export of the mandate prints nine decisions, three paid and six refused. The six are this refusal and the five below.

| Recorded (UTC) | Stockholm window | Spot price | Charge | Decision |
|---|---|---|---|---|
| 2026-09-20 22:00:00 | 2026-09-21 00:00 | 0.16326 SEK/kWh | 8.163 | [refused](https://explorer.solana.com/tx/5MJLtM92foysaWgfqs6x6oBYxyES2Ra2st8UK47dRX8h1F2wo43qQxJt4GFycEWiLSKJQjWbUBhotHMhkHymLoBU?cluster=devnet) |
| 2026-09-21 04:00:08 | 2026-09-21 06:00 | 0.43085 SEK/kWh | 21.5425 | [refused](https://explorer.solana.com/tx/47PZmcRp85U5s3S9GjKekJ7BYcfLeCvY3MKhcDyhyn8Rt5YRdLL5MviymKfFKBeiswn3owx8P6VianW4MRLfU97N?cluster=devnet) |
| 2026-09-21 10:00:00 | 2026-09-21 12:00 | 0.15807 SEK/kWh | 7.9035 | [refused](https://explorer.solana.com/tx/5HTd7nhtGvz2zpxxbszgVBhRAjcv52MTBRLvVoxRt98LXJvaVsEDRcLSbsAzx1SMdRoxekzhTBtmx6T6xTfDVMdr?cluster=devnet) |
| 2026-09-21 16:00:09 | 2026-09-21 18:00 | 1.27877 SEK/kWh | 63.9385 | [refused](https://explorer.solana.com/tx/59ePBRRBGdu51J7aURacABWNtzqhvpWLFzsSfEcFA5eJd4Zn2y2gtY9MtG6fF6dgG8CdFKbWDzvnKGJRSmZKngyq?cluster=devnet) |
| 2026-09-21 22:00:11 | 2026-09-22 00:00 | 1.29704 SEK/kWh | 64.852 | [refused](https://explorer.solana.com/tx/SNZdXV6H5JCuPKxDB5K7ykMbADByXew2nNRuPiue6ETmSRUP9NZgqMuh3XgoEFDZnv7Ltx15JdBAwV7rrf8Umy8?cluster=devnet) |

The recorded time is the block time. The Stockholm window is the SE3 hour the price belongs to, which is the 15-minute window that starts at that hour. The first four prices are the Nordic day-ahead spot for SE3 on 2026-09-21, and the fifth is 2026-09-22 00:00. Both days are on the [same public URL the agent reads](https://www.elprisetjustnu.se/). Each charge is that price times 50 kWh, the kWh figure the bill is repriced against. The program log on each transaction is `reason=5 (over per-payment maximum)` with `per_tx_max=500000`, and the base-unit amounts are 8163000, 21542500, 7903500, 63938500 and 64852000.

The 3rTpy refusal, on mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g`, checks the same way.

```bash
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature 3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib --out refusal-3rtpy.json
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts refusal-3rtpy.json
# VERDICT: CONFIRMED
# checked against program 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV (idl)
# Mandate limits, ledger entry, and charge transaction agree.
```

With its amount changed to 1, verify prints `VERDICT: REJECTED` with `record has 1, chain has 6232500` for the instruction and the ledger.

The public RPC rate-limits. If verify prints `rpc rate limited`, wait and run it again, or pass `--rpc <your devnet URL>`.

## Put your agent under a rule

The agent key signs `charge` and pays the transaction fee. It is not the owner key.

Generate a keypair and print its public address.

```bash
solana-keygen new --no-bip39-passphrase --silent -o keys/agent.json
solana-keygen pubkey keys/agent.json
```

Fund that address with a little SOL for fees. `status()` warns when the balance is under 100000 lamports, which is 20 charges at the 5000 lamport base fee.

In the app, open a new rule and paste that public address into the field labeled "Agent address". The same screen takes Cap, Per-payment maximum, Expiry (days from now), Payee, and Purpose. The owner key signs the open.

```bash
npm install @veto-hq/agent-sdk
```

Version 0.1.1 was published to npm on 2026-09-28 (0.1.0 on 2026-09-27).

The package is published from this checkout by the maintainer. It also exports `HoldVault` for the vault instructions. Those instructions are on the deployed devnet program, and [docs/DEVNET.md](docs/DEVNET.md) records the upgrade. The field-by-field checks are in [sdk/README.md](sdk/README.md).

The example below loads the agent key and the JSON block the app copies, which is the same block whether you use Copy all or scan the QR. It checks that block against the chain, reads the next nonce, submits one `charge` for the amount you pass, and prints the kind, reason code, reason text, suggested override, signature, and slot.

`loadAgentConfig` accepts the JSON text or the parsed object and refuses a missing or extra field. `VetoAgent.fromConfig` pins the program to the id bundled in `sdk/idl/veto.json` unless the caller passes `{ programId }` in code, and it refuses a block whose `programId` differs from that id. `mintDecimals` is checked against the mint account, and `cluster` (`devnet`, `testnet`, or `mainnet-beta`) against the endpoint's genesis hash. A `Connection` passed to `fromConfig` is the endpoint. Without one, the example opens `rpcUrl` from the block.

```bash
cd sdk
npm ci
npx tsx examples/pay-once.ts ../keys/agent.json <config.json> <amount-in-base-units>
```

`watcher/` is the full reference agent. It prices a public electricity spot and submits `charge` on a schedule. This package is the client for one charge and for reading the mandate, the ledger, and the decisions.

## How authority is split

| | Owner key | Agent key |
|---|---|---|
| Lives in | your connected Mobile Wallet Adapter wallet (Seed Vault on a Seeker) | on the agent's machine (for example `keys/agent.json` or the CLI's `~/.veto/agent.json`), or app secure storage for the phone's test agent |
| Can | open a mandate, override one payment, revoke, close | submit a charge |
| Cannot | be impersonated by the agent | change any limit, change the merchant, extend the expiry, or move funds outside the mandate |

The program does not escrow a spending rule into a vault. `open_mandate` approves the mandate PDA as an SPL delegate on the source token account for the cap, and `charge` moves tokens only within that delegation. [Hold](#hold) is a separate vault in the same program.

A rule opened in the app gets its own token account. The address is `createAccountWithSeed` from the owner, with seed `veto-rule-<mandate id>`. One owner signature creates that account, moves the cap into it from the owner's associated token account, and opens the mandate with that account as the source. Close rule sends the remaining balance back to the owner and closes the token account, so that rent comes back together with the mandate rent and the ledger rent. Revoke clears the delegate on that account only and does not touch another rule's token account.

SPL allows one delegate per token account, so a later `open_mandate` on the same source replaces that delegate. Rules opened before the app grew a per-rule account can still share the owner's associated token account. As of 2026-09-24, the delegate on the demo owner token account `FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE` is mandate `GVwLhzvRNqa5PnKcLakdocC3czQfYrBXGpbHb7HLPEjG` (id 3, cap 300) for 300 tokens. Mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g` (id 1) is still active, its source is that same account, it has spent 0.666, and it is not the delegate. A charge against id 1 is reason 5 when the bill is over the per-payment limit and reason 7 when it is inside the limits once the delegation is withdrawn. Closing a rule whose source is still that associated account returns the mandate rent and the ledger rent and leaves the token account in place.

The owner can revoke in one signature, and can also revoke the SPL delegation directly without this program. The program notices that and records reason 7.

## Limits

Four limits are checked on chain on every charge: the cap, the per-payment maximum, the expiry, and a single allowed merchant. The nonce adds replay protection. Only a paid charge advances it, so a settled payment cannot be replayed, while a refused one can still be retried after an override.

The human-readable purpose is stored on chain as written and cannot be edited afterwards. The chain does not understand the word "groceries". The purpose is an immutable statement of intent, bound to a merchant the chain does enforce.

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

Trade rules add four reasons, defined in `programs/veto/src/trade_state.rs`.

| Code | Meaning |
|---|---|
| 11 | destination not allowed |
| 12 | pool not allowed |
| 13 | over rolling daily limit |
| 14 | below price floor |

The price floor is the worst price the rule accepts. An agent can trade at exactly the floor, so set it at a price you are willing to get.

### Overrides

The owner can wave one specific payment through above the per-payment ceiling. It takes an owner signature, applies to exactly one nonce, and is written to the ledger as an override. An override raises the per-payment ceiling only. It can never raise the total cap, so the number the owner committed to stays absolute.

The agent retries the refused charge at the nonce the owner named. `VetoAgent.status()` returns `overrideAmount` and `overrideNonce`. While `overrideNonce` is above `lastNonce`, `nextNonce()` returns `overrideNonce`. Charge that nonce for an amount no greater than `overrideAmount` and still within the remaining cap. The steps are in [sdk/README.md](sdk/README.md).

## Advisory purpose check

A purpose check is the agent's own check of a charge against the rule's on-chain purpose. The agent operator supplies it, and it is model-agnostic.

On a decline the agent submits no charge and records a memo, signed by its own key, that names the rule. The app and the SDK show it as Agent declined (advisory). It is not a program refusal, and verify does not treat it as one.

The program still enforces every number. Whoever runs the agent can skip the check.

[sdk/examples/purpose-check.ts](sdk/examples/purpose-check.ts) is one such check. Run it from `sdk/` after `npm ci`.

```bash
PURPOSE_CHECK_URL=<endpoint> npx tsx examples/purpose-check.ts <agent-key.json> <mandate> <amount> "<description>"
```

`amount` is in base units. When `VETO_RPC` is unset, the example uses `https://api.devnet.solana.com`.

## The phone

The Android app uses the Backglass look, with the Catch mark, Fraunces and Manrope, and the cabinet colors. The approved screens are in [docs/design/backglass/README.md](docs/design/backglass/README.md), and screen-by-screen notes are in [app/README.md](app/README.md).

A fresh install walks five stages, named on the progress strip: Learn, Connect wallet, Add your agent, Approve the rule, and Live. Learn has four steps. Your agent can only ask, you set one rule, a refusal is saved, and you decide. Connect continues through naming the agent, approving the rule in Seed Vault, and the live rule. After Live, the same run hands the agent its setup and offers alerts, and those two screens stay on the Live stage of the strip. Skip stores the seen flag, so a later launch does not start at Learn again. Help can open How Veto works without clearing that flag.

The four tabs are Overview, Rules, Agents, and Decisions. Overview is the home screen. It shows what the selected agent can still spend, the day of the rule, the paid count, refusals in a row, and today's latest decisions. Rules lists the owner's rules. Agents groups every rule by agent. Decisions filters All, Paid, Refused, Allowed once, and Agent's own declines.

Authorize identifies the app to the wallet as `https://veto-hq.github.io`, with name Veto and icon `/icon.png`.

### Grades

An agent is graded across every rule that agent is on. The name comes from the phone's address book, and with no saved name the card says Unnamed agent. How grades work states these four rules, taken from `app/lib/grade.ts`.

| Grade | Rule |
|---|---|
| Stayed inside its rule | Fewer than 1 request in 20 outside its rule. |
| Tested its limit now and then | 1 to 4 requests in 20 outside its rule. |
| Often asked outside its rule | More than 4 requests in 20 outside its rule. |
| Too new to grade | Fewer than 10 requests, or fewer than 3 days running. The facts still show; the label waits. |

A request is a payment the rule paid inside the rule, or refused. Outside means the rule refused it. A later payment that settles an allowance is not a payment inside the rule. An allowance whose refusal has fallen off the ring still counts as outside. The agent's own signed declines are not requests. Money moved outside the rule is always 0, and it is never credit.

The day count starts at the earliest open on that agent's rules. If there is no open row, days count only once the earliest stamp is already 3 days old. Until then the grade stays Too new to grade.

Two or more allowances move the shown grade one step lower, and only after the agent is old enough to grade. Stayed inside its rule becomes Tested its limit now and then, and Tested its limit now and then becomes Often asked outside its rule. Often asked outside its rule does not move further.

### Track record and renewal

Plaques come from one rule's history. The five are First payment inside the rule; First refusal saved; Ten refusals, none allowed (10 refusals, and none allowed by you); 30 days inside the rule; and Rule finished, rest returned (the rule ran to its end inside its cap). A revoke before the end does not earn the last one.

Week in review covers seven local days of that rule, with paid and refused counts, refusals grouped by reason, and save or share.

The track record card is an image whose QR is the rule address. On devnet the card says Devnet, test tokens. The phone opens the share sheet.

During the last seven days before an active rule ends, a banner on Overview and on the rule page opens renewal. It shows what happened, the highest amount asked against the highest amount paid, and the next rule filled from this one (payee, most per payment, total set aside, how long it runs, and purpose). Change edits a field before signing. Let this one end writes nothing and costs nothing. Set up the next rule opens the existing rule flow, and the owner signs it in Seed Vault. The agent stays the one on this rule.

The quiet note is off until you turn it on. You pick a time and one of three sends: Every evening, Only on days something moved, or Never. It is one local notification, computed from that day's decisions. Refusals still arrive when they happen. The phone checks about every 15 minutes in the background, and battery saving can delay a check, so the note says when it last looked.

### Widgets

Two Android home screen widgets ship in a build that runs Expo prebuild, either a dev client or a release build. Expo Go cannot install them.

The first widget, What this agent can still spend, shows the rule selected in the app, what it can still spend, the last decision, days left, paid and refused counts, and the time the numbers were read. The second, One rule, shows one card per rule, and placing it asks which rule to show.

Every amount comes from the same chain reads as the app. If there is no signed-in owner, no rule, or the read fails, the card says so and does not invent a balance. The app redraws the widgets when it starts in the foreground, when it returns to the foreground, and from the decision background task (minimum interval 15 minutes). Android also requests an update on its own cadence. The minimum these widgets set is 30 minutes, so the background task is the faster path.

## Hold

Hold is a vault in the same program as a spending rule. A rule still does not escrow, because the mandate is a delegate. Hold is for a balance the owner deposits and cannot move with a raw transfer. The vault PDA (`["hold", owner, vault_id]`, `vault_id` as a little-endian u64) is the authority of its token account. It holds SPL tokens, and native SOL goes in as wrapped SOL.

Choose a safe address that the guardian does not control and that you could not be forced to hand over, for example a cold wallet kept elsewhere. Recovery sends everything there.

Hold is merged and tested, and live on devnet. The 2026-09-25 upgrade added Hold. The live binary is the 2026-09-28 upgrade built from commit `74c9e99`, SHA-256 `31dd22337359e3c31951e312b130b6de71b244d884e2530140182d5ee9529bd2` ("Hold guardian and safe-address upgrade, 2026-09-28" in [docs/DEVNET.md](docs/DEVNET.md)). The guardian rules below are deployed on devnet in that upgrade. Any guardian change waits, and neither key alone can recover or close to itself when it is also the safe address. The app screens exist. A written device check of Hold with a real vault is not recorded in this repository yet.

An everyday withdrawal pays at once only when the vault is not frozen, the destination token account has already been paid by this vault, and the running 24 hour total stays inside both the daily limit and `big_share_bps` of the current balance. The app sets that share at 2500, a quarter of the vault. The delay is 1, 2, or 3 days. Anything else is held until `execute` after `unlock_at` on the chain clock. It is not refused, except when the vault cannot cover the amount or the pending list is full (8). Those two write a refusal and pay nothing. A full known-destination list (16) still pays, and does not grow.

The instructions are defined in `programs/veto/src/hold.rs`.

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
| `recover` | owner or guardian | Sends the whole balance to the safe address, including while frozen. Neither key alone can recover to itself. The guardian alone is refused if the safe address is the guardian key, and the owner alone is refused if the safe address is the owner key |
| `propose_change` | owner | Tightening applies immediately. Loosening, including any guardian change, waits out the current delay |
| `apply_change` | anyone | Applies a pending change after `effective_at` on the chain clock |
| `cancel_change` | owner or guardian | Drops a pending change |
| `migrate_hold_vault` | owner | Reallocates a vault from the older layout in place, keeping its rules and history ([docs/HOLD_MIGRATIONS.md](docs/HOLD_MIGRATIONS.md)) |
| `close_hold_vault` | owner | With no held withdrawal and not frozen, sends the whole balance to the safe address and closes the vault. The owner cannot close to itself, so it is refused if the safe address is the owner key |

Tightening is a lower daily limit, a longer delay, or a lower share. Loosening is a higher limit, a shorter delay, a higher share, adding, removing or changing the guardian, or changing the safe address. Adding a guardian waits too. A guardian co-signs `skip` and `unfreeze`, so a key added at once would let the owner key alone skip the delay. Until the change applies, the new guardian has no power. A mixed change applies the tightening fields now and holds the loosening fields for the current delay.

The wait uses the chain clock only. A stolen guardian key can move money only to the safe address. On a vault that already has a guardian, an attacker with only the owner key can move at once at most the instant allowance to destinations the vault has paid before, or the whole balance to the safe address, and nothing else. Anything else waits, and after the wait anyone can execute it unless the owner or guardian stops it or freezes the vault first. On such a vault no single key shortens a wait or loosens a rule before the delay. The exceptions are `unfreeze` and `skip`, and they need both keys. A vault without a guardian is weaker, as the note below explains. Every action writes a hold ledger entry and an event. Mandate accounts are unchanged.

`@veto-hq/agent-sdk` exports `HoldVault`, and the package is published from this checkout by the maintainer. The watcher raises hold alerts when `VETO_HOLD_VAULTS` is set. The app has the Hold screens, and the phone raises the same alerts. Overview and Rules each open Hold. Details are in [app/README.md](app/README.md), [sdk/README.md](sdk/README.md), and [watcher/README.md](watcher/README.md).

### If someone forces you

On a vault that had a guardian before any key was lost, the deployed program (`programs/veto/src/hold.rs`) guarantees the following.

- An instant withdrawal only goes to a destination this vault has paid before. A new address gets money before the wait ends only through `skip`, which needs both keys.
- Anything else waits 1, 2, or 3 days on the chain clock, whichever delay the vault was set to.
- No single key, including the owner's, can shorten a wait. Paying a held withdrawal early (`skip`) needs both the owner key and the guardian key. Loosening any rule, including adding or changing the guardian, waits out the current delay. `recover` only goes to the safe address chosen in advance.
- The guardian is alerted and can stop a held withdrawal, or freeze the whole vault, with one tap. The alert comes from a background check about every 15 minutes, which Android can delay, and it cannot be muted inside Veto.

The program does not do the following.

- It does not protect a person's physical safety.
- Someone who holds the owner for longer than the delay, or who gets both keys, can still get the money.
- A guardian on the same phone as the owner key is not a second factor. Keep the guardian on a second device kept somewhere else.
- The vault's settings, including the safe address, are public on chain. Anyone can read them.

A vault can be created without a guardian. Before the 2026-09-28 upgrade, the deployed program treated adding a guardian to such a vault as a tightening and applied it at once. Whoever held the owner key could add a guardian key and then use `skip` with both keys to pay a held withdrawal without waiting out the delay. That upgrade, recorded in [docs/DEVNET.md](docs/DEVNET.md), fixed this by making any guardian change wait out the vault's delay. Vaults created before the 2026-09-26 safe-address upgrade may have a safe address equal to the guardian and should be repaired ([docs/HOLD_MIGRATIONS.md](docs/HOLD_MIGRATIONS.md)).

## The demo

An agent pays a bill repriced by a public index, unattended, against an on-chain rule. The index is the [Nordic day-ahead electricity spot](https://www.elprisetjustnu.se/). The feed is public and needs no key, and anyone can verify the same numbers against the same URL. The price is the only input we do not control, which is why the refusal counts. The demo buys no electricity.

The demo runs on Solana devnet with our token and our counterparty. [scripts/devnet-setup.sh](scripts/devnet-setup.sh) creates the mint, mints the supply the watcher spends, and creates the counterparty token account. [tools/produce.ts](tools/produce.ts) mints further supply of that same mint into a separate source account. When the rule allows the bill, the program executes an SPL transfer of that token to the account we created. The counterparty is a terminal we run. Public addresses are in [docs/DEVNET.md](docs/DEVNET.md).

### A second mint

The program is tested against a snapshot of the real SKR mint in [programs/veto/tests/skr_mint.rs](programs/veto/tests/skr_mint.rs).

The second mandate on devnet (`7Bns2EMrzw9T8apGLRGynean4mkFMwHsEWoXbeTGnNtj`) is not an SKR integration. Solana Mobile's SKR mint is `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`. That account is on mainnet, and the same address is absent on devnet, which is the only cluster this program is deployed to. The second mandate is open against `Dcbba8YzbTXM1HQ9EeHW7M21T1Ce5PiBsY1Bpxx5K3Kq`, a classic SPL mint created on devnet at 6 decimals, with its own token account (`66RkDwxF51Vzx6Yc7PAGoqkMY6X6bn74gXjT1CiMLhaV`) and its own delegate, the new mandate account. It is a second asset. `open_mandate` and `charge` already take the mint they are given, and [tools/second-mint.ts](tools/second-mint.ts) only configures that path. SKR is the mainnet asset that mint field would name. This mint is not SKR, and it is not the demo mint `2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU`.

## Repository layout

```
programs/veto/            the Anchor program: mandates, the refusal ledger, and Hold
app/                      the Android app: Backglass, four tabs, grades, Hold, widgets
sdk/                      @veto-hq/agent-sdk: charge, decisions, and HoldVault
cli/                      @veto-hq/veto: the companion CLI for pairing agents, payments, and MCP tools
watcher/                  unattended agent, and Hold alerts when VETO_HOLD_VAULTS is set
indexer/                  rebuild Paid and Refused history from transaction logs
tools/                    export one decision as JSON and verify it against the chain
service/                  veto-index: the Postgres decision index
terminal/                 the demo merchant terminal (the counterparty screen)
loadtest/                 on-chain and off-chain load tests and their reports
e2e/                      Maestro device flows
scripts/devnet-setup.sh   recreate the chain deploy and demo fixtures from nothing
docs/DECISION_RECORD.md   stable schema for that JSON
docs/DECISIONS.md         pointer to the decision log under docs/internal/
docs/PROBLEM.md           the problem, who has it, what they do today, what Veto does
docs/PLAN.md              build plan, milestones, and prior art
docs/PITCH.md             the pitch: position and the sixty seconds
docs/DECK.md              the deck, slide by slide
docs/DEVNET.md            public devnet addresses, and every recorded upgrade (live: 2026-09-28, 74c9e99)
docs/MAINNET.md           not deployed on mainnet: the plan and an address template
docs/HOLD_MIGRATIONS.md   repairing and migrating older Hold vaults
docs/PUBLISH.md           maintainer steps for publishing the SDK and CLI to npm
docs/VIDEO.md             the three-minute shot list
docs/TESTERS.md           how a Seeker owner installs and tries the devnet APK
docs/RELEASE_NOTES.md     release notes for the tester APK
docs/SCALE.md             compute unit and throughput measurements
docs/SECURITY_REVIEW.md   internal review of the mandate program at 4b50a63; Hold and trade are out of scope
docs/GCP_SETUP.md         the watcher GCP project, checked by scripts/gcp-verify.sh
docs/design/backglass/    approved Backglass screens and the screen map
docs/internal/            working notes: decisions, self-review, design brief, design decision
```

## Build and run

Building requires Rust, the Solana CLI and Anchor. From a fresh clone:

```bash
make test
```

That builds the program and runs the suite, including the refusal test. A refused charge produces a transaction that confirms, moves nothing, and records why.

We use `make test` rather than `anchor build && cargo test` for two reasons, both documented in the Makefile. First, Anchor 1.2 emits an SBPFv3 ELF that LiteSVM 0.10 cannot load, so the test build pins SBPF v0. Second, `target/` is gitignored, so a fresh clone has no program keypair, and Anchor needs `--ignore-keys` rather than rewriting the program id to match a throwaway key.

`make e2e-devnet` runs the devnet journey through the app and the agent SDK. It needs the gitignored deployer key and writes the summary to `app/e2e/last-run.md`. The steps are in [app/README.md](app/README.md).

To provision a chain and the demo fixtures, run `make setup` for devnet or `make localnet` against a local validator. Both deploy, and both refuse unless `keys/program.json` is restored from the maintainer backup (the keypair for program `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`). That file is gitignored, and the script does not create it. Reading devnet does not run those targets and does not need the keypair. Use the verify commands in [docs/DEVNET.md](docs/DEVNET.md), or the export and verify commands below. `npx tsx produce.ts` is not a read. It needs `keys/owner.json` from the same backup, as [docs/DEVNET.md](docs/DEVNET.md) explains.

The history indexer lives in `indexer/`. It walks program logs rather than trusting the 32-entry ring. More than a week of decisions at four a day fills that ring, and the 33rd entry overwrites the oldest. The agent signs every refusal, so 32 refusals can push a paid row out of the window. `total` still counts and the transactions remain. Durable history is the RPC's transaction retention or a running indexer.

`make indexer-test` typechecks and tests the indexer. `make indexer-seed` opens a mandate and submits one paid charge and several refused ones, so the CLI can be compared against the ring. The target passes `VETO_RPC` (default `https://api.devnet.solana.com`) and `VETO_PROGRAM_ID` (default `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`). It still needs `keys/devnet-addresses.env` plus `keys/owner.json` and `keys/agent.json`. `make setup` writes those files, and setup refuses without the maintainer backup of `keys/program.json`. Without the address file the seed stops on `missing MINT`.

To take a decision off the phone and check it from a laptop:

```bash
cd indexer && npm ci
cd ../tools && npm ci
# maintainer only: npx tsx produce.ts (needs the gitignored keypairs under keys/)
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature <tx> --out refused.json
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts refused.json
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --mandate <mandate> --format csv --out rule.csv
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts rule.csv
```

A `--mandate` export walks the program's history and can take many minutes on the public endpoint, which also rate-limits as noted under [See it on devnet](#see-it-on-devnet).

The JSON schema, the bulk envelope, and the CSV columns are in [docs/DECISION_RECORD.md](docs/DECISION_RECORD.md). Verify re-reads the cluster and does not trust the file. Bulk rows come from the indexer, not the 32-entry ring. The file itself states `completeness=payments`, which means complete over charges that landed and never over attempts.

## Threat model

What a compromised key can and cannot do under a mandate, and the bounds the deployment itself sets.

A compromised agent key can submit charges to the named merchant, up to the per-payment maximum, up to the remaining cap, until the expiry. That is the blast radius, and it is deliberate. The mandate is what the owner agreed to lose in the worst case, and the owner revokes in one signature.

A compromised agent key cannot widen any field of the mandate, name a different merchant, extend the expiry, grant itself an override, or charge a rule naming another agent. A stolen agent key can use every rule that names it, including a pending allow-once, within each rule's limits. Every widening instruction requires the owner's signature, and `charge` and `trade` require `has_one = agent`.

Outside Hold, the program moves only what the owner delegated. For a spending rule or a trade rule, the SPL delegation is the hard ceiling underneath the program's own accounting.

Hold balances are held by the program. A Hold vault is custody, not a delegation. The vault PDA is the authority of the vault's token account, and the program moves a deposited balance under the Hold rules above.

A malicious merchant can receive only what the mandate allows through `charge`. Being the merchant grants no signing authority, because submitting a charge requires the named agent's key. If the merchant also controls that key, the compromised-agent bounds above apply.

A forged mandate account cannot be substituted. `charge` re-derives the mandate address from the fields stored inside it and rejects a mismatch, and the CPI signs as that PDA.

Hold is live on devnet. The vault instructions are in this repository and tested. The 2026-09-25 upgrade added Hold. The live binary is the 2026-09-28 upgrade built from commit `74c9e99`, SHA-256 `31dd22337359e3c31951e312b130b6de71b244d884e2530140182d5ee9529bd2`, recorded in [docs/DEVNET.md](docs/DEVNET.md). The bounds above are bounds on that binary.

The devnet program is owned by the upgradeable loader. Its upgrade authority is the deployer key listed in [docs/DEVNET.md](docs/DEVNET.md), confirmed on chain. On devnet that is one key, `GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1`, held by the maintainer, with no multisig and no timelock. Whoever holds that key can replace the program logic and, through it, move anything still delegated to a mandate or trade-rule PDA and every Hold vault balance. Every bound in this section is a bound on the program as deployed, and every devnet record verified by `tools/verify.ts` rests on that. For mainnet, where this program is not deployed, the intent is to set the upgrade authority to none after an external audit and before the first mandate is opened. A multisig would shrink the set of people who can replace the program and would still leave that replacement possible. After the authority is set to none, a fix means a new program id and a new mandate. Devnet stays upgradeable under the single deployer key so findings can be fixed in place.

One known limit. The ledger records only decisions reached in charge transactions that succeed. A failed transaction rolls back every ledger write, including a refusal reached before a later instruction fails. A frozen source or destination is inspected in `evaluate` and recorded as a refusal. Anchor account validation failures (wrong mint, wrong source, wrong ledger) and token-program declines this program does not inspect are errors with no entry. The program ledger has no entry for a charge the agent never submitted. A purpose decline is the memo described in [Advisory purpose check](#advisory-purpose-check), and verify does not treat it as a program decision. No payment happens without a record, and no submitted attempt is judged by the agent instead of by the chain.

## License

Apache-2.0
