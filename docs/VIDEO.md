# The three-minute video

This is the current shot list. Maximum running time is 03:00 including the last frame. Judges read the transcript, so every spoken line below is written to read well as text on its own. Say the lines as written.

All transactions are on Solana devnet. USDC means Circle's devnet test token, with no value. The charging agent pays our own test payee for a bill priced from a public electricity index. It buys no electricity.

## The story on chain

One rule carries the whole story. Every row below is a confirmed devnet transaction; read it yourself before the take with `getTransaction` on `https://api.devnet.solana.com`.

| Role | Address |
|---|---|
| Charging agent | `8hegVoB83hZaLMacF8L5zfjpfo33ZZwBYyeNzxSZHC8i` |
| Rule | `EWz9bHJVySsdqMSsLp7nsp7T4FheUkdE6pY8MgomYa4v` |
| Owner | `GtA2Vxhomfm2WGaBcvz5oCBrqkAecKHMAL3UTn4HVFzq` |
| Payee | `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG` |

The rule allows 5 USDC per payment and 20 USDC in total. Its purpose reads "Charging top-ups at the SE3 spot rate".

| Step (2026-09-29, UTC) | What happened | Transaction |
|---|---|---|
| 11:18:13 | Owner opens the rule: 20 total, 5 per payment | [3M3QoWgc](https://explorer.solana.com/tx/3M3QoWgc2qWuit32P2tsrFk48jPW5NY4J6T7Zpt5vVw6bxqTx1iLBTX1gTSe7TNEHCT2Xqqf3FTSTP5Bk5ym3J5s?cluster=devnet) |
| 11:18:40 | Agent asks for 4.20, paid. 15.80 left | [deFpkv1m](https://explorer.solana.com/tx/deFpkv1m5jJxyc1725Tsv4KeTUaatnyPrWgc9M3m6LaCWLjSDpc5ddBeVLN3DwVecQfGDFra5g67tuPvRCK2RqR?cluster=devnet) |
| 11:19:03 | Agent asks for 12.90, refused as over the per-payment limit. No tokens move | [26xUMWrT](https://explorer.solana.com/tx/26xUMWrTZhNekv3WMczdeQHd1omrG6MyWrKGbbKfzDi3nRbtmdbQSxCiffu9LtiqS3UTBq2we2Vqmwbfg4pVSXjC?cluster=devnet) |
| 11:23:53 | Owner allows that one payment of 12.90 | [2UctcWfS](https://explorer.solana.com/tx/2UctcWfSsaHCL5WQbPetUGCUdks5LU7nCnPQga7VtyQXHUpGwDTW87cjhc392EUrrsV6tcT5bEGY2cYGhULfecL3?cluster=devnet) |
| 11:24:21 | Agent retries 12.90, paid. 2.90 of 20 left | [261ED3JC](https://explorer.solana.com/tx/261ED3JCVMXWxFuRxckJ5ZkxHu9RLLRdNFDxJSdkENw76cmb8t6oGRwF9gWDZQG7J1xwv6uqBFikvLxe1AyVFwQ9?cluster=devnet) |

The refusal's program log is `VETO REFUSED reason=5 (over per-payment maximum) amount=12900000 per_tx_max=5000000 remaining=15800000 override_to_clear=12900000`. Show that log on screen; do not read it aloud.

## Shot list

**00:00 to 00:10. Open.**

The Seeker in hand, Veto on **Overview**.

Voice: *"This is Veto. Instead of handing my AI agent my wallet, I give it a spending rule."*

**00:10 to 00:32. The rule.**

Open the rule from **Rules**. Show 5 USDC per payment, 20 USDC in total, the payee and the purpose. Cut to the approval: **Press and hold to approve rule**, then the Seed Vault sheet.

Voice: *"My charging agent can pay up to 5 USDC at a time, and 20 in total, to one payee. I approved that once, in Seed Vault. The agent pays with its own key. It never gets mine."*

**00:32 to 00:45. A payment inside the rule.**

Open the paid 4.20 row in **Decisions**.

Voice: *"It asked for 4.20. That fits the rule, so it was paid, and I did not have to do anything."*

**00:45 to 01:10. The refusal.**

Open the refused 12.90 row in **Decisions** and show its sentence. Cut to the same transaction in the public explorer with `cluster=devnet`: the transaction succeeded, the token balances are unchanged, and the log line names the reason.

Voice: *"Then it asked for 12.90. That is more than my limit of 5. Veto said no, and wrote down why, on the blockchain. Not one token moved. Anyone can look this up."*

**01:10 to 01:35. Allow it once.**

On the refused decision, hold **Press and hold to allow this one payment** (the button names the amount), then sign in Seed Vault. Show the agent's retry arriving as a paid row.

Voice: *"Maybe that charge was fine. I can allow this one payment, and only this one. I sign in Seed Vault, the agent tries again, and it is paid. My limit is still 5."*

**01:35 to 01:45. What is left.**

Show the rule with 2.90 of 20 USDC left, and the **Stop the rule** control.

Voice: *"2.90 of my 20 is left. When it runs out, the agent cannot pay. And I can stop the rule from my phone at any time."*

**01:45 to 02:10. Any assistant can use it.**

On a laptop, an assistant connected to the Veto command line tool as an MCP server (`npx -y @veto-hq/veto mcp`) calls `veto_pay` once inside its rule and once over the limit. Show both results, then both rows in **Decisions** on the phone. Use the real amounts from the take. Do not show an assistant vendor name, logo, title bar or configuration filename that identifies one.

Voice: *"Any assistant that supports MCP can use a rule the same way. It asks to pay. This one is paid. This one is over the limit, so it is refused, and that is recorded too."*

**02:10 to 02:40. Try it yourself.**

Show the Try page, <https://veto-hq.github.io/try/>, and the latest release APK. On the phone, tap **Send two test requests** and show one paid and one refused outcome. Then show a rule named for our demo agent and a request from it.

Voice: *"You can try this in five minutes. Install the app from our Try page. It runs on devnet, with test money. The built-in test agent sends one payment inside your rule and one just over it. Or give our demo agent a rule, and it will charge you every six hours."*

**02:40 to 03:00. Close.**

Return to the refused 12.90 row.

Voice: *"Agents are going to spend money for us. Our goal is that every agent pays inside a rule its owner set, and every no leaves a record anyone can check."*

## Rules for the edit

- A refusal is the product working. No red error flash or error sound.
- Use real device footage and the real matching transactions above. Do not substitute design mockups or another rule's history.
- The rule's on-chain ledger keeps the latest 32 decisions. The rule has 2.90 USDC left, so at most one more payment of up to 2.90 can be paid; refusals still add rows. Capture the rows before any are overwritten.
- No captions or narration with reason codes, nonces, base units or other internal terms. The log line on screen is enough.
- No AI vendor names, em or en dashes, release-status overlays or unsupported claims in titles, narration or captions.
- Keep devnet visible. No background music over explorer logs. Finish within three minutes.
