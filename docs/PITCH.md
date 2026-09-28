# Pitch

The claim is the recorded refusal. When a rule fails, the transfer is never executed and no tokens move. The decline is a record, with a reason and the override that would clear it, on a phone, with the key in Seed Vault. The prior art is the table in [PLAN.md](PLAN.md).

## Sixty seconds

> The agent tries to pay. The amount is over the ceiling you set. It does not pay. The chain records why, in one line, with the override that would clear it.
>
> The decline is a record. A blocked overspend elsewhere is a failed transaction: logs and an error code, but nothing in program state. Here the refusal is a successful transaction that records a structured reason and moves no payment tokens.
>
> A rule opened in the app keeps its budget in its own token account, derived from the owner. The mandate is the delegate on that account. The key never leaves Seed Vault. One human, several agents, one rule each. A ruleset is written once and reused on the next agent. This one is on a phone.
>
> The demo pays a bill repriced by a public index, on Solana devnet, in our token, to our counterparty. It buys no electricity. On the rule the video quotes (cap 300, at most 10 per payment, 90 days, purpose "Charging top-ups at the SE3 spot rate", payee 6i99...PdCG, mandate `3hgrSbPX2VTrfnVekoL2qi2qDWNGBhWP3QgADAWz6X6N`) the 12:00 Swedish slot on 2026-09-25 asked 16.659625, over that ceiling. Nothing moved. An override of 16.659625 would have cleared it. That refusal is taken off the phone and verified against the chain from somewhere else.
>
> That record is the point. A worst case fixed in advance, every payment made against it, and every refusal the agent submitted. AP2 standardised the record of a yes. This is the missing half.

## Position

A rule opened in the app keeps the cap in a token account derived from the owner with the seed `veto-rule-<mandate id>`. The mandate PDA is the SPL delegate on that account. Close rule returns the remaining balance and the rent. The key never leaves Seed Vault. One human, several agents, one rule each. A ruleset is written once and reused on the next agent. The other designs are infrastructure. This one is on a phone.

The names are the table in [PLAN.md](PLAN.md): Squads v4 spending limits, SPL `approve` / delegate, LazorKit, Oculus, x402, AP2, and Seed Vault.

On a Veto spending rule the funds stay in an account the owner controls, under a delegate, and the decline is recorded. Hold is a separate vault in the same program, for money the owner deposits and cannot move with a raw transfer. Hold is merged and tested, and live on devnet. The app screens exist, and a device check with a real vault follows.

AP2 mandates are the record of a yes, held off chain as the merchant's evidence. The word mandate, in this repository, is the on-chain rule. Oculus reimburses a breach from a USDC reserve after the fact. This declines before money moves, and the decline is recorded.

A burner wallet is simple. It has no payee restriction and no expiry, and revocation means moving the funds. A refused attempt is a silent error in a log. A third party cannot check the limits that were agreed in advance and every payment made against them. The comparison is in [PROBLEM.md](PROBLEM.md).

## The demo

An agent pays a bill repriced by a public index, unattended, against an on-chain rule. The index is the Nordic day-ahead electricity spot: public, no key, independently verifiable against the same URL. The price is the only input we do not control, which is why the refusal counts. The demo buys no electricity. Solana devnet. Our token. Our counterparty.

The recording uses mandate `3hgrSbPX2VTrfnVekoL2qi2qDWNGBhWP3QgADAWz6X6N`: purpose "Charging top-ups at the SE3 spot rate", cap 300, at most 10 per payment, payee `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG`, 90 days (`expires_at` 1798066105), opened 2026-09-24 22:48:44 UTC. Its source is token account `23gnGjWJMskzuFgdGs8atieGojf9oGGkF4LSfa8MaN2g` (seed `veto-rule-1790290106235`). Read before 18:00 Swedish time on 2026-09-25, this mandate is the delegate on that account. A bill over 10 is reason 5. A bill inside the limits pays while this mandate remains the delegate. The quoted refusal is signature `2DAXYtVCkGPG8RdbYWJcJvZHk4F7tvkJCnqExuyg8qUrdK53DwNUBiCD1MBx3LrzHvd8YXVF7RXr5tz4EujfHo5B`, the 12:00 Swedish slot, 16.659625. From 18:00 that day the demo is set so the watcher charges 6 kWh per slot, which is how later history is meant to mix paid and refused. Those later rows are not a result this page has read.

[scripts/devnet-setup.sh](../scripts/devnet-setup.sh) creates the mint, mints the supply the watcher spends, and creates the counterparty token account. [tools/produce.ts](../tools/produce.ts) mints further supply of that same mint into a separate source account. When the rule allows the bill, the program executes an SPL transfer of that token to the account we created. The counterparty is a terminal we run. Public addresses are in [DEVNET.md](DEVNET.md).

## Connect your agent

On an active rule the rule screen shows Connect your agent: the fields of one JSON block, Copy all, and a QR of that same block. A rule that is not active shows "This rule is not active, so there is no config to hand an agent." and does not show Copy all or the QR. `loadAgentConfig` reads the block. `VetoAgent.fromConfig` checks it against the chain. The program id is the one bundled with the SDK unless the caller passes a different id in code. Decimals are checked on the mint account. The cluster name is checked against the endpoint's genesis hash. A connection passed to `fromConfig` is the endpoint. The example is [sdk/examples/pay-once.ts](../sdk/examples/pay-once.ts).

The agent package is `@veto-hq/agent-sdk`. Version 0.1.0 is on npm: `npm install @veto-hq/agent-sdk`. The same package exports `HoldVault`. The app does not import the package.

## On the phone

The app uses the Backglass look. A fresh install walks five stages: Learn, Connect wallet, Add your agent, Approve the rule, and Live. The four tabs are Overview, Rules, Agents, and Decisions. Overview is the home screen. Authorize identifies the app to the wallet as `https://veto-hq.github.io`.

Agents grades each agent across every rule that agent is on. The four rules, from `app/lib/grade.ts`:

| Grade | Rule |
|---|---|
| Stayed inside its rule | Fewer than 1 request in 20 outside its rule. |
| Tested its limit now and then | 1 to 4 requests in 20 outside its rule. |
| Often asked outside its rule | More than 4 requests in 20 outside its rule. |
| Too new to grade | Fewer than 10 requests, or fewer than 3 days running. The facts still show; the label waits. |

A request is a payment the rule paid inside the rule, or refused. A payment that settles an allowance is not a payment inside the rule. An allowance whose refusal has fallen off the ring still counts as outside. The agent's own signed declines are not requests. Money moved outside the rule is always 0. Two or more allowances, once the agent can be graded, move the shown grade one step lower. Often asked outside its rule does not move further.

Plaques from one rule's history: First payment inside the rule, First refusal saved, Ten refusals, none allowed, 30 days inside the rule, and Rule finished, rest returned. Week in review is seven local days, with paid and refused counts and refusals grouped by reason. The track record card is an image whose QR is the rule address. On devnet it says Devnet, test tokens.

During the last seven days before an active rule ends, renewal offers the next rule filled from this one, or Let this one end, which writes nothing. The quiet note is off until you turn it on: one local line, at a time you choose, sent every evening, only on days something moved, or never.

Two Android home screen widgets show what an agent can still spend. They need a build that runs Expo prebuild. Expo Go cannot install them. Numbers come from the chain. A missing owner, a missing rule, or a failed read does not invent a balance.

Hold on the phone is the vault above: a wait of 1, 2, or 3 days, a second key that can stop a big withdrawal, and alerts that cannot be muted. The app screens exist. Hold is live on devnet, and a device check with a real vault follows.

## Limits

The SPL delegated amount is the ceiling underneath the rule. The rule narrows it by per-payment maximum, expiry, and a single allowed payee. The owner revokes in one signature, and can also revoke the delegation directly without this program. The program notices that revocation and reports it. The worst case is the number the owner already agreed to lose.

On a rule opened in the app, that delegation sits on the rule's own token account. Revoking one rule does not clear another rule's account. On a shared source, SPL allows one delegate, and revoke clears that delegate.

Every decision is a confirmed transaction anyone can look up by its signature. The rule's on-chain ledger is a copy that keeps the latest 32 decisions and is deleted when the owner closes the rule. There is no program ledger entry for a charge the agent never submits. The record is every decision the agent submits. No payment happens without a record, and no submitted attempt is judged by the agent instead of by the chain. The terminal shows payments that arrived. It has no view of a charge the agent never submitted.

No model is involved. The numbers are typed or taken from a template, and the why is a fixed sentence per reason code. The program stores the purpose string as written and does not evaluate it. The agent operator can supply a model-agnostic purpose check of a charge against that on-chain purpose: on a decline the agent submits no charge and records a memo the app and the SDK show as Agent declined (advisory), the program still enforces every number, whoever runs the agent can skip the check, and verify does not treat that memo as a program refusal.

A complete record of every payment made under this authority, a worst case fixed in advance by the rule, and every refusal the agent surfaced. The rule is the prior claim. The decisions are the evidence. Neither is worth anything alone.

## Where this goes

Software is starting to spend money on its own. Every control built so far answers one question: can this agent pay? The record answers the next one: should anyone let it?

A payment ledger shows that an agent had money. The decisions under a rule show what it did at the edge: the limit agreed in advance, every payment made against it, and every refusal it submitted, each one checkable against the chain by someone who trusts neither the owner nor us. That is the history a merchant, an auditor or a counterparty needs before letting software spend unattended. The other designs stop the overspend and keep no such history.

The purpose check is the first step past the numbers. The chain enforces amount, payee and time. The agent can already record why it declined a charge that fits the numbers but not the purpose. The direction is a mandate that governs what the money is for, with the chain keeping the evidence either way.

People built trust with a payment history. Agents will build it with a history of refusals, and that history starts on chain.

## Scope through the deadline

Submissions close October 8, 2026 ([Solana Mobile announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon)).

One spending-rule type. A delegate on a token account the owner controls. Several rules, one agent each. A ruleset written once and applied to the next agent. One pay path. One refusal path with a reason and an override hint. Four tabs: Overview, Rules, Agents, and Decisions. Connect your agent on an active rule. Grades, plaques, a week in review, a track record card, renewal, and a quiet note. An export anyone can re-read from the chain, including after the mandate account is closed. The quoted rule's history is the span above. Hold is a separate vault in the same program, merged and tested, and live on devnet. The app screens exist, and a device check with a real vault follows. No DeFi zoo, no marketplace, no W3C verifiable credential, no signing ceremony, no verifier service.

## Words

The words the entry does not use are in [internal/WORDS.md](internal/WORDS.md).
