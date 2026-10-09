# The three-minute video

This is the current shot list. Maximum running time is 03:00 including the last frame. Judges read the transcript, so every spoken line below is written to read well as text on its own. Say the lines as written.

All transactions are on Solana devnet. USDC means Circle's devnet test token, with no value. The charging agent pays our own test payee for a bill priced from a public electricity index. It buys no electricity.

## Submitted take

Submitted take, recorded 2026-10-09 on a Seeker with release build 29: rule `r4D5pvcVsGhmBwwd3bSJfnXP1m5Qu1dDTvEpn6J7PWV`, agent `G1UKSxWvNRNep6Ec6yD67iKEkmDNRZP3pPcHDHa6QMDU`, owner `GtA2Vxhomfm2WGaBcvz5oCBrqkAecKHMAL3UTn4HVFzq`, 5 USDC per payment, 20 total, until 18 Nov 2026.

The table lists every transaction on the rule, read with getSignaturesForAddress and getTransaction on https://api.devnet.solana.com on 2026-10-09. Each is finalized with no error.

| Step (2026-10-09, UTC) | Signed by | What happened | Transaction |
|---|---|---|---|
| 19:52:47 | owner | Owner opens the rule: 20 total, 5 per payment | [3zhuZEKM](https://explorer.solana.com/tx/3zhuZEKMMoq4Q2j6iYYSULr2ZL6rJWtDg5pPecZxkP9Si2rQgDSicuh9JWemAzgqrXXh2ffg4VmaFCv2R9LGEjB1?cluster=devnet) |
| 19:53:50 | agent | Agent asks for 4.20, paid. 15.80 left | [4uaBTgZ4](https://explorer.solana.com/tx/4uaBTgZ4z95HXjsD8EB5wFhdMDRyxXKZ1eY5mMHFp5y2ibmxiNJUzWQitp411YdFEmsUkPKrZeLR1oUE8WBjU39T?cluster=devnet) |
| 19:54:13 | agent | Agent asks for 12.90, refused as over the per-payment limit (reason 5). No USDC moves | [4sAUJSy5](https://explorer.solana.com/tx/4sAUJSy5wyfwQJ9PYgeC58uwBxx5S9TAZgnKjfCQmYoaUtheBVWN3kguSMa1A34Kf6hJ4MwRtp6PDnhcb9KEn7Ek?cluster=devnet) |
| 19:58:55 | owner | Owner allows that one payment of 12.90 | [48HSvVEi](https://explorer.solana.com/tx/48HSvVEiq43D2QpHMrW69T9mGq8U4bo3vmn7fat5GqQA9xph1ecr8FNArYDj5Ap1bthfhDZUq4PqhZSP9rDns4Aj?cluster=devnet) |
| 19:59:39 | agent | Agent retries 12.90, paid after the owner allowed it once. 2.90 of 20 left | [4m3PHGqp](https://explorer.solana.com/tx/4m3PHGqp9yjpiPkjUuhhg6LTRkGffVWCz34vu1KRiVCP2CPTGUQV24RrraKBUuTDTyoVU5rnhkUbKMBuZA1FvPst?cluster=devnet) |

The refusal's program log is `VETO REFUSED reason=5 (over per-payment maximum) amount=12900000 per_tx_max=5000000 remaining=15800000 override_to_clear=12900000`. The open logs `expires_at=1795031382`, which is 2026-11-18 19:49:42 UTC.

## Earlier recorded run

The shot list below was written against this 2026-09-29 run. The amounts and limits are the same as in the submitted take.

One rule carries the opening payment, refusal and owner-approved retry. The later MCP, phone test-agent and ongoing demo-agent examples use separate rules for their respective agent keys. Before recording, verify each transaction below with getTransaction on https://api.devnet.solana.com and confirm that the corresponding history is visible on the phone.

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
| 11:19:03 | Agent asks for 12.90, refused as over the per-payment limit. No USDC moves | [26xUMWrT](https://explorer.solana.com/tx/26xUMWrTZhNekv3WMczdeQHd1omrG6MyWrKGbbKfzDi3nRbtmdbQSxCiffu9LtiqS3UTBq2we2Vqmwbfg4pVSXjC?cluster=devnet) |
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

Voice: *"Then it asked for 12.90. That is more than my limit of 5. Veto said no, and wrote down why, on the blockchain. No USDC moved. The agent still paid a transaction fee. Anyone can look this up."*

**01:10 to 01:35. Allow it once.**

On the refused decision, hold **Press and hold to allow this one payment** (the button names the amount), then sign in Seed Vault. Show the agent's retry arriving as a paid row.

Voice: *"Maybe that charge was fine. I can allow this one payment, and only this one. I sign in Seed Vault, the agent tries again, and it is paid. My limit is still 5."*

**01:35 to 01:45. What is left.**

Show the rule with 2.90 of 20 USDC left, and the **Stop the rule** control.

Voice: *"2.90 of my 20 is left. When it runs out, the agent cannot pay. And I can stop the rule from my phone at any time."*

**01:45 to 02:10. Any assistant can use it.**

Before recording, pair the laptop's agent with a separate funded devnet payment rule using the [CLI connection guide](../cli/README.md). Connect an assistant to that configured agent through the Veto MCP server (`npx -y @veto-hq/veto mcp`). Show the separate rule's name, then call `veto_pay` once inside its limits and once over its per-payment limit. Show both results and the matching rows in **Decisions** on the phone. Use the real amounts from the take. Do not show an assistant vendor name, logo, title bar or configuration filename that identifies one.

Voice: *"Any assistant that supports MCP can use a rule the same way. It asks to pay. This one is paid. This one is over the limit, so it is refused, and that is recorded too."*

**02:10 to 02:40. Try it yourself.**

Show the Try page, <https://veto-hq.github.io/try/>, and the latest release APK. On the phone, open a separate funded, active payment rule for the test agent stored on that phone. Tap **Send two test requests** and show the actual outcomes. Then show a separate rule for the ongoing demo agent configured according to [TESTERS.md](TESTERS.md), with a matching recorded request. Keep each rule's name visible so these examples cannot be mistaken for the opening rule's history.

Voice: *"You can try this in five minutes. Install the app from our Try page. It runs on devnet, with test money. The built-in test agent sends one payment inside your rule and one just over it. Or give our demo agent a rule, and it will send a request every six hours."*

**02:40 to 03:00. Close.**

Return to the refused 12.90 row.

Voice: *"Agents are going to spend money for us. Our goal is that every agent pays inside a rule its owner set, and every no leaves a record anyone can check."*

## Rules for the edit

- A refusal is the product working. No red error flash or error sound.
- For 00:00 to 01:45, use real device footage and the matching transactions above. Do not substitute design mockups or another rule's history there. Later shots use the real rules from the take, each identified by name.
- The rule's on-chain ledger keeps the latest 32 entries. Immediately after the retry above, 2.90 USDC remained, so payments totalling at most 2.90 more can be paid; refusals still add rows. Recheck the balance and history before recording.
- No captions or narration with reason codes, nonces, base units or other internal terms. The log line on screen is enough.
- No AI vendor names, em or en dashes, release-status overlays or unsupported claims in titles, narration or captions.
- Keep devnet visible. No background music over explorer logs. Finish within three minutes.
