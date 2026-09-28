# veto

The command you run next to your agent. Pairing does not need a developer, and it does not need a copied setup block.

## Install

Requires Node 22 or newer. After version 0.1.0 is published:

```bash
npm install --global @veto-hq/veto
```

Or run without a global install:

```bash
npx @veto-hq/veto connect
```

Version 0.1.0 was published to npm on 2026-09-27. See [the publishing guide](https://github.com/Arlencho/veto/blob/main/docs/PUBLISH.md) for maintainer release steps.

## One command, one scan, one hold

```bash
veto connect
```

That creates a key on your machine when you do not already have one. The file is `~/.veto/agent.json` and its mode is `0600`. The terminal prints the address and this sentence: "This key lives on your machine. Veto never holds it."

On devnet, a key that holds under 20 base fees of SOL gets a 1 SOL airdrop. The terminal says so. Mainnet does not.

The command then asks for anything it does not already have: who is paid, the most per payment, the total, how many days, and the purpose. Amounts you type are integer base units. On devnet the mint defaults to devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. On mainnet you give the mint.

It prints a `veto://rule-request` link and a QR of that link. Scan the QR with the Veto app and hold to approve.

The terminal waits until a rule that answers this request is on chain: it must name this key, the payee, mint and purpose you asked for, and stay within the total, the most per payment and the days you asked for. The owner may lower those on the phone, never raise them. Anyone who sees the agent address can open a rule for it, so the newest rule for the key is not trusted. The terminal prints the rule address and its owner; check that they match what your phone shows, because someone who copies the request from the QR could open a matching rule first. When more than one rule matches, it picks none and tells you to pass `--rule` with the address your phone shows. It then prints the terms in the token's name. Half a USDC, which is 500000 base units, reads as 0.50 USDC. It also prints one MCP config line. Your agent can pay with `veto pay <amount>`, or you paste that line into the agent's MCP config. The veto server in that line is:

```json
"veto": { "command": "npx", "args": ["-y", "@veto-hq/veto", "mcp"] }
```

The owner should remove any other tool that holds a funded key, because the companion cannot stop a second key. The server does not take a key. It refuses to start when `~/.veto/agent.json` is more open than mode 0600.

The rule and the RPC are saved in `~/.veto/config.json`. If the RPC refuses `getProgramAccounts` filters, pass `--rule` with the rule address. That checks the rule you name and skips the request.

## Pay

```bash
veto pay 500000
```

That is one charge, in base units, on the rule `veto connect` saved in `~/.veto/config.json`. `--rule <address>` charges that rule instead. A newer rule for the same key is never picked up on its own, because anyone can open one. A pending override is the nonce the SDK would use, and a different amount is not sent, so the override is not cleared by accident.

A refusal is a successful decision. The command exits 0 and prints the kind, the reason code and text, the override that would have cleared it, the signature, and the explorer link. Amounts in that printout are named in the token. An RPC or key problem exits 1.

## Status and decisions

```bash
veto status
veto decisions --limit 20
```

`veto status` shows what the rule can still pay, the cap, the largest payment, the expiry, and the agent's fee SOL. When the SDK warns that the fee balance is low, that warning is printed too.

`veto decisions` lists the newest decisions from the rule. Each row names the token and the signature.

The trade rule is on the devnet program ([docs/DEVNET.md](https://github.com/Arlencho/veto/blob/main/docs/DEVNET.md)). Trading from the companion is switched off in this version, and `veto --help` says so. Agents trade through the SDK's `trade()`.
