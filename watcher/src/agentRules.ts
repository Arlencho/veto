/** Every open payment rule that names this agent, charged once per cadence slot.
 *
 * The configured rule (VETO_OWNER + VETO_MANDATE_ID) keeps its own journaled
 * path in run.ts. This module charges the other rules a tester approved for
 * the agent's public address, so each of them gets a paid or refused request
 * on the same schedule. The chain ledger of each rule is the record; the
 * journal stays the configured rule's diary.
 *
 * Discovery is one getProgramAccounts call: the Mandate discriminator at 0 and
 * the agent pubkey at MANDATE_AGENT_OFFSET, the same filters as
 * mandatesForAgent in sdk/src/read.ts. Decoding uses the bundled IDL, which is
 * the layout sdk/src/layout.ts decodes by hand. The image builds from
 * watcher/ alone, so it does not import the sdk package.
 */

import type { Connection, PublicKey } from "@solana/web3.js";
import type { ChargeReceipt } from "./chain.js";
import { recordedFromLedgerBytes } from "./chain.js";
import type { PriceFeed, PriceWindow } from "./feed.js";
import { fxFixingIsFresh, readFxOrUnreachable, type FxSource } from "./fx.js";
import { amountBaseUnitsQuoted, sekPerKwhToScaled, type SpotQuoteCurrency } from "./money.js";
import { nonceFromSlot, nonceFromWindowStart } from "./nonce.js";
import { isRateLimitError, redactRpcUrlsInText } from "./rpc.js";

/** Discriminator (8) then owner (32). Same value as MANDATE_AGENT_OFFSET in sdk/src/layout.ts. */
export const MANDATE_AGENT_OFFSET = 8 + 32;
export const DEFAULT_AGENT_RULES_MAX = 25;
/** getMultipleAccountsInfo reads at most 100 accounts per call. */
export const AGENT_RULES_MAX_LIMIT = 100;
export const AGENT_RULE_DELAY_MS = 1_500;
const STATUS_ACTIVE = 0;
const SLOT_SECONDS = 6n * 60n * 60n;

export type AgentRule = {
  address: PublicKey;
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  source: PublicKey;
  merchant: PublicKey;
  mandateId: bigint;
  cap: bigint;
  spent: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  lastNonce: bigint;
  status: number;
};

type BnLike = { toString(): string };

export type MandateCoder = {
  decode(name: string, data: Buffer): unknown;
  memcmp(name: string): { offset?: number; bytes?: string };
};

type RawMandate = {
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  source: PublicKey;
  merchant: PublicKey;
  mandate_id: BnLike;
  cap: BnLike;
  spent: BnLike;
  per_tx_max: BnLike;
  expires_at: BnLike;
  last_nonce: BnLike;
  status: number;
};

export function decodeAgentRule(coder: MandateCoder, address: PublicKey, data: Buffer): AgentRule {
  const m = coder.decode("Mandate", data) as RawMandate;
  return {
    address,
    owner: m.owner,
    agent: m.agent,
    mint: m.mint,
    source: m.source,
    merchant: m.merchant,
    mandateId: BigInt(m.mandate_id.toString()),
    cap: BigInt(m.cap.toString()),
    spent: BigInt(m.spent.toString()),
    perTxMax: BigInt(m.per_tx_max.toString()),
    expiresAt: BigInt(m.expires_at.toString()),
    lastNonce: BigInt(m.last_nonce.toString()),
    status: m.status,
  };
}

export type ProgramAccountsReader = Pick<Connection, "getProgramAccounts">;

/** Mandates whose agent field is `agent`. A row that does not decode is logged and left out. */
export async function discoverAgentRules(args: {
  connection: ProgramAccountsReader;
  programId: PublicKey;
  agent: PublicKey;
  coder: MandateCoder;
  log?: (line: string) => void;
}): Promise<AgentRule[]> {
  const disc = args.coder.memcmp("Mandate");
  const rows = await args.connection.getProgramAccounts(args.programId, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: disc.bytes ?? "" } },
      { memcmp: { offset: MANDATE_AGENT_OFFSET, bytes: args.agent.toBase58() } },
    ],
  });
  const out: AgentRule[] = [];
  for (const row of rows) {
    try {
      out.push(decodeAgentRule(args.coder, row.pubkey, Buffer.from(row.account.data)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      args.log?.(`agent rule ${row.pubkey.toBase58()} skipped: does not decode: ${message}`);
    }
  }
  return out;
}

export type SkipReason =
  | "configured rule, charged on its own path"
  | "another agent"
  | "not open"
  | "expired"
  | "another mint"
  | "another payee"
  | "nothing left"
  | "already paid this slot"
  | "already decided this slot"
  | "over the per-run cap";

export type Selection = {
  selected: AgentRule[];
  skipped: { rule: AgentRule; reason: SkipReason }[];
};

/** Eligible rules for this slot, at most `max`, in a rotation that moves each slot.
 *
 * Sorted by address so the order does not depend on RPC row order. When more
 * rules are eligible than the cap allows, the start moves by `max` each slot,
 * so every rule gets a turn instead of the same first `max` every time.
 */
export function selectAgentRules(
  rules: readonly AgentRule[],
  opts: {
    agent: PublicKey;
    mint: PublicKey;
    merchant: PublicKey;
    configured: PublicKey;
    nowUnix: bigint;
    nonce: bigint;
    max: number;
  },
): Selection {
  const skipped: Selection["skipped"] = [];
  const eligible: AgentRule[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const key = rule.address.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = skipReason(rule, opts);
    if (reason === null) eligible.push(rule);
    else skipped.push({ rule, reason });
  }
  eligible.sort((a, b) => cmp(a.address.toBase58(), b.address.toBase58()));
  if (eligible.length <= opts.max) return { selected: eligible, skipped };
  const n = eligible.length;
  const turn = Number((opts.nonce / SLOT_SECONDS) % BigInt(n));
  const start = (turn * opts.max) % n;
  const rotated = [...eligible.slice(start), ...eligible.slice(0, start)];
  for (const rule of rotated.slice(opts.max)) skipped.push({ rule, reason: "over the per-run cap" });
  return { selected: rotated.slice(0, opts.max), skipped };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function skipReason(
  rule: AgentRule,
  opts: { agent: PublicKey; mint: PublicKey; merchant: PublicKey; configured: PublicKey; nowUnix: bigint; nonce: bigint },
): SkipReason | null {
  if (rule.address.equals(opts.configured)) return "configured rule, charged on its own path";
  if (!rule.agent.equals(opts.agent)) return "another agent";
  if (rule.status !== STATUS_ACTIVE) return "not open";
  if (opts.nowUnix >= rule.expiresAt) return "expired";
  if (!rule.mint.equals(opts.mint)) return "another mint";
  // The program refuses a destination whose owner is not the rule's payee,
  // and this agent pays one merchant token account.
  if (!rule.merchant.equals(opts.merchant)) return "another payee";
  if (rule.spent >= rule.cap) return "nothing left";
  if (rule.lastNonce >= opts.nonce) return "already paid this slot";
  return null;
}

export type SlotQuote =
  | { ok: true; amount: bigint; window: PriceWindow }
  | { ok: false; reason: string };

/** The spot amount for one slot, the same arithmetic as the configured rule without calibration.
 *
 * Calibration is sized to the configured rule's own cap and lifetime, so it
 * is not applied to rules whose limits the tester chose.
 */
export async function quoteSlotAmount(args: {
  at: Date;
  feed: PriceFeed;
  fx?: FxSource;
  kwhMilli: bigint;
  mintDecimals: number;
  quoteCurrency: SpotQuoteCurrency;
}): Promise<SlotQuote> {
  const window = await args.feed.getWindow(args.at);
  if (window === null) return { ok: false, reason: "feed unavailable" };
  let startsAtSlot = false;
  try {
    startsAtSlot = nonceFromWindowStart(window.timeStart) === nonceFromSlot(args.at);
  } catch {
    startsAtSlot = false;
  }
  if (!startsAtSlot) return { ok: false, reason: "window start does not match slot" };
  let scaled: bigint;
  try {
    scaled = sekPerKwhToScaled(window.sekPerKwh);
  } catch {
    return { ok: false, reason: "unreadable price" };
  }
  if (scaled < 0n) return { ok: false, reason: "negative price" };
  let usdRateScaled: bigint | undefined;
  let sekRateScaled: bigint | undefined;
  if (args.quoteCurrency === "USD") {
    const fx = await readFxOrUnreachable(args.fx, args.at);
    if (!fx.ok) return { ok: false, reason: "fx unavailable" };
    if (!fxFixingIsFresh(fx.quote.fixingDate, args.at)) {
      return { ok: false, reason: `fx rate stale (${fx.quote.fixingDate})` };
    }
    usdRateScaled = fx.quote.usdRateScaled;
    sekRateScaled = fx.quote.sekRateScaled;
  }
  const amount = amountBaseUnitsQuoted({
    kwhMilli: args.kwhMilli,
    sekPerKwhScaled: scaled,
    mintDecimals: args.mintDecimals,
    quoteCurrency: args.quoteCurrency,
    usdRateScaled,
    sekRateScaled,
  });
  if (amount === 0n) return { ok: false, reason: "zero amount" };
  return { ok: true, amount, window };
}

export type AgentRulesDeps = {
  discover: () => Promise<AgentRule[]>;
  /** Ledger account bytes for each rule, in order. Null when the ledger is missing. */
  readLedgers: (rules: readonly AgentRule[]) => Promise<(Uint8Array | null)[]>;
  submit: (rule: AgentRule, amount: bigint, nonce: bigint) => Promise<ChargeReceipt>;
  quote: (at: Date) => Promise<SlotQuote>;
};

export type AgentRulesSummary = {
  /** False when the slot had no chargeable price, so nothing was discovered or sent. */
  quoted: boolean;
  found: number;
  charged: number;
  paid: number;
  refused: number;
  failed: number;
  skipped: number;
  /** True when a rate limit ended the pass before every selected rule was tried. */
  rateLimited: boolean;
};

/** One pass: quote the slot, discover, select, then charge each rule in turn.
 *
 * Charges are sequential with a pause between them. A rule that throws is
 * logged and the next rule is still charged. A rate limit ends the pass,
 * because every later rule would hit the same endpoint; the rules left over
 * are charged on the next slot.
 */
export async function chargeAgentRules(args: {
  slot: Date;
  now: Date;
  agent: PublicKey;
  mint: PublicKey;
  merchant: PublicKey;
  configured: PublicKey;
  max: number;
  deps: AgentRulesDeps;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log: (line: string) => void;
  logError: (line: string) => void;
}): Promise<AgentRulesSummary> {
  const summary: AgentRulesSummary = {
    quoted: false,
    found: 0,
    charged: 0,
    paid: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
    rateLimited: false,
  };
  const nonce = nonceFromSlot(args.slot);
  const quote = await args.deps.quote(args.slot);
  if (!quote.ok) {
    args.log(`agent rules: no charge this slot nonce=${nonce.toString()} reason=${quote.reason}`);
    return summary;
  }
  summary.quoted = true;

  const rules = await args.deps.discover();
  summary.found = rules.length;
  const { selected, skipped } = selectAgentRules(rules, {
    agent: args.agent,
    mint: args.mint,
    merchant: args.merchant,
    configured: args.configured,
    nowUnix: BigInt(Math.floor(args.now.getTime() / 1000)),
    nonce,
    max: args.max,
  });
  for (const { rule, reason } of skipped) {
    args.log(`agent rule ${rule.address.toBase58()} skipped: ${reason}`);
  }
  summary.skipped = skipped.length;

  // A refusal does not move last_nonce, so a second run in the same slot
  // reads the ledger ring and leaves a rule alone once it has any row for
  // this nonce. One batched read for every selected rule.
  let ledgers: (Uint8Array | null)[] = [];
  if (selected.length > 0) {
    try {
      ledgers = await args.deps.readLedgers(selected);
    } catch (err) {
      args.logError(`agent rules: ledger read failed, no rule charged this pass: ${describe(err)}`);
      summary.rateLimited = isRateLimitError(err);
      return summary;
    }
  }

  const delayMs = args.delayMs ?? AGENT_RULE_DELAY_MS;
  const pause = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let first = true;
  for (let i = 0; i < selected.length; i += 1) {
    const rule = selected[i]!;
    const id = rule.address.toBase58();
    const ledger = ledgers[i] ?? null;
    if (ledger !== null && recordedFromLedgerBytes(ledger, nonce) !== null) {
      args.log(`agent rule ${id} skipped: already decided this slot`);
      summary.skipped += 1;
      continue;
    }
    if (!first) await pause(delayMs);
    first = false;
    summary.charged += 1;
    try {
      const receipt = await args.deps.submit(rule, quote.amount, nonce);
      if (receipt.decision === "paid") {
        summary.paid += 1;
        args.log(
          `agent rule ${id} paid amount=${quote.amount.toString()} nonce=${nonce.toString()} sig=${receipt.signature || "-"}`,
        );
      } else {
        summary.refused += 1;
        args.log(
          `agent rule ${id} refused reason=${receipt.reason} amount=${quote.amount.toString()} nonce=${nonce.toString()} sig=${receipt.signature || "-"}`,
        );
      }
    } catch (err) {
      summary.failed += 1;
      args.logError(`agent rule ${id} failed amount=${quote.amount.toString()} nonce=${nonce.toString()}: ${describe(err)}`);
      if (isRateLimitError(err)) {
        summary.rateLimited = true;
        args.logError("agent rules: rpc rate limited, the rest wait for the next slot");
        break;
      }
    }
  }
  args.log(
    `agent rules: found=${summary.found} charged=${summary.charged} paid=${summary.paid} refused=${summary.refused} failed=${summary.failed} skipped=${summary.skipped} nonce=${nonce.toString()}`,
  );
  return summary;
}

function describe(err: unknown): string {
  return redactRpcUrlsInText(err instanceof Error ? err.message : String(err));
}

/** VETO_AGENT_RULES_MAX. Unset is the default; 0 turns the pass off. */
export function parseAgentRulesMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_AGENT_RULES_MAX;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`config.loadConfig: VETO_AGENT_RULES_MAX must be a whole number, got ${trimmed}`);
  }
  const n = Number.parseInt(trimmed, 10);
  if (n > AGENT_RULES_MAX_LIMIT) {
    throw new Error(`config.loadConfig: VETO_AGENT_RULES_MAX must be at most ${AGENT_RULES_MAX_LIMIT}, got ${n}`);
  }
  return n;
}
