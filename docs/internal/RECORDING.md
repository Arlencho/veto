# Recording notes

Record on **2026-10-06**; reserve **2026-10-07** for another take. The authoritative timed shot list is [VIDEO.md](../VIDEO.md). Full cut: 03:00 maximum, including the last frame. Capture the refusals first, twice.

## Devices and continuity

- Install the release APK on both Seekers. Rehearse wallet connection, QR scan, hold gesture and signature on real hardware. Source code and unit tests do not establish a device pass.
- Phone one is the owner. Phone two has a distinct guardian wallet. Keep both visibly in frame for Hold. Use a separate first-run take for the eight-second Protect cut-in.
- Use devnet throughout, with Circle devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. These tokens have no value. Keep fee SOL available for the agent and both signing wallets.
- Capture actual amounts, rule addresses and transaction signatures with each take. Reopen every explorer link on another machine and confirm its devnet transaction matches the phone. Do not invent a future signature or reuse the old 16.659625 refusal.
- Capture the deck's refusal, explorer and Decisions stills from the USDC take. The old September 25 custom-token stills do not illustrate this rule.

## USDC spending rule

Use `UsRHyKtm41XMpQUcFGevYKgdWJEHQUf44QDCxLjEGWh`: 0.50 USDC per payment, 20 USDC total cap, opened for 40 days. The recorded expiry is Unix `1793802976`; the phone shows an expiry date. Confirm the account is still active and delegated, funded, unexpired and has sufficient remaining cap on shoot day.

The checked configuration in [GCP_SETUP.md](../GCP_SETUP.md) records cap `20000000`, maximum `500000`, source `8eyjxUJNHuuqYrbqoFxacu4Qx54ystkGirewxigfJtLm`, agent `6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w`, and payee `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG`. Re-read on shoot day; this is not a claim about October's live balances.

Find one real Paid row within 0.50 USDC and one Refused row above it with reason 5 in Decisions on the Seeker. Read the actual amounts from those rows. Match the explorer signatures and token balance changes, allowing for transaction fees. The bill is repriced by a public index and pays our counterparty; it buys no electricity. Preserve both rows before the 32-entry ring wraps. Do not promise a fixed count of paid or refused rows on recording day.

## Trade gate: devnet upgrade by 2026-10-05

Keep 00:45 to 01:35 only after the trade program, SDK, app and rehearsal script agree on the deployed version. The baseline `main` reviewed here has no trade instruction. The intended reason mapping is present in `programs/veto/src/trade_state.rs` on `origin/fix/trade-rule-review-notes`: 11 destination, 12 pool, 13 daily allowance, 14 price floor. Inspect the merged code again; a branch and an existing pool do not establish deployment.

- Pin pool `DTFPL7GmcFN9yc6Yv2FZrq158gRhM8JG1v6svgcNNjxL`. Its vaults and exchange program are in [DEVNET.md](../DEVNET.md). Input is wrapped SOL; output is devnet USDC to the owner's pinned account. Our pool's reserves set this demo rate.
- Rehearse one successful trade. Prepare four separate direct program submissions from a script with only the agent key, with no owner or guardian signer and no private-key display. The script must submit beyond client-side validation. Confirm the submitted signer set during rehearsal.
- Attempt an agent-owned output account for reason 11, then an agent-owned alternate pool for reason 12. Keep nonce, amounts and other accounts otherwise valid.
- For reason 13, exceed the current 24-hour input allowance while staying within the per-trade maximum and total cap. Fund enough input and avoid a day-window rollover during the take.
- For reason 14, arrange a quote below the rule's positive floor while passing earlier checks, including the daily allowance. Use a separately prepared rule if necessary and make that rule change visible. The agent does not change the owner's floor. A swap slippage error does not prove reason 14.
- All four must confirm as recorded refusals, with no swap movement, readable reasons in Decisions on the Seeker, and matching public explorer logs. Capture each pair for its ten-second slot. Missing app decoding, logs, script or any outcome fails the whole trade gate.

If the upgrade or rehearsal misses the gate, remove the entire 50 seconds. Do not replace it with a local validator, mockup, terminal-only refusal or a future-feature card.

## Owner-direct gate: npm publish

Keep 01:35 to 02:10 only when `npx @veto-hq/veto connect` works from a clean directory on a machine without a local package link. The checked `cli/package.json` is private and depends on `file:../sdk`; publishing both packages with a registry-resolvable dependency is required before filming this command. A successful local build is insufficient.

Use a fresh agent identity so discovery cannot select an earlier active rule. The connect command asks for missing rule fields before it prints the QR. Enter the intended payee, `500000` maximum, `20000000` cap, `40` days and a short purpose. Devnet defaults to USDC. Do not pass an existing rule to connect for this take: that path skips the request QR.

Scan on the Seeker, review, hold **Hold to approve rule**, and finish the wallet signature. Configure an MCP-capable assistant to use the CLI's MCP server. Call `veto_pay` with `{"amount":"250000"}`, then `{"amount":"500001"}` on this newly funded rule. Amount strings are base units. Require a paid result and a reason-5 refused result, with signatures and corresponding Seeker Decisions rows. The agent key stays on the laptop; the owner approves the rule on the phone.

Frame the tool calls and results without an assistant vendor name or logo. If the published install or complete flow fails, cut all 35 seconds. The spending and Hold beats remain independent of npm, and this spending connection remains independent of the trade upgrade.

## Protect and Hold rehearsal

Use **Next: protect your money** from first run, then **Protect the rest of your money** and **Set up with my second Seeker**. This is an eight-second cut-in; complete actual vault setup before the Hold take.

Configure a funded vault for 1 day, an everyday limit below the proposed withdrawal, a safe address and the second Seeker's distinct guardian key. Connect the guardian wallet on the second phone, confirm it discovers the vault, enable notification permissions and rehearse the alert in the actual foreground or background state used for filming. Do not infer delivery from the owner phone's guardian indicator.

Request a big withdrawal to a new address. Confirm the pending amount, destination and one-day release time on chain. Capture the second Seeker receiving the notification and opening the matching withdrawal in **You are the guardian**. Press and hold **Stop this withdrawal**, complete the guardian wallet signature, then capture **Confirmed on the blockchain** and verify that the withdrawal is stopped and the funds remain. The control requires a hold, not a quick tap. Only funds inside Hold's vault have this protection.

## Code checks behind the copy

| Claim | Source in this checkout |
|---|---|
| Rule fields: Total cap, Per payment, max, Expires, Payee | [Rule detail](../../app/app/rule/[address].tsx) |
| Hold to approve rule | [ApprovalScreen.tsx](../../app/components/ApprovalScreen.tsx) |
| Next: protect your money | [RuleLiveScreen.tsx](../../app/components/firstrun/RuleLiveScreen.tsx) and [AgentSetupScreen.tsx](../../app/components/firstrun/AgentSetupScreen.tsx) |
| Protect copy and second Seeker choice | [ProtectScreen.tsx](../../app/components/firstrun/ProtectScreen.tsx) |
| Guardian title, Stop and confirmation | [GuardScreen.tsx](../../app/components/hold/GuardScreen.tsx) |
| Stop requires a hold gesture | [HoldSign in chrome.tsx](../../app/components/hold/chrome.tsx) |
| Big or new withdrawals wait; 1-day choice | [SendScreen.tsx](../../app/components/hold/SendScreen.tsx) and [RulesScreen.tsx](../../app/components/hold/RulesScreen.tsx) |
| Connect prompts, QR, approval discovery | [commands.ts](../../cli/src/commands.ts) |
| veto_pay uses base units and returns a refusal normally | [mcp.ts](../../cli/src/mcp.ts) |
| Spending reason 5 and ring capacity 32 | [state.rs](../../programs/veto/src/state.rs) |

Run the relevant documentation checks after edits. Before the final export, check all links, gesture labels, actual transaction pairs, audio and caption text, and the duration. No em dashes, assistant vendor names or release-status overlays. If either optional gate fails, use the cut timings in VIDEO.md and keep the final USDC refusal frame.
