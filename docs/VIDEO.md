# The three-minute video

Recording target: 2026-10-06. This is the intended release shot list, with recording gates below. Maximum running time is 03:00 including the last frame. Use real Seekers with the release APK. Keep both phones visible for the guardian beat. The tabs are Overview, Rules, Agents, and Decisions.

All transactions are on Solana devnet. USDC means Circle's devnet test token, with no value. The indexed bill pays our counterparty and buys no electricity. The trade uses our own pool; its rate is set by its reserves, not a claim about a market price.

## Recording gates, off screen only

| Beat | Dependency | Evidence required before keeping it |
|---|---|---|
| USDC paid and refused | Existing spending rule | Both rows visible on the Seeker, with matching public devnet transactions. |
| Trade, 00:45 to 01:35 | Trade rule devnet upgrade by **2026-10-05**, plus matching SDK, script and app | One trade and all four recorded refusals, with reasons 11, 12, 13 and 14 visible in Decisions and matching explorer logs. |
| Owner-direct, 01:35 to 02:10 | **npm publish** of `@veto-hq/veto` and its SDK dependency | A clean machine runs the published command, displays a QR, and completes approval plus both MCP payment outcomes. |
| Protect and Hold | Release APK, funded vault, configured guardian and notification permission | Both Seekers complete the alert, guardian signature and confirmed Stop on devnet. |

The trade beat does not depend on npm if its rehearsal script uses the matching checkout. The owner-direct spending beat does not depend on the trade upgrade. Cut either gated interval independently if its evidence is missing. Join the preceding shot directly to the next retained beat and shorten the runtime: 02:10 without trade, 02:25 without owner-direct, 01:35 without both. Do not add filler or captions such as pending, coming soon, upgrade required or unpublished. These gates are production notes, never on-screen status words. Real product outcomes such as Paid, Refused and Waiting remain visible.

At the baseline reviewed for this plan, `main` defines spending reasons 0 through 10 and has no trade instruction. The trade implementation reviewed on `origin/fix/trade-rule-review-notes` defines reasons 11 through 14 in `programs/veto/src/trade_state.rs`. That branch is evidence of intended behavior, not evidence of a devnet deployment. Recheck the merged release code before recording. `cli/package.json` is currently private and uses a local SDK dependency, so the npm shot is likewise conditional.

## Shot list

**00:00 to 00:12. Cold open on the USDC refusal.**

Open a real Refused row from Decisions on the Seeker for rule `UsRHyKtm41XMpQUcFGevYKgdWJEHQUf44QDCxLjEGWh`. Show its amount and reason. Choose a per-payment refusal, reason 5, above 0.50 USDC. Use the actual recorded amount, never the old 16.659625-over-10 example.

Voice: *"The agent asked to pay more than I allowed. The program refused, and recorded why. No payment moved."*

**00:12 to 00:30. The USDC rule.**

Open that same rule from Rules. Show **Total cap** 20 USDC, **Per payment, max** 0.50 USDC, **Expires**, and **Payee**. It was opened for 40 days. The screen shows an expiry date, not a promise of 40 days remaining. The payee is `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG`; the app truncates it.

Voice: *"I approved 20 USDC in total, at most half a USDC per payment, for 40 days, to this payee. The agent cannot widen those limits."*

**00:30 to 00:45. One paid, one refused.**

In Decisions on the Seeker, open one Paid row within the limit and return to the Refused row on this same USDC rule. Open the refusal's actual transaction in the public explorer with `cluster=devnet`. Show reason 5 and the matching amount. The payment must also be within the remaining cap, before expiry and otherwise valid. Refused payments still incur transaction fees.

Voice: *"Inside the rule, it paid without another approval. Over the payment limit, it recorded a refusal. This is devnet test USDC, paying our counterparty for a bill repriced by a public index. It buys no electricity."*

**00:45 to 01:35. Trade and four escape attempts.**

Recording dependency: trade upgrade gate above. This whole interval is removable.

Show the approved trade rule and one agent trade from SOL, represented by wrapped SOL in the token accounts, to USDC. The only approved pool is `DTFPL7GmcFN9yc6Yv2FZrq158gRhM8JG1v6svgcNNjxL`, documented in [DEVNET.md](DEVNET.md). Output goes to the owner's pinned USDC token account.

Then show a script with only the agent key submit four separate attempts. It must send transactions to the program, not merely trigger SDK validation. Keep other checks valid so each intended reason is reached. Show each refused row and its reason in Decisions on the Seeker, paired with the same transaction in the explorer. Budget roughly 10 seconds for the allowed trade and 10 seconds for each refusal.

| Attempt | Recorded reason | What the shot establishes |
|---|---|---|
| Redirect the swap output to the agent's own account | 11, destination not allowed | Output stays bound to the owner's approved account. |
| Route through the agent's own pool | 12, pool not allowed | The approved pool cannot be substituted. |
| Exceed the current 24-hour input allowance | 13, over daily limit | The agent cannot exceed the rule's daily total. |
| Trade when the quote is below the approved price floor | 14, below floor | The program refuses the below-floor quote. |

Voice: *"The agent can trade SOL to USDC through this one pool, back to my account. Now the same agent key tries its own destination, its own pool, more than the daily allowance, and a quote below my floor. Four refusals, recorded on chain. Each reason is here on the phone and in the explorer."*

Show confirmed program refusals and no swap balance movement for those attempts. A simulation failure, client rejection, failed transaction, or advisory memo cannot stand in for a recorded trade refusal. Use the deployed app's actual labels; the table describes the reasons, not invented screen copy.

**01:35 to 02:10. Owner-direct connection.**

Recording dependency: npm publish gate above. This whole interval is removable.

On a clean laptop run `npx @veto-hq/veto connect`. Complete its prompts for payee, maximum, cap, days and purpose, then show the generated QR. Use a fresh agent key and a separate spending rule for this shot. On devnet the default mint is USDC; the prompted amounts are base units. For 0.50 USDC per payment and 20 USDC total, enter `500000` and `20000000`, and enter `40` days.

The Seeker scans the QR, reviews the request and holds **Hold to approve rule**, then completes the wallet signature. Show the connected result. An MCP-capable assistant connected to the CLI's MCP server then calls `veto_pay` once inside the rule and once above the limit. For the freshly funded rule, use `{"amount":"250000"}` and `{"amount":"500001"}`: 0.25 USDC paid, 0.500001 USDC refused with reason 5. Show both results and matching Decisions rows. Do not show an assistant vendor name, logo, title bar or configuration filename identifying one.

Voice: *"Connect gives me a QR. I scan, review the rule, and hold to approve on the Seeker. My assistant can now ask to pay. This one pays. This one is refused by the same on-chain rule."*

**02:10 to 02:18. Protect cut-in.**

Use a separate first-run take so this survives cutting the owner-direct interval. Show **Next: protect your money**, then **Protect the rest of your money** and **Set up with my second Seeker**. Cut before the full setup; the next shot uses the vault prepared during rehearsal.

Voice: *"Onboarding also offers Hold, with my second Seeker as the guardian."*

**02:18 to 02:50. Hold and the guardian.**

Both Seekers in frame. Use a funded vault configured for **1 day**, with the second Seeker's distinct wallet as guardian. On the owner phone request a big withdrawal above the everyday limit to a new address. Show the waiting withdrawal and chain-clock countdown. Nothing is released by this request.

The second Seeker receives the real alert. Open it to **You are the guardian**, with the matching amount and destination. The guardian taps and holds **Stop this withdrawal**, completes its wallet signature, and shows **Confirmed on the blockchain**. Confirm that this withdrawal is stopped and the funds stay in the vault. A quick tap alone does not sign: this control uses the same hold gesture as approval.

Voice: *"A big withdrawal to a new address waits one day. My second Seeker gets the alert. I stop this withdrawal with its guardian key. The money stays in the vault."*

**02:50 to 03:00. Close.**

Return to the same USDC refusal as the cold open.

Voice: *"Give an agent a rule. Keep the limits on chain. When the answer is no, keep the reason too."*

## Rules for the edit

- A refusal is the product working. No red error flash or error sound.
- Use real device footage and real matching transaction logs. Do not substitute design mockups or another rule's history.
- Decisions is the history entry point. Overview only shows today's latest decisions. The on-chain ring holds 32 rows; rehearse and capture before needed rows fall out, and confirm any history source actually displays them.
- Keep agent advisory declines distinct: an advisory memo submits no charge and is not a program refusal.
- No assistant vendor names, em dashes, release-status overlays or unsupported claims in titles, narration or captions.
- Keep devnet visible. No background music over explorer logs. Finish within three minutes.

See [internal/RECORDING.md](internal/RECORDING.md) for the rehearsal checklist and source checks.
