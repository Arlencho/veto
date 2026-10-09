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
 * mandatesForAgent in sdk/src/read.ts. Decoding uses the running Program's
 * account coder (the bundled IDL), which is the layout sdk/src/layout.ts
 * decodes by hand. The image builds from watcher/ alone, so it does not
 * import the sdk package.
 */

import type { IdlAccounts } from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";
import type { ChargeReceipt } from "./chain.js";
import { findAllowOnceInLedgerBytes, recordedFromLedgerBytes } from "./chain.js";
import type { PriceFeed, PriceWindow } from "./feed.js";
import { fxFixingIsFresh, readFxOrUnreachable, type FxSource } from "./fx.js";
import { amountBaseUnitsQuoted, sekPerKwhToScaled, type SpotQuoteCurrency } from "./money.js";
import type { Veto } from "./idl.js";
import { nonceFromSlot, nonceFromWindowStart } from "./nonce.js";
import { isRateLimitError, isTransientRpcError, redactRpcUrlsInText } from "./rpc.js";

/** Discriminator (8) then owner (32). Same value as MANDATE_AGENT_OFFSET in sdk/src/layout.ts. */
export const MANDATE_AGENT_OFFSET = 8 + 32;
export const DEFAULT_AGENT_RULES_MAX = 25;
/** getMultipleAccountsInfo reads at most 100 accounts per call. */
export const AGENT_RULES_MAX_LIMIT = 100;
export const AGENT_RULE_DELAY_MS = 1_500;
/** No new charge starts after this long into one pass. A Cloud Run task ends
 * at 15 minutes, and one charge can wait up to 90 s for confirmation, so the
 * default leaves room for the charge in flight and everything else the task runs. */
export const DEFAULT_AGENT_PASS_BUDGET_MS = 8 * 60_000;
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
  /** The owner's "Allow one": a raised per-payment ceiling for one nonce. */
  overrideAmount: bigint;
  /** Zero when no override is pending. */
  overrideNonce: bigint;
  status: number;
};

/** The account name as the Program's coder knows it. The Program constructor
 * camelCases the IDL, so this is `mandate`, not the JSON's `Mandate`. Typed
 * against src/idl.ts so a rename fails the typecheck. */
export const MANDATE_ACCOUNT: keyof IdlAccounts<Veto> & string = "mandate";

/** What the Program's coder returns for a mandate: camelCase fields, BN numbers. */
type RawMandate = IdlAccounts<Veto>["mandate"];

/** program.coder.accounts from the running Program (see programFromIdl in chain.ts). */
export type MandateCoder = {
  decode<T = unknown>(name: string, data: Buffer): T;
  memcmp(name: string): { offset?: number; bytes?: string };
};

export function decodeAgentRule(coder: MandateCoder, address: PublicKey, data: Buffer): AgentRule {
  const m = coder.decode<RawMandate>(MANDATE_ACCOUNT, data);
  return {
    address,
    owner: m.owner,
    agent: m.agent,
    mint: m.mint,
    source: m.source,
    merchant: m.merchant,
    mandateId: BigInt(m.mandateId.toString()),
    cap: BigInt(m.cap.toString()),
    spent: BigInt(m.spent.toString()),
    perTxMax: BigInt(m.perTxMax.toString()),
    expiresAt: BigInt(m.expiresAt.toString()),
    lastNonce: BigInt(m.lastNonce.toString()),
    overrideAmount: BigInt(m.overrideAmount.toString()),
    overrideNonce: BigInt(m.overrideNonce.toString()),
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
  const disc = args.coder.memcmp(MANDATE_ACCOUNT);
  // An empty filter would match every account the program owns.
  if (disc.bytes === undefined || disc.bytes.length === 0) {
    throw new Error("agent rules: the IDL coder has no Mandate discriminator");
  }
  const rows = await args.connection.getProgramAccounts(args.programId, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: disc.bytes } },
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
  const { selected, over } = rotateBySlot(eligible, opts.nonce, opts.max);
  for (const rule of over) skipped.push({ rule, reason: "over the per-run cap" });
  return { selected, skipped };
}

/** At most `max` rules in address order, starting `max` further on each slot.
 *
 * Sorted by address so the order does not depend on RPC row order. When there
 * are more rules than `max`, the start moves by `max` each slot, so every rule
 * gets a turn instead of the same first `max` every time.
 */
function rotateBySlot(
  rules: readonly AgentRule[],
  nonce: bigint,
  max: number,
): { selected: AgentRule[]; over: AgentRule[] } {
  const sorted = [...rules].sort((a, b) => cmp(a.address.toBase58(), b.address.toBase58()));
  if (sorted.length <= max) return { selected: sorted, over: [] };
  const n = sorted.length;
  const turn = Number((nonce / SLOT_SECONDS) % BigInt(n));
  const start = (turn * max) % n;
  const rotated = [...sorted.slice(start), ...sorted.slice(0, start)];
  return { selected: rotated.slice(0, max), over: rotated.slice(max) };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function skipReason(
  rule: AgentRule,
  opts: { agent: PublicKey; mint: PublicKey; merchant: PublicKey; configured: PublicKey; nowUnix: bigint; nonce: bigint },
): SkipReason | null {
  if (rule.address.equals(opts.configured)) return "configured rule, charged on its own path";
  const unusable = unusableReason(rule, opts);
  if (unusable !== null) return unusable;
  if (rule.spent >= rule.cap) return "nothing left";
  if (rule.lastNonce >= opts.nonce) return "already paid this slot";
  return null;
}

/** Why this agent cannot charge the rule at all, or null when it can. */
function unusableReason(
  rule: AgentRule,
  opts: { agent: PublicKey; mint: PublicKey; merchant: PublicKey; nowUnix: bigint },
): SkipReason | null {
  if (!rule.agent.equals(opts.agent)) return "another agent";
  if (rule.status !== STATUS_ACTIVE) return "not open";
  if (opts.nowUnix >= rule.expiresAt) return "expired";
  if (!rule.mint.equals(opts.mint)) return "another mint";
  // The program refuses a destination whose owner is not the rule's payee,
  // and this agent pays one merchant token account.
  if (!rule.merchant.equals(opts.merchant)) return "another payee";
  return null;
}

/** True when the owner tapped "Allow one" and no payment has used it yet.
 *
 * grant_override needs nonce > last_nonce, and a paid charge of that nonce
 * clears override_nonce, so a pending allow is override_nonce above
 * last_nonce. A paid charge of any later nonce strands it the same way.
 */
export function hasPendingAllowOnce(rule: AgentRule): boolean {
  return rule.overrideNonce !== 0n && rule.overrideNonce > rule.lastNonce;
}

export type AllowOnceRetry = { nonce: bigint; amount: bigint };

export type AllowOnceOpts = { agent: PublicKey; mint: PublicKey; merchant: PublicKey; nowUnix: bigint; nonce: bigint };

/** The retry an "Allow one" asks for, or why it is not sent.
 *
 * The retry repeats the refused request: the same nonce and the same amount,
 * read from the refused ring row the allow followed. It is sent only when the
 * program would pay it on its limits: the amount within the raised ceiling
 * max(per_tx_max, override_amount) and within the remaining cap. One retry per
 * allow: a refusal written after the allow means the agent already tried.
 * `opts.nonce` is the lowest request this run is about to charge; an allowed
 * request above it would strand that charge, so it waits.
 */
export function allowOnceRetry(
  rule: AgentRule,
  ledger: Uint8Array | null,
  opts: AllowOnceOpts,
): AllowOnceRetry | { skip: string } {
  if (!hasPendingAllowOnce(rule)) return { skip: "no allow pending" };
  const unusable = unusableReason(rule, opts);
  if (unusable !== null) return { skip: unusable };
  if (rule.overrideNonce > opts.nonce) return { skip: "the allowed request is later than this slot" };
  if (ledger === null) return { skip: "no ledger" };
  const ring = findAllowOnceInLedgerBytes(ledger, rule.overrideNonce);
  if (ring === null) return { skip: "the allow is not in the ledger ring" };
  if (ring.retried) return { skip: "already retried since the allow" };
  if (ring.refused === null) return { skip: "no refused request for that nonce in the ledger ring" };
  const amount = ring.refused.amount;
  const ceiling = rule.overrideAmount > rule.perTxMax ? rule.overrideAmount : rule.perTxMax;
  if (amount === 0n) return { skip: "the refused amount is zero" };
  if (amount > ceiling) return { skip: "the refused amount is above the allowed amount" };
  if (rule.spent + amount > rule.cap) return { skip: "over the remaining cap" };
  return { nonce: rule.overrideNonce, amount };
}

export type AllowOnceOutcome = "paid" | "refused" | "failed" | "skipped";

/** The configured rule's allow-one retry, run on its own path before its slot charge.
 *
 * One read of the mandate and its ledger. Nothing is logged when no allow is
 * pending. The journal is not touched: it records slot decisions, and the
 * retry is on the chain ledger. Never throws.
 *
 * With `memo`, the check runs once per lowest owed nonce (`opts.nonce`): it
 * is recorded after the read answered and no send failed, so a failed read or
 * a failed send is checked again on the next call.
 */
export async function retryConfiguredAllowOnce(args: {
  mandate: PublicKey;
  ledger: PublicKey;
  coder: MandateCoder;
  readAccounts: (addresses: PublicKey[]) => Promise<(Uint8Array | null)[]>;
  opts: AllowOnceOpts;
  submit: (rule: AgentRule, amount: bigint, nonce: bigint) => Promise<ChargeReceipt>;
  memo?: ConfiguredRetryMemo;
  log: (line: string) => void;
  logError: (line: string) => void;
}): Promise<AllowOnceOutcome | "none"> {
  if (args.memo !== undefined && args.memo.doneNonce === args.opts.nonce) return "none";
  const done = (outcome: AllowOnceOutcome | "none"): AllowOnceOutcome | "none" => {
    if (args.memo !== undefined && outcome !== "failed") args.memo.doneNonce = args.opts.nonce;
    return outcome;
  };
  let rule: AgentRule;
  let ledger: Uint8Array | null;
  try {
    const [mandateData, ledgerData] = await args.readAccounts([args.mandate, args.ledger]);
    if (mandateData === null || mandateData === undefined) return done("none");
    rule = decodeAgentRule(args.coder, args.mandate, Buffer.from(mandateData));
    ledger = ledgerData ?? null;
  } catch (err) {
    args.logError(`agent rule ${args.mandate.toBase58()} allow-one check failed: ${describe(err)}`);
    return "none";
  }
  if (!hasPendingAllowOnce(rule)) return done("none");
  const result = await retryAllowOnce({
    rule,
    ledger,
    opts: args.opts,
    submit: args.submit,
    log: args.log,
    logError: args.logError,
  });
  return done(result.outcome);
}

/** The lowest owed nonce whose configured-rule retry check already ran in this process. */
export type ConfiguredRetryMemo = { doneNonce: bigint | null };

/** Send the retry for one rule and write one log line. Never throws; a rate
 * limit comes back as `rateLimited` so the caller can end its pass. */
export async function retryAllowOnce(args: {
  rule: AgentRule;
  ledger: Uint8Array | null;
  opts: AllowOnceOpts;
  submit: (rule: AgentRule, amount: bigint, nonce: bigint) => Promise<ChargeReceipt>;
  /** Runs just before the charge is sent, so the pause between charges happens only for a real send. */
  beforeSend?: () => Promise<void>;
  log: (line: string) => void;
  logError: (line: string) => void;
}): Promise<{ outcome: AllowOnceOutcome; rateLimited: boolean }> {
  const id = args.rule.address.toBase58();
  const plan = allowOnceRetry(args.rule, args.ledger, args.opts);
  if ("skip" in plan) {
    args.log(`agent rule ${id} allow-one retry skipped: ${plan.skip} nonce=${args.rule.overrideNonce.toString()}`);
    return { outcome: "skipped", rateLimited: false };
  }
  const detail = `amount=${plan.amount.toString()} nonce=${plan.nonce.toString()}`;
  try {
    await args.beforeSend?.();
    const receipt = await args.submit(args.rule, plan.amount, plan.nonce);
    if (receipt.decision === "paid") {
      args.log(`agent rule ${id} allow-one retry paid ${detail} sig=${receipt.signature || "-"}`);
      return { outcome: "paid", rateLimited: false };
    }
    args.log(`agent rule ${id} allow-one retry refused reason=${receipt.reason} ${detail} sig=${receipt.signature || "-"}`);
    return { outcome: "refused", rateLimited: false };
  } catch (err) {
    args.logError(`agent rule ${id} allow-one retry failed ${detail}: ${describe(err)}`);
    return { outcome: "failed", rateLimited: isRateLimitError(err) };
  }
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

/** Quote gaps that a later read in the same slot cannot change. */
const SETTLED_QUOTE_REASONS = new Set(["negative price", "zero amount", "window start does not match slot"]);

/** True when this slot's pass is over for this process: it was quoted, or the
 * price gap is one a retry would only repeat. Feed and FX outages stay open,
 * and so does a pass that a transient ledger read failure ended before any charge. */
export function agentRulesSlotSettled(
  summary: Pick<AgentRulesSummary, "quoted" | "quoteReason"> & Partial<Pick<AgentRulesSummary, "unfinished">>,
): boolean {
  if (summary.unfinished === true) return false;
  if (summary.quoted) return true;
  return summary.quoteReason !== null && SETTLED_QUOTE_REASONS.has(summary.quoteReason);
}

export type AgentRulesDeps = {
  discover: () => Promise<AgentRule[]>;
  /** Ledger account bytes for each rule, in order. Null when the ledger is missing. */
  readLedgers: (rules: readonly AgentRule[]) => Promise<(Uint8Array | null)[]>;
  submit: (rule: AgentRule, amount: bigint, nonce: bigint) => Promise<ChargeReceipt>;
  quote: (at: Date) => Promise<SlotQuote>;
};

export type AgentRulesSummary = {
  /** False when the slot had no chargeable price, so no slot charge was sent. */
  quoted: boolean;
  /** Why the slot had no chargeable price. Null when it was quoted. */
  quoteReason: string | null;
  found: number;
  /** Charges sent: allow-one retries and slot charges together. */
  charged: number;
  /** Allow-one retries sent. Their outcomes also count in paid, refused and failed. */
  retried: number;
  paid: number;
  refused: number;
  failed: number;
  skipped: number;
  /** True when a rate limit ended the pass before every selected rule was tried. */
  rateLimited: boolean;
  /** True when the pass time budget ended it before every selected rule was tried. */
  outOfTime: boolean;
  /** True when a transient ledger read failure ended the pass, so a later run in this slot should try again. */
  unfinished: boolean;
};

/** One pass: quote the slot, discover, retry what owners allowed once, then
 * charge each selected rule for this slot.
 *
 * An allowed request is retried before the slot charge of its rule: a paid
 * slot charge moves last_nonce past the allowed nonce, and the program then
 * refuses that nonce as stale. Paying the allowed request first moves
 * last_nonce to its nonce, which is below this slot's, so the slot charge
 * still goes through. Retries count toward `max`.
 *
 * Charges are sequential with a pause between them. A rule that throws is
 * logged and the next rule is still charged. A rate limit ends the pass,
 * because every later rule would hit the same endpoint; the rules left over
 * are charged on the next slot.
 *
 * Without a price the pass makes no RPC request at all, retries included, so
 * an idle or outage cycle stays free; the retries wait for the priced pass.
 *
 * No new charge starts once `budgetMs` has passed since the pass began; the
 * rules left over are charged on the next slot. A ledger read that fails ends
 * the pass with its summary line; a transient failure marks it unfinished so a
 * later run in the same slot tries again.
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
  /** VETO_AGENT_PASS_BUDGET_MS. */
  budgetMs?: number;
  /** Milliseconds now. Tests pass a fake clock. */
  clock?: () => number;
  log: (line: string) => void;
  logError: (line: string) => void;
}): Promise<AgentRulesSummary> {
  const clock = args.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = args.budgetMs ?? DEFAULT_AGENT_PASS_BUDGET_MS;
  const summary: AgentRulesSummary = {
    quoted: false,
    quoteReason: null,
    found: 0,
    charged: 0,
    retried: 0,
    paid: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
    rateLimited: false,
    outOfTime: false,
    unfinished: false,
  };
  const nonce = nonceFromSlot(args.slot);
  const nowUnix = BigInt(Math.floor(args.now.getTime() / 1000));
  const quote = await args.deps.quote(args.slot);
  if (!quote.ok) {
    summary.quoteReason = quote.reason;
    args.log(`agent rules: no charge this slot nonce=${nonce.toString()} reason=${quote.reason}`);
    return summary;
  }
  summary.quoted = true;

  const rules = await args.deps.discover();
  summary.found = rules.length;

  const delayMs = args.delayMs ?? AGENT_RULE_DELAY_MS;
  const pause = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let sent = 0;
  const beforeSend = async (): Promise<void> => {
    if (sent > 0) await pause(delayMs);
    sent += 1;
  };
  /** True once the budget is spent. Logs one line the first time. */
  const outOfTime = (): boolean => {
    if (summary.outOfTime) return true;
    const elapsed = clock() - startedAt;
    if (elapsed < budgetMs) return false;
    summary.outOfTime = true;
    args.logError(
      `agent rules: pass time budget of ${budgetMs} ms reached after ${elapsed} ms, the rest wait for the next slot nonce=${nonce.toString()}`,
    );
    return true;
  };
  const finish = (): AgentRulesSummary => {
    args.log(
      `agent rules: found=${summary.found} charged=${summary.charged} retried=${summary.retried} paid=${summary.paid} refused=${summary.refused} failed=${summary.failed} skipped=${summary.skipped} nonce=${nonce.toString()}`,
    );
    return summary;
  };

  // Allow-one retries first, at most `max` of them, rotated by slot like the
  // slot charges. Only an allow this agent could send now takes a place: a
  // rule it cannot charge, or one whose allowed request is later than this
  // slot, would otherwise hold a place every slot and keep a real retry out.
  const opts = { agent: args.agent, mint: args.mint, merchant: args.merchant, nowUnix, nonce };
  const seen = new Set<string>();
  const pending: AgentRule[] = [];
  for (const rule of rules) {
    const id = rule.address.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    if (rule.address.equals(args.configured) || !hasPendingAllowOnce(rule)) continue;
    if (unusableReason(rule, opts) !== null || rule.overrideNonce > nonce) continue;
    pending.push(rule);
  }
  const { selected: retryRules, over } = rotateBySlot(pending, nonce, args.max);
  for (const rule of over) {
    args.log(`agent rule ${rule.address.toBase58()} allow-one retry skipped: over the per-run cap`);
  }
  if (retryRules.length > 0) {
    let ledgers: (Uint8Array | null)[];
    try {
      ledgers = await args.deps.readLedgers(retryRules);
    } catch (err) {
      // Going on to the slot charges would move last_nonce past each allowed
      // request and strand it, so the pass ends here.
      args.logError(`agent rules: ledger read for allow-one retries failed, no rule charged this pass: ${describe(err)}`);
      summary.rateLimited = isRateLimitError(err);
      summary.unfinished = isTransientRpcError(err);
      return finish();
    }
    for (let i = 0; i < retryRules.length; i += 1) {
      if (outOfTime()) return finish();
      const result = await retryAllowOnce({
        rule: retryRules[i]!,
        ledger: ledgers[i] ?? null,
        opts,
        submit: args.deps.submit,
        beforeSend,
        log: args.log,
        logError: args.logError,
      });
      if (result.outcome === "skipped") continue;
      summary.charged += 1;
      summary.retried += 1;
      summary[result.outcome] += 1;
      if (result.rateLimited) {
        summary.rateLimited = true;
        args.logError("agent rules: rpc rate limited, the rest wait for the next slot");
        return finish();
      }
    }
  }

  const { selected, skipped } = selectAgentRules(rules, {
    agent: args.agent,
    mint: args.mint,
    merchant: args.merchant,
    configured: args.configured,
    nowUnix,
    nonce,
    max: Math.max(0, args.max - summary.retried),
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
      summary.unfinished = isTransientRpcError(err);
      return finish();
    }
  }

  for (let i = 0; i < selected.length; i += 1) {
    const rule = selected[i]!;
    const id = rule.address.toBase58();
    const ledger = ledgers[i] ?? null;
    if (ledger !== null && recordedFromLedgerBytes(ledger, nonce) !== null) {
      args.log(`agent rule ${id} skipped: already decided this slot`);
      summary.skipped += 1;
      continue;
    }
    if (outOfTime()) break;
    await beforeSend();
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
  return finish();
}


function describe(err: unknown): string {
  return redactRpcUrlsInText(err instanceof Error ? err.message : String(err));
}

/** VETO_AGENT_PASS_BUDGET_MS. Unset is the default; the value is a positive whole number of milliseconds. */
export function parseAgentPassBudgetMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_AGENT_PASS_BUDGET_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) === 0) {
    throw new Error(`config.loadConfig: VETO_AGENT_PASS_BUDGET_MS must be a positive whole number, got ${trimmed}`);
  }
  return Number.parseInt(trimmed, 10);
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
