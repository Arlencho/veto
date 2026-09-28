# Decisions

Append-only. Each entry states the decision, the reason, and what would reverse it.

## 2026-09-20: enter Clock In as a standalone project

Standalone repo, no coupling to any existing product. The hackathon requires the project to have
started within three months of the Sep 8 launch date, and a fresh repo removes any argument about
that. It also removes an external approval dependency from the critical path.

Reversed by: nothing. Submissions close October 8, 2026 ([Solana Mobile announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon)).

## 2026-09-20: the rule is enforced on chain, not on a server

An Anchor program owns the mandate and decides every charge. A server-side policy engine would
have been faster to build, but then the refusal is our word rather than a verifiable fact, and the
refusal is the entire product.

Reversed by: the SPL delegate mechanism failing on devnet in a way we cannot work around, in which
case the fallback is a vault PDA that holds the funds. Same enforcement, weaker custody story.

## 2026-09-20: a refusal returns Ok and writes a ledger entry

The `charge` instruction never returns an error when it declines. Returning an error would roll
back the account writes, so the refusal would leave no on-chain trace and the demo would be an
absence rather than an artifact. Declining therefore transfers nothing, writes a ledger entry with
a reason code, and returns Ok. The transaction confirms and the balance is unchanged.

Reversed by: nothing. This is the product.

## 2026-09-20: funds stay in the user's wallet

The mandate PDA is an SPL delegate on the source token account, not a vault holding the money.
The agent holds a separate hot key with authority and no spending power of its own. The owner key
stays in Seed Vault and is reached through Mobile Wallet Adapter. Where a rule opened in the app
keeps that budget is the 2026-09-24 entry.

Reversed by: the delegate path proving unworkable, per the entry above.

## 2026-09-20: the claim is legible refusal, not bounded authority

A competitive check found that capped on-chain agent budgets are commodity: Squads v4 ships
audited spending limits, with two formal verifications underway, LazorKit ships session keys with
on-chain roles and limits, AP2 standardised signed mandates carrying limits and validity windows,
and an infrastructure vendor publishes a tutorial on capped on-chain agent budgets. The named
designs are the table in the README.

The closest of them, SolAgent Pay, states outright that an overspend "is not a policy violation
logged after the fact, it is an impossible transaction". That is the opposite thesis and it is what
we differentiate against. An impossible transaction leaves no artifact, no reason and no trail.

Update 2026-09-28: the SolAgent Pay repository returned HTTP 404 and no archived copy was found, so
the quote above can no longer be checked. It was removed from the README, PLAN, PITCH and DECK.

So the claim is narrowed and sharpened: the refusal is legible. A recorded no, a reason, and the
override that would clear it, on a phone, with the key in Seed Vault.

Reversed by: nothing found so far. If someone ships a recorded on-chain refusal on mobile before
October 8, 2026 ([Solana Mobile announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon)), the entry needs a different wedge.

## 2026-09-20: the offer feed is Nordic day-ahead electricity spot

The demo pays a bill repriced by that public index, on devnet, in our token, to a terminal we run. It buys no electricity. The bill is paid when the repriced amount is inside the rule. Verified 2026-09-20: the
endpoint returns HTTP 200 with no authentication at 15-minute resolution.

A DEX price feed was rejected. A bot buying a dip is a trading app, which is the crowded category
the brief contrasts with, and a token purchase is a trade rather than a purchase, so a refusal
loses its force.

The price is real and independently verifiable. The counterparty is a terminal we run, because no
charge point operator accepts this mint, and the README and video say so. The property this buys is
that refusals are caused by the real price crossing the ceiling rather than by staging.

Reversed by: the endpoint becoming unavailable, in which case any public feed with genuinely moving
prices for a recognisable purchase substitutes.

## 2026-09-20: the program is frozen

It compiles, it enforces four limits on chain, it has nine reason codes and a recorded refusal.
Competing with the prior art on policy surface is a losing race and it is not the wedge. One
addition only: the refusal states the override that would have cleared it, which none of the designs in the README table does.

Every remaining day goes to the watcher, the feed and the phone. Innovation is banked; UX and
presentation are half the score and have not started.

Reversed by: a defect found in the security pass.

## 2026-09-20: the energy feed stays, and the Seeker answer is mandate templates

Owner review asked for the demo scenario to become something a Seeker owner would actually set
(airdrop bot budget, mint sniper ceiling, quest-farm spend), described as a scenario-line change
with the same code. Taken literally that is not possible, and the reason matters.

The scenario and the feed are coupled. The watcher submits a bill repriced by a real electricity price. It buys no electricity. Relabelling those same rows as an airdrop bot budget would make the numbers
fiction, which breaks the honest-data rule this repository keeps.

The obvious substitution does not work either. A Solana-native feed with genuinely moving prices
is priority fees, but a priority fee is not a transfer to a payee, so it cannot pass through a
mandate that enforces a merchant allowlist. Every other Seeker-native purchase is either a fixed
price (a mint), a trade (a swap, which was already rejected), or metered API usage we would have to
simulate anyway.

So, decided:

1. **The feed stays** Nordic day-ahead electricity spot. It is the only candidate with real moving
   prices for a real purchase, and it is what makes refusals happen because the world moved.
2. **The watcher is written against a `PriceFeed` interface** with the energy source as the first
   implementation, so swapping costs an afternoon rather than a rewrite if this is revisited.
3. **The Seeker answer is delivered as mandate templates in the app, not as fabricated history.**
   The mandate creation screen offers shapes a Seeker owner recognises: cap a mint bot, cap a
   quest-farm spend, cap an agent's weekly outgoings. Offering a template is honest; it claims no
   data. Only the energy mandate has real history behind it, and only that one appears in the
   ledger.

This gives the Tuesday answer in the surface a judge actually looks at, at the cost of one screen
rather than an integration, and without a single invented row.

Reversed by: the owner preferring a different feed, in which case the interface makes it cheap; or
finding a Seeker-native purchase with a real public moving price and a real payee, which would be
strictly better and should replace the energy source outright.

## 2026-09-20: freeze lifted for F1, F2 and F4, then frozen again

The program freeze names "a defect found in the security pass" as its reversal condition. That pass
filed three MEDIUM defects: revoke unreachable after EXPIRED or EXHAUSTED (#33), `grant_override`
accepting a nonce that can never pay (#34), and a frozen token account declining with no ledger
entry (#35).

The freeze was lifted for exactly those three fixes, and nothing else:

- `revoke_mandate` runs on any status except already REVOKED, so the owner can always drop the SPL
  delegation in one signature.
- `grant_override` rejects `nonce <= last_nonce` with `NonceAlreadySettled`.
- `evaluate` checks source and destination freeze state before the transfer and records
  `REASON_ACCOUNT_FROZEN` (10) as a refusal. Existing reason codes are unchanged.

No new instructions, no new policy fields, no decline turned into an error. Reason codes are 0 through 10. The program is frozen
again after this by decision. Devnet stays upgradeable under the deployer key.

Reversed by: a further defect found in a later security pass, same condition as the original freeze.

## 2026-09-20: the decision record is JSON anyone can re-read from the chain

The off-phone beat is a documented schema (`docs/DECISION_RECORD.md`) plus two node tools:
`tools/export.ts` writes one decision, `tools/verify.ts` re-fetches the cluster and prints
CONFIRMED or REJECTED. No signing ceremony, no hosted verifier, no W3C VC envelope. The
transaction signature is not stored in the ledger account; export recovers it from cluster
history. The program is unchanged: fields the chain does not hold are listed in the doc
instead of being added to the program.

Reversed by: a third party that will not talk to an RPC, in which case a signed envelope
becomes the product and this export stays the source it wraps.

## 2026-09-24: each new rule has its own token account

A rule opened in the app derives a token account from the owner with the seed `veto-rule-<mandate id>` (`createAccountWithSeed`). One owner signature creates that account, moves the cap into it from the owner's associated token account, and opens the mandate with that account as the source. The mandate PDA is the SPL delegate for the cap. Close rule, on a rule created this way, returns the remaining balance to the owner and closes the token account, so the rent comes back with the mandate rent and the ledger rent. Revoke clears the delegate on that rule's source only. A rule whose source is still the associated token account still closes, and that token account stays.

The program still does not escrow into a vault. `open_mandate` approves the mandate as delegate of whatever source it is given. The 2026-09-20 custody entry stands: the funds are not in a program vault. This entry is where the budget sits for a rule opened in the app.

Reversed by: the delegate path proving unworkable, same condition as the custody entry.

## 2026-09-24: first-run introduction, Connect your agent, the SDK, the devnet journey, export after close

A fresh install shows four introduction cards before Connect. Skip or Connect on the last card stores `veto.onboarding.seen`. Help can show the introduction again. With no rule, Overview shows Open your first rule.

On an active rule the rule screen shows Connect your agent, with Copy all and a QR of the same JSON. A rule that is not active shows neither control.

`sdk/` is `@veto-hq/agent-sdk`. The package is published from this checkout by the maintainer. `loadAgentConfig` reads the block. `VetoAgent.fromConfig` pins the program to the bundled id unless the caller passes another id in code, checks `mintDecimals` on the mint account, checks `cluster` against the endpoint's genesis hash, and uses a passed `Connection` instead of `rpcUrl`. The example is `sdk/examples/pay-once.ts`.

`make e2e-devnet` runs `app/e2e/devnetJourney.test.ts` and writes `app/e2e/last-run.md`. It needs the gitignored deployer key.

After `close_mandate` removes the account, `tools/export.ts` still writes the decision. Limits come from the opening transaction that covered the signature.

Reversed by: nothing in this entry. These are records of what shipped.

## 2026-09-24: reversal conditions taken out of PROBLEM.md

Three outcomes would show the claim does not hold.

- If the person using this on a Tuesday is still a hypothetical, the consumer framing is wrong and the product is developer infrastructure with an app in front of it.
- If the export lands as a curiosity, the record is not the wedge and what remains is mobile UX on limits.
- If someone else ships a recorded on-chain refusal on mobile before October 8, 2026 ([Solana Mobile announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon)), that wedge is gone and the entry needs a different one.

## 2026-09-25: Backglass, grades, and Hold

The phone is the Backglass app. A fresh install walks five stages: Learn, Connect wallet, Add your agent, Approve the rule, and Live. The four tabs are Overview, Rules, Agents, and Decisions. Overview is the home screen. Agents grades each agent with the rules in `app/lib/grade.ts`. Plaques, a seven-day week in review, a track record card, renewal in the last seven days, and a quiet note that is off until turned on are in the app. Two Android widgets show what an agent can still spend. `authorize` identifies the app as `https://veto-hq.github.io`.

The agent package is `@veto-hq/agent-sdk`. Install it with `npm install @veto-hq/agent-sdk`. Published to npm at 0.1.0 on 2026-09-27. The package is published from this checkout by the maintainer.

Hold is a vault in the same program (`programs/veto/src/hold.rs`). It does not replace the spending rule. A rule is still a delegate, not an escrow. The SDK exports `HoldVault`. The watcher alerts on `VETO_HOLD_VAULTS`. The app has the Hold screens. Hold is merged and tested, and live on devnet as of the 2026-09-25 upgrade recorded in [DEVNET.md](../DEVNET.md). A device check with a real vault follows.

The 2026-09-24 introduction entry described four cards before Connect. Those steps are now the Learn stage. The 2026-09-24 custody entry still describes a spending rule.

Reversed by: nothing in this entry. It records what shipped. Removing Hold would delete the vault path and leave the spending rule as it was.
