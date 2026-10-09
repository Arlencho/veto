# Words the entry does not use

Style sheet for the pitch, the deck, and the video. Product claims live in those files. This list is the vocabulary they avoid.

- **"Hard fail", "revert", "fail closed".** Those names describe a rolled-back transaction. The line to use: it declines before money moves, and the decline is recorded.
- **"First ever", "nobody has".** Say what is in front of you: the other designs are infrastructure, and this one is on a phone.
- **"Capped budgets" or "spending limits" as the headline.** Capped agent spending is not new. An infrastructure vendor publishes a tutorial on it. The headline is the recorded refusal.
- **Anything that implies the spend still happens.** "We make it legible rather than impossible" reads as if the money moves and the program only writes it down. The money does not move. The decline is recorded.
- **"Credential".** That word means a W3C verifiable credential. Say "export" or "on-chain decision record".
- **"Proof of restraint" on its own.** A one million ceiling on a five dollar charge is a record of a five dollar charge. Pair the record with the rule agreed in advance. See [PROBLEM.md](../PROBLEM.md).
- **"Every attempt".** The complete record is every payment, because a spend has to pass the program to happen, and every refusal recorded by a charge transaction that succeeds.
- **"A week" for the quoted rule.** The video and the deck quote mandate `3hgrSbPX2VTrfnVekoL2qi2qDWNGBhWP3QgADAWz6X6N`. The quoted refusal is the 12:00 Swedish slot on 2026-09-25. Before 18:00 Swedish time that day, the signatures run from the open at 2026-09-24 22:48:44 UTC through that refusal at 2026-09-25 10:00:25 UTC. From 18:00 the demo is set so the watcher charges 6 kWh per slot, which is how later rows are meant to mix paid and refused. Do not describe those later rows as already read, and do not call the span a week.
- **"Buys electricity" or "pays for charging" as if power were delivered.** The demo pays a bill repriced by a public index, on devnet, in our token, to our counterparty. It buys no electricity.
