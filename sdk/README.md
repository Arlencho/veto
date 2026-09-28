# @veto-hq/agent-sdk

TypeScript client for one `charge`, for one `trade`, for reading the mandate, the ledger, and the decisions, and for a Hold vault. The package name is `@veto-hq/agent-sdk`.

```bash
npm install @veto-hq/agent-sdk
```

Version 0.1.1 was published to npm on 2026-09-28 (0.1.0 on 2026-09-27).

See [the publishing guide](https://github.com/Arlencho/veto/blob/main/docs/PUBLISH.md) for the maintainer release steps. `watcher/` is the full reference agent. The app does not import this package. It builds Hold instructions itself.

Node 22 or newer.

```bash
cd sdk
npm ci
npx tsx examples/pay-once.ts <agent-key.json> <config.json> <amount-in-base-units>
```

The example prints kind, reason code, reason text, suggested override, signature, and slot.

## SKR charges

`examples/skr-once.ts` demonstrates two charges. The program runs on devnet today, not mainnet. To run against a devnet rule, set `VETO_MINT` to that rule's actual mint, for example the 6-decimal second mint. The SKR default applies once the contained mainnet rule exists.

From `sdk/`, with `VETO_RPC` already set in your environment:

```bash
VETO_MINT=<actual-devnet-rule-mint> VETO_RULE=<rule-address> VETO_AGENT_KEY=<agent-key.json> npx tsx examples/skr-once.ts
```

`VETO_RPC` is required and is never printed, including on failure. `VETO_RULE` is the mandate address and `VETO_AGENT_KEY` is the path to its agent's JSON secret key array. `VETO_MINT` defaults to `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`. The configured mint must match the rule and have 6 decimals; a mismatch stops execution before any charge.

The example submits 8 SKR (8,000,000 base units), expects a paid decision with reason code 0, then submits 25 SKR (25,000,000 base units) and expects a refusal with reason code 5 (over the per-payment maximum). With a devnet mint override, these amounts are units of that mint; the output keeps the SKR label. Each result prints the amount, decision, reason code, reason text, signature, and slot. An unexpected decision or reason code exits nonzero. Local precheck messages are printed; other errors are suppressed. The example checks that the rule is active and has not expired according to the local clock before submitting. Use an active, unexpired, funded rule with at least 8 SKR remaining, a per-payment maximum of at least 8 and below 25 SKR, no pending override, and enough agent SOL for transaction fees. Each run can spend another 8 SKR and incurs fees for both transactions.

`npm run typecheck:examples` checks this example and the existing examples using `tsconfig.test.json`, without executing them or accessing the network.

## Asking the owner for a rule

The operator builds a rule request and renders it as a QR. The owner scans that QR and approves. The same URL is what `createRuleRequest` returns and what `parseRuleRequest` reads.

```bash
npx tsx examples/rule-request.ts <agent-key.json> <payee> <mint> <cap> <max> <days> "<purpose>" [agentLabel] [payeeLabel]
```

The agent key file is the JSON secret key array the agent already uses. The command prints one URL:

```text
veto://rule-request?v=1&agent=<base58>&payee=<base58>&mint=<base58>&cap=<u64>&max=<u64>&days=<1..3650>&purpose=<percent-encoded>&agentLabel=<optional>&payeeLabel=<optional>
```

`cap` and `max` are integer base units, greater than 0, with `max` at most `cap`. The app reads the mint's decimals from the chain. `days` is an integer from 1 to 3650. `purpose` is UTF-8 of at most 64 bytes. That is `PURPOSE_MAX_LEN` in `programs/veto/src/state.rs`: the mandate account stores 64 bytes of purpose text. `agentLabel` and `payeeLabel` are optional, at most 64 Unicode code points, and they are the requester's claim about a name.

A space is `%20`. A plus sign stays a plus sign. Percent-encoding round-trips any UTF-8 that fits the limit.

Render the printed URL as a QR. The QR payload is that URL.

The owner scans the QR, or opens the link. The card states the permission: who may be paid, from which mint, the cap, the largest payment, the number of days, and the purpose. The cap, the largest payment, and the duration are ceilings the owner can lower before approving with Seed Vault. A label is shown as what that address calls itself, beside the shortened address, with the full address one tap away.

```ts
import { createRuleRequest, parseRuleRequest } from "@veto-hq/agent-sdk";

const url = createRuleRequest({
  agent,
  payee,
  mint,
  cap: 1_000_000n,
  max: 50_000n,
  days: 30,
  purpose: "API fees",
  agentLabel: "billing agent",
});

const parsed = parseRuleRequest(url);
if (!parsed.ok) {
  // parsed.error.problem names the first problem. Nothing from the request is applied.
}
```

In this repo the import is from `../sdk/src/index.js` until the package is built and linked.

Unknown query keys are ignored. A missing required key, a non-canonical address, an amount of 0, a `max` above `cap`, a `days` outside 1 to 3650, a purpose longer than 64 bytes, a label longer than 64 characters, or percent-encoding that is not UTF-8 rejects the whole request. The shared URL cases are the `valid` and `invalid` arrays in `sdk/src/fixtures/rule-request-v1.json`.

## The block the app copies

On an active rule the app shows Connect your agent. Copy all and the QR are the same JSON. `loadAgentConfig` accepts that text or the parsed object. Every field is required. An extra field is refused.

```json
{
  "mandate": "<mandate address>",
  "programId": "<program id>",
  "mint": "<mint address>",
  "mintDecimals": 6,
  "sourceTokenAccount": "<rule token account>",
  "payeeTokenAccount": "<payee token account>",
  "agent": "<agent address>",
  "cluster": "devnet",
  "rpcUrl": "<rpc url>"
}
```

`cluster` is `devnet`, `testnet`, or `mainnet-beta`.

## What `VetoAgent.fromConfig` checks

```ts
import { Connection } from "@solana/web3.js";
import { loadAgentConfig, VetoAgent } from "@veto-hq/agent-sdk";

const config = loadAgentConfig(jsonText);
const veto = await VetoAgent.fromConfig(config, agentKeypair);
```

In this repo the import is from `../sdk/src/index.js` until the package is built and linked. `main` points at `./dist/src/index.js`, which exists after `npm run build`.

The checks, in order:

1. The agent key in the file matches `config.agent`.
2. The program is the id bundled in `sdk/idl/veto.json` (`3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`). A block whose `programId` differs is refused. A localnet build passes a different program id as `{ programId }` in the options argument. The bundled id is the pin. The option is the only other id accepted.
3. A `Connection` argument is the endpoint. When it is omitted, `config.rpcUrl` is opened. Whichever endpoint is used must report the genesis hash of `config.cluster`.
4. The mandate account is owned by that program. Its agent matches the agent key. Its mint and source token account match the block.
5. `mintDecimals` matches the decimals on the mint account, and that mint account is owned by the same token program as the source account.
6. `payeeTokenAccount` is the payee's associated token account for this mint when that account exists, otherwise the payee's only token account for the mint.

`charge` uses `nextNonce()` when the example asks for the next nonce. That is `last_nonce` plus one, or `overrideNonce` when an override is pending above `last_nonce`. It submits one `charge` and reads the decision in that transaction.

## Finding the rules for an agent key

`mandatesForAgent(connection, agent)` reads the mandate accounts whose agent field is that key. `agent` is a public key or a base58 string. The call is `getProgramAccounts` on the Veto program with two filters: the mandate discriminator, and a memcmp at `MANDATE_AGENT_OFFSET` from `sdk/src/layout.ts` (the agent pubkey, after the 8-byte discriminator and the owner pubkey). The decoded mandates come back newest first. Newest is the largest `mandateId`, and a revoked rule is included.

The list spans every owner. The agent does not sign when a mandate is opened, so anyone who knows the agent address can open one that names it, with any payee and any `mandateId`, including `u64::MAX`. Never take the first row on trust: keep the rule address you were given, or select by the owner and the terms you expect.

```ts
import { mandatesForAgent, VetoAgent } from "@veto-hq/agent-sdk";

const rules = await mandatesForAgent(connection, agentKeypair.publicKey);
const mine = rules.filter(
  (rule) => rule.owner.equals(expectedOwner) && rule.merchant.equals(expectedPayee) && rule.status === 0,
);
if (mine.length === 1) {
  const veto = await VetoAgent.fromMandate(connection, mine[0].address, agentKeypair);
}
```

In this repo the import is from `../sdk/src/index.js` until the package is built and linked.

`VetoAgent.fromMandate(connection, mandate, keypair)` performs the same checks as `fromConfig`. It reads the program id, the mint and its decimals, the source, the payee token account, the agent, and the cluster from the chain:

1. The connection's genesis hash is the one published for devnet, testnet, or mainnet-beta. That match is the cluster.
2. The mandate account exists. Its owner is the Veto program id bundled in `sdk/idl/veto.json` (`3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`). A mandate owned by another program is refused.
3. The account decodes as a mandate. The agent field equals the keypair.
4. The source token account named by the mandate exists.
5. The mint account is owned by the same token program as that source account, and its decimals byte can be read.
6. The payee token account is the payee's associated token account for this mint when that account exists, otherwise the payee's only token account for the mint.

`fromConfig` still checks a copied block against the chain.

## Retrying after the owner grants an override

A charge above the per-payment maximum is refused with reason code 5. `last_nonce` does not advance, so that charge can be retried. The owner grants an override for one nonce and one amount. The mandate stores those as `override_nonce` and `override_amount`.

`status()` returns them as `overrideNonce` and `overrideAmount`. While `overrideNonce` is above `lastNonce`, `nextNonce()` returns `overrideNonce` instead of `last_nonce` plus one. Any paid charge at that pending override nonce clears the override, including a smaller charge that was already queued. An agent with other charges waiting sends the retry first. Charge the refused amount, and only after checking that it is at most `overrideAmount`. The amount must still fit in the remaining cap.

```ts
const refusedAmount = 12_000n;
const status = await veto.status();
if (status.overrideNonce > status.lastNonce && refusedAmount <= status.overrideAmount) {
  const outcome = await veto.charge({
    amount: refusedAmount,
    nonce: await veto.nextNonce(),
  });
}
```

Pass `guardPendingOverride: true` to `charge` to refuse locally when the nonce is a pending override and the amount differs from `overrideAmount`. Without that option the SDK sends the amount and nonce you give it, and the program decides.

## Advisory purpose check

`purposeCheck` is optional. Pass it to `VetoAgent` (or to `fromConfig` in the options argument). It is an async function you write. The SDK does not call a model, and it does not ship one.

The function receives the rule's on-chain purpose, the amount in base units, the mint decimals, the payee (the mandate's merchant address), the mandate address, and the description you pass to `chargeWithPurposeCheck`. It returns `{ allow, reason }`.

`chargeWithPurposeCheck({ amount, nonce, description })` calls that function first.

When `allow` is true, the SDK submits `charge` the same way `charge()` does. The program still enforces every number: the cap, the per-payment maximum, the nonce, expiry, the merchant, the delegation, and the rest. A purpose check cannot raise a limit.

When `allow` is not true, the SDK does not submit `charge`. It sends one transaction to the SPL Memo program `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`. The agent key signs that transaction and pays the fee. The mandate address is included as a read-only account and does not sign. That memo program accepts the mandate in the account list without a signature. The other memo program requires every account on the instruction to sign, so it cannot name the mandate this way. The memo text is `veto-advisory:v1` followed by compact JSON with `mandate`, `amount`, `nonce`, `reason`, and `description_sha256`. `reason` is at most 256 UTF-8 bytes, cut on a character boundary, then JSON-escaped. `description_sha256` is the hex sha256 of the description. The call returns `{ kind: "advisory_declined", reason, signature }`.

That record is the agent's own decision. It is not a program refusal. `verify` does not treat it as a decision. An advisory decline does not advance `last_nonce`: the program never sees the charge, so that nonce can still be charged later.

Whoever runs the agent can skip the check. `charge()` never calls `purposeCheck`, even when one is set.

`decisionsForMandate` returns an advisory record (`kind: "advisory_declined"`) only when the transaction succeeded, the memo is signed by the mandate's agent key, the memo names that mandate as a read-only non-signer, and the text parses as `veto-advisory:v1`. `reasonText` is `Agent declined (advisory)`. The memo's reason is `advisoryReason`. A stranger's memo that names the mandate is ignored. A memo that does not parse is ignored. Neither one is a decision, and neither one changes the page cursor: `oldestSignature` and `pageFull` still describe the signature listing.

`examples/purpose-check.ts` is one such check. It posts the context to the HTTP endpoint in `PURPOSE_CHECK_URL` and expects `{ "allow": boolean, "reason": string }`. If the endpoint errors, or the body is not that shape, the check declines.

```bash
PURPOSE_CHECK_URL=<endpoint> npx tsx examples/purpose-check.ts <agent-key.json> <mandate> <amount> "<description>"
```

`VETO_RPC` overrides the endpoint. When it is unset, the example uses `https://api.devnet.solana.com`.

## Reading decisions

`decisionsForMandate` reads one page of signatures for the mandate. It does not walk every transaction on a long-lived mandate. Each call returns the decisions on that page, `oldestSignature` (the oldest signature on the listing, including a failed or foreign signature), and `pageFull` (true when the listing returned a full page).

The decision array is ordered oldest first. Omit `limit` to take every decision on the page. `limit` takes the newest decisions, at most 1000, and never splits a transaction: the last transaction included comes back in full, so the array can be longer than `limit`. `before` starts at signatures older than the one you name. `until` stops before a signature, leaving it and anything older unread.

The signature listing is one request. Transaction reads then run one at a time by default, 1000 ms after the previous RPC read (`concurrency` is how many of those reads run together). A 429 is tried up to 4 times with capped exponential backoff and jitter: the ceiling starts at 200 ms, doubles, and never exceeds 2000 ms, and the built-in wait is between half that ceiling and the ceiling. With neither `readConnection` nor `connectionConfig`, the SDK opens its own connection from the caller's endpoint and commitment and sets `disableRetryOnRateLimit`, so the web3 client does not retry the same 429.

web3.js does not expose a connection's config, so a caller with custom headers, fetch, middleware or agent passes `connectionConfig` once or passes its own `readConnection` built with `disableRetryOnRateLimit: true`. `connectionConfig` (headers, fetch, middleware, agent, websocket endpoint) is merged with the caller's endpoint and commitment, and the connection opened for these reads sets `disableRetryOnRateLimit`. A `readConnection` is used as given.

```ts
const page = await decisionsForMandate(connection, mandate, {
  connectionConfig: { httpHeaders: { "x-read-key": "<read key>" } },
});
```

To read older history, pass `before` set to `oldestSignature` from the previous page. Continue while `pageFull` is true. Stop when a page is not full. An empty decision array is not the end of the history: a page of failed or foreign signatures still carries that cursor. A listed signature whose `getTransaction` returns null raises `MissingListedTransactionError` instead of dropping that signature.

```ts
const seen = [];
let before: string | undefined;
for (;;) {
  const page = await decisionsForMandate(connection, mandate, { before });
  seen.push(...page);
  if (!page.pageFull || page.oldestSignature === null) break;
  before = page.oldestSignature;
}
```

Do not pass `limit` on this walk. `limit` can stop before the end of the listing, and `oldestSignature` is still the oldest signature listed, so the next page would skip signatures `limit` left unread. After a limited page, continue from the signature of the oldest decision in that result.

## Trading against one pinned pool

A trade rule is a permission to swap. The owner pins one input token account, one output token account, and one pool. `VetoAgent.trade({ amountIn, minOut, nonce })` loads that rule and submits the thirteen-account `trade` instruction. The accounts are the agent, the rule, the trade ledger, the source, the destination, the exchange program, the pool, the pool authority, the input vault, the output vault, the pool mint, the fee account, and the token program. The mints are not accounts on the instruction. Every account except the token program is taken from the keys stored on the rule. The caller cannot pass a pool, a vault, or a destination.

The call returns `kind: "traded"` or `kind: "refused"`, with `amountIn`, `amountOut`, `reasonCode`, `reasonText`, `suggestedOverride`, `signature`, and `slot`. It reads the one Veto trade decision in that transaction, the same way `charge` reads the one payment decision. On a refusal, `amountOut` is zero. On `kind: "traded"`, the returned `amountIn` is the settled input, which can be below the requested amount.

`tradeStatus()` reports the cap, what has been spent, what remains, the per-trade maximum, the daily limit, what remains today, the floor as `{ num, den }`, expiry, status, any override, the last nonce, and the pinned destination. A 24 hour window that has already ended counts as unused, so `remainingToday` is the full daily limit until the next trade opens a new window. `nextTradeNonce()` is `last_nonce` plus one, or `overrideNonce` when an override is pending above `last_nonce`. A refusal does not advance `last_nonce`.

`tradeRulesForAgent(connection, agent)` reads the trade rules whose agent field is that key. It is `getProgramAccounts` with the TradeRule discriminator and a memcmp at `TRADE_RULE_AGENT_OFFSET`. Newest `ruleId` comes first.

`VetoAgent.fromTradeConfig` checks the copied block against the chain: the program id, the agent, the in and out mints and their decimals, the source, the pinned destination, and the cluster. A payment block with no `kind` still loads through `loadAgentConfig`. A trade block sets `kind` to `trade` and names the rule address.

```json
{
  "kind": "trade",
  "rule": "<rule address>",
  "programId": "<program id>",
  "agent": "<agent address>",
  "inMint": "<input mint>",
  "inMintDecimals": 9,
  "outMint": "<output mint>",
  "outMintDecimals": 6,
  "sourceTokenAccount": "<input token account>",
  "destinationTokenAccount": "<pinned output token account>",
  "cluster": "devnet",
  "rpcUrl": "<rpc url>"
}
```

### What the rule enforces

The program refuses the trade, and moves nothing, when:

- The output account is not the pinned destination. Reason 11, output account not allowed.
- A pool account (the pool, its authority, either vault, the pool mint, the fee account, or the exchange program) is not the one stored on the rule. Reason 12, pool account not allowed.
- The trade would push the current 24 hour window over the daily limit. Reason 13, over daily limit.
- The spot quote is already under the price floor `floor.num / floor.den`. Reason 14, quote below floor. The program then requires the tokens that come back to clear that same floor.

It also enforces the lifetime cap, the per-trade maximum, expiry, the nonce, that the rule is active, that the delegation is still in place, that the source can cover the input, and that neither token account is frozen. An override raises the per-trade maximum for one nonce. It does not raise the daily limit or the cap.

### What it cannot do

Veto does not know whether a trade was smart. It knows whether the money came back to you.

It does not pick a pool, a route, or a better price. The pool is the one the owner pinned, and the output can only land in the pinned destination. A swap that clears the floor can still be a poor price. The floor is a number, not a judgment.

### Asking for a trade rule

`createTradeRuleRequest` prints a v2 URL. `parseTradeRuleRequest` reads it. `parseRuleRequest` is the v1 reader: it rejects this URL at version, which is the first problem, and it does not apply any trade field.

```text
veto://rule-request?v=2&kind=trade&agent=<base58>&inMint=<base58>&outMint=<base58>&pool=<base58>&perTrade=<u64>&daily=<u64>&cap=<u64>&floorBps=<u64>&days=<1..3650>&purpose=<percent-encoded>&agentLabel=<optional>&poolLabel=<optional>
```

`perTrade`, `daily`, and `cap` are integer base units greater than 0, with `perTrade` at most `daily` and `daily` at most `cap`. `floorBps` is an integer greater than 0. 10000 is one output base unit per input base unit. A larger value is allowed, because the two mints do not share a scale. `days` and `purpose` use the same limits as a payment request. `agentLabel` and `poolLabel` are optional. The shared cases are `sdk/src/fixtures/rule-request-v2.json`.

## Hold vault

`HoldVault` builds and sends `init_vault`, `deposit`, `withdraw`, `execute`, `stop`, `freeze`, `unfreeze` (owner and guardian), `skip` (owner and guardian), `recover`, `propose_change`, `apply_change`, and `cancel_change`. `readVault` reads the vault account, its pending withdrawals, and its ledger. `withdrawalOutlook` says whether a planned withdrawal would pay at once or be held, and why: frozen, a new address, over the daily limit, or over the share. A withdrawal the vault cannot cover is refused. A withdrawal that would wait when the pending list is already full (8) is refused. A withdrawal that can pay at once is not blocked by a full pending list.

The daily limit uses the same conservative rolling day as trade rules: 25 hourly
buckets retain the current hour and the preceding 24 hours. Allowance can take
up to 25 hours to return. `dailyBuckets` contains this accounting; `windowSpent`
and `windowStart` remain only for the separate big-door share calculation.
The client requires the new 1691-byte layout. Retire the old devnet demo vault
and reopen it using the recovery procedure in [docs/DEVNET.md](../docs/DEVNET.md)
before using this client against the upgraded program.


The vault PDA is `["hold", owner, vault_id]` with `vault_id` as a little-endian u64. The known-destination list holds 16 addresses. The hold ledger is a 32-entry ring. The instructions and the account fields are in `programs/veto/src/hold.rs`.

Hold is merged and tested, and live on devnet. These methods target the program recorded in [docs/DEVNET.md](../docs/DEVNET.md). The app screens exist. A completed device check of Hold with a real vault is not recorded in this repository yet. The package that exports `HoldVault` is published from this checkout by the maintainer.

## Trade demo

The refusals are real attempts by a script we wrote against our own pool on devnet.

`trade-once.ts` loads the agent signer and a copied trade config block, reads
`tradeStatus()`, computes the next nonce and submits one trade with `min_out` zero.
The program applies the owner's floor. The output includes kind, input and output
amounts, reason code and text, suggested override, signature and slot. All amounts
are integer input base units, not decimal token amounts. Both forms always refuse
non-devnet connections. A refused honest trade exits non-zero, stopping the Make
target before the hostile script.

```sh
cd sdk
npx tsx examples/trade-once.ts ../keys/agent.json ../keys/trade-config.json 1000000
# A rule address instead of a config block requires VETO_RPC:
npx tsx examples/trade-once.ts ../keys/agent.json --rule <rule-address> 1000000
```

`hacked-agent.ts` identifies itself as a deliberately hostile agent in its header
and first output line. It submits, in order: an agent-owned output account (11),
a freshly initialized bad-rate pool of the same mints (12), an amount over the
per-trade maximum (5, with its override figure), a trade after a separate signer
pushes the pinned pool below the floor (14), an honest trade after that signer
reverses its swaps (traded), then trades until a daily-limit refusal (13). Every attempt
prints its signature and recorded reason. An unexpected kind, reason or override
exits non-zero immediately. Setup prints `stolen_destination=<pubkey>`,
`bad_pool=<pubkey>` and each submitted setup signature, allowing the destination
and pool substitutions to be checked against the reason 11 and 12 transactions.
Reusing an existing associated token account needs no setup transaction.
It does not load or use the owner key or print secrets.

```sh
# From the repository root, export the addresses written by the pool setup script:
set -a
. ./keys/devnet-addresses.env
set +a
cd sdk
npx tsx examples/hacked-agent.ts ../keys/agent.json ../keys/trade-config.json 1000000 ../keys/trade-trader.json
# The same --rule <rule-address> form is supported before the amount and second key.
```

Prepare an active trade rule for the WSOL to USDC pool recorded by
`scripts/devnet-token-swap-pool.ts`. Keep its source funded and delegated, with no
pending override, enough lifetime cap to cover the remaining daily allowance,
and enough time before expiry. After `trade-once`, the remaining daily allowance
and the per-trade maximum must each be at least twice the demo amount. The pool
must have enough liquidity and floor headroom for the daily trades. The floor
attempt, restore and honest trade happen before the daily-limit attempts.
A full re-run needs a fresh daily window or a new rule, plus replenished signer
funds as needed. No clock manipulation or owner override is involved.

Both demo signers need SOL for fees and account rent. The agent also needs input
funds and at least one output base unit in its own associated token accounts to
seed the hostile pool. `keys/trade-trader.json` must be a separate funded signer,
not the agent or owner. It needs enough input funds to move the pinned pool's
price, potentially several times its input reserve. The scripts wrap SOL as
needed; other tokens must already be funded. The second signer reverses only the
output received from its price-moving swaps. Fees remain spent, and the hostile
pool and its rent remain on devnet. Any surprise stops the demo at that point,
so a failed run may leave the pool's rate changed. Do not share this fixture with
concurrent traders or reuse it without checking remaining limits and balances.

From the repository root, `make trade-demo-devnet` runs `trade-once` followed by
`hacked-agent`. It requires `keys/agent.json`, `keys/trade-trader.json`,
`keys/trade-config.json`, `keys/devnet-addresses.env`, installed SDK dependencies,
explicit `VETO_RPC`, `TRADE_DEMO_AMOUNT`, and all six `TOKEN_SWAP_*` addresses in
that env file. It refuses missing inputs before invoking either script. The
scripts verify the devnet genesis hash and match the addresses to the live rule.
`VETO_TRADE_DEMO_DEVNET=1` enables the pool environment check in `trade-once`;
the devnet check is unconditional.

```sh
VETO_RPC=https://api.devnet.solana.com TRADE_DEMO_AMOUNT=1000000 make trade-demo-devnet
```

Offline coverage uses the SDK testkit fakes: `cd sdk && npm run typecheck && npm test`.
Running these demos on devnet belongs to the upgrade plan, not the offline checks.
