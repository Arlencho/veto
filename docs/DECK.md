# Deck

Slide by slide for the submission. Ten slides. The organizer's page names presentation and demo as one of the four things judges look at. It does not publish a percentage.

---

## 1. The moment

> **The agent tried to pay. It didn't.**

One screenshot, full bleed: the refusal on the phone, opened from Decisions. It says "No money
moved." Then: "Your agent asked to pay 16.659625. Your rule allows 10 per payment, so the
program refused." The fact labeled Needed to allow it is 16.659625. That is the 12:00 Swedish
refusal on 2026-09-25, mandate `3hgrSbPX2VTrfnVekoL2qi2qDWNGBhWP3QgADAWz6X6N`, signature
`2DAXYtVCkGPG8RdbYWJcJvZHk4F7tvkJCnqExuyg8qUrdK53DwNUBiCD1MBx3LrzHvd8YXVF7RXr5tz4EujfHo5B`.

Never styled as an error. That screen, the explorer log on slide 6, and the verify beat in the
video are the same recorded decision. Not a second rule.

No logo slide, no team slide, no agenda. The first slide is the refusal card.

---

## 2. The two bad options

> Software already spends from wallets people own. Two options: sign every transaction, or hand
> an agent a blank check.

Left: a wall of approval prompts. Right: a drained wallet. Thirty seconds.

---

## 3. What a rule is

Four limits, on the rule:

- **cap** the total it may ever spend
- **per-payment maximum** the largest single payment
- **expiry** after which nothing moves
- **payee** the only counterparty

One human, several agents, one rule each. A ruleset is written once and reused on the next agent.

> The key never leaves Seed Vault. A rule opened in the app keeps its budget in its own token
> account, and the mandate is the delegate on that account. The agent gets authority, not
> ownership.

---

## 4. Prior art, named

These are the limits that already exist.

| | What it does |
|---|---|
| Squads v4 | Audited spending limits, formal verification underway |
| SPL delegate | A cap on what a delegate may pull |
| LazorKit | Session keys with on-chain roles and limits |
| AP2 | Signed mandates carrying limits and validity |

> Capped agent spending on Solana is not new. An infrastructure vendor publishes a tutorial on it.

---

## 5. What every one of them has in common

> The difference is what is left behind. Elsewhere a blocked overspend is a failed
> transaction: logs and an error code, but nothing in program state. Here the decline is a
> successful transaction that records a structured reason and moves no payment tokens.

Here the transfer is not executed. The decline is recorded.

---

## 6. The log line

Screenshot of an explorer showing a confirmed transaction, with the program log visible:

```
VETO REFUSED reason=5 (over per-payment maximum) amount=16659625
per_tx_max=10000000 remaining=292000000 override_to_clear=16659625
```

That line is the program log on the 12:00 Swedish refusal on slide 1. Amount 16.659625,
per-payment maximum 10, remaining 292 of a 300 cap, override 16.659625. The 12.5 kWh bill at
1.33277 SEK/kWh is that amount. Same decision as slide 1.

> The transaction succeeded at deciding no. The payment did not happen. The balance is unchanged,
> and neither party can edit the confirmed transaction.
>
> The last field is the suggested one-time allowance for this charge. Other checks can still stop the payment.

---

## 7. Why Solana Mobile

> Seed Vault is built so a human approves every signature. That is the right default, and it is
> exactly why unattended agent spend has nowhere to live on this platform.
>
> A rule is the Seed Vault-shaped answer: the key never leaves the vault, and the agent gets
> bounded authority beside it rather than a copy of the key.

---

## 8. The diary on the quoted rule

Screenshot: Decisions for mandate `3hgrSbPX2VTrfnVekoL2qi2qDWNGBhWP3QgADAWz6X6N`. Before 18:00 Swedish time on 2026-09-25 the chain shows one payment of 8 and four refusals, through the 12:00 refusal at 2026-09-25 10:00:25 UTC. It paid when the amount was 8, under the 10 ceiling.

> The agent pays a bill repriced by a public index, on devnet, in our token, to our counterparty.
> It buys no electricity. On this rule, before that hour, one payment under the ceiling is on
> the chain and four charges over it were refused. From 18:00 Swedish time on 2026-09-25 the
> demo is set so the watcher charges 6 kWh per slot, which is how later rows are meant to mix
> paid and refused. Those later rows are not on this slide. The price is the only input we do
> not control, and you can check it at the same URL.
>
> When the rule allows the bill, the program executes an SPL transfer of that token to an account
> we created.

The index is the Nordic day-ahead spot. The mint and the counterparty account are created by
[scripts/devnet-setup.sh](../scripts/devnet-setup.sh). [tools/produce.ts](../tools/produce.ts)
mints further supply of that same mint. Addresses are in [DEVNET.md](DEVNET.md).

---

## 9. The exhaust

> A worst case fixed in advance by the rule. A complete record of every payment made against it.
> Every refusal recorded by a charge transaction that succeeds.
>
> AP2 provides signed authorization mandates; Veto adds a structured refusal record on chain.

**Thirty seconds.**

---

## 10. Scope

> One rule type. A delegate on a token account the owner controls. Several rules, one agent each.
> A ruleset written once and applied to the next agent. One pay path. One refusal path with a
> reason and an override hint. Connect your agent, Copy all and a QR, on an active rule. An export
> anyone can re-read from the chain. The quoted refusal is the 12:00 Swedish slot on 2026-09-25.

The phone now also has the Backglass first run (Learn, Connect wallet, Add your agent, Approve the rule, Live), four tabs (Overview, Rules, Agents, Decisions), grades, plaques, a week in review, a track record card, renewal, a quiet note, and two home screen widgets. The agent package is `@veto-hq/agent-sdk`, version 0.1.1 on npm. Authorize identifies the app as `https://veto-hq.github.io`. Hold is a separate vault in the same program, merged and tested, and live on devnet. The app screens exist. A completed device check of Hold with a real vault is not recorded in this repository yet. The slides above are still the refusal on the quoted rule.

---

Words the entry does not use: [internal/WORDS.md](internal/WORDS.md). Screenshot notes: [internal/RECORDING.md](internal/RECORDING.md).
