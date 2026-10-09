import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import anchorPkg from "@coral-xyz/anchor";
import { Keypair, PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import {
  agentRulesSlotSettled,
  allowOnceRetry,
  chargeAgentRules,
  decodeAgentRule,
  DEFAULT_AGENT_PASS_BUDGET_MS,
  DEFAULT_AGENT_RULES_MAX,
  discoverAgentRules,
  MANDATE_ACCOUNT,
  MANDATE_AGENT_OFFSET,
  parseAgentPassBudgetMs,
  parseAgentRulesMax,
  quoteSlotAmount,
  retryConfiguredAllowOnce,
  selectAgentRules,
  type AgentRule,
  type AgentRulesDeps,
  type ConfiguredRetryMemo,
  type ProgramAccountsReader,
} from "./agentRules.js";
import type { ChargeReceipt } from "./chain.js";
import {
  findAllowOnceInLedgerBytes,
  ledgerPda,
  programFromIdl,
  RULE_CHARGE_TIMEOUT_MS,
  submitRuleCharge,
  TOKEN_PROGRAM_ID,
} from "./chain.js";
import { WATCHER_DIR } from "./config.js";
import type { PriceFeed } from "./feed.js";
import { nonceFromSlot } from "./nonce.js";
import { RateLimitedError } from "./rpc.js";

const { BN } = anchorPkg;

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
const IDL_PATH = join(WATCHER_DIR, "idl", "veto.json");

// The same construction index.ts runs through connect(): programFromIdl, then
// program.coder.accounts. A coder built any other way could disagree on the
// account name or field casing and pass here while production fails.
const coder = programFromIdl(
  {} as Connection,
  Keypair.generate(),
  IDL_PATH,
  PROGRAM.toBase58(),
).coder.accounts;
const AGENT = new PublicKey("6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w");
const MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const MERCHANT = new PublicKey("6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG");

const SLOT = new Date("2026-09-20T00:00:00+02:00");
const NONCE = nonceFromSlot(SLOT);
const NOW = new Date(SLOT.getTime() + 60_000);
const NOW_UNIX = BigInt(Math.floor(NOW.getTime() / 1000));

function key(): PublicKey {
  return Keypair.generate().publicKey;
}

function rule(over: Partial<AgentRule> = {}): AgentRule {
  return {
    address: key(),
    owner: key(),
    agent: AGENT,
    mint: MINT,
    source: key(),
    merchant: MERCHANT,
    mandateId: 1n,
    cap: 20_000_000n,
    spent: 0n,
    perTxMax: 500_000n,
    expiresAt: NOW_UNIX + 86_400n,
    lastNonce: 0n,
    overrideAmount: 0n,
    overrideNonce: 0n,
    status: 0,
    ...over,
  };
}

async function encodeRule(r: AgentRule): Promise<Buffer> {
  return coder.encode(MANDATE_ACCOUNT, {
    owner: r.owner,
    agent: r.agent,
    mint: r.mint,
    source: r.source,
    merchant: r.merchant,
    mandateId: new BN(r.mandateId.toString()),
    cap: new BN(r.cap.toString()),
    spent: new BN(r.spent.toString()),
    perTxMax: new BN(r.perTxMax.toString()),
    expiresAt: new BN(r.expiresAt.toString()),
    overrideAmount: new BN(r.overrideAmount.toString()),
    overrideNonce: new BN(r.overrideNonce.toString()),
    lastNonce: new BN(r.lastNonce.toString()),
    purpose: "tester rule",
    status: r.status,
    spendCount: 0,
    refusalCount: 0,
    bump: 255,
  });
}

const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);

/** A ledger ring with one row for `nonce`. kind 1 paid, 2 refused. */
function ledgerWith(nonce: bigint, kind: 1 | 2): Uint8Array {
  const buf = Buffer.alloc(8 + 40 + 32 * 72);
  LEDGER_DISCRIMINATOR.copy(buf, 0);
  buf.writeUInt32LE(1, 8 + 32);
  buf.writeUInt16LE(1, 8 + 36);
  const entry = 8 + 40;
  buf.writeBigUInt64LE(100_000n, entry + 8);
  buf.writeBigUInt64LE(nonce, entry + 48);
  buf.writeUInt8(kind, entry + 64);
  buf.writeUInt8(kind === 2 ? 5 : 0, entry + 65);
  return buf;
}

function selectOpts(configured: PublicKey = key(), max = 25) {
  return { agent: AGENT, mint: MINT, merchant: MERCHANT, configured, nowUnix: NOW_UNIX, nonce: NONCE, max };
}

function paid(signature = "sig"): ChargeReceipt {
  return { decision: "paid", reason: "ok", reasonCode: 0, suggestedOverride: null, signature };
}

function quoteOk(amount = 300_000n): AgentRulesDeps["quote"] {
  return async () => ({
    ok: true,
    amount,
    window: { timeStart: SLOT.toISOString(), timeEnd: SLOT.toISOString(), sekPerKwh: "0.5" },
  });
}

function runArgs(deps: AgentRulesDeps, configured: PublicKey, lines: string[], errs: string[], max = 25) {
  return {
    slot: SLOT,
    now: NOW,
    agent: AGENT,
    mint: MINT,
    merchant: MERCHANT,
    configured,
    max,
    deps,
    delayMs: 7,
    sleep: async () => {},
    log: (l: string) => lines.push(l),
    logError: (l: string) => errs.push(l),
  };
}

test("the agent memcmp offset is where the IDL layout puts the agent pubkey", async () => {
  const r = rule();
  const data = await encodeRule(r);
  assert.equal(MANDATE_AGENT_OFFSET, 40);
  assert.ok(data.subarray(MANDATE_AGENT_OFFSET, MANDATE_AGENT_OFFSET + 32).equals(AGENT.toBuffer()));
  const decoded = decodeAgentRule(coder, r.address, data);
  assert.ok(decoded.agent.equals(AGENT));
  assert.ok(decoded.source.equals(r.source));
  assert.equal(decoded.cap, r.cap);
  assert.equal(decoded.expiresAt, r.expiresAt);
  assert.equal(decoded.status, 0);
});

test("discovery asks the chain for Mandate accounts that name the agent, and drops rows that do not decode", async () => {
  const good = rule({ mandateId: 7n, lastNonce: 42n });
  const bad = key();
  let seenFilters: unknown;
  const connection: ProgramAccountsReader = {
    getProgramAccounts: (async (programId: PublicKey, config: { filters: unknown }) => {
      assert.ok(programId.equals(PROGRAM));
      seenFilters = config.filters;
      return [
        { pubkey: good.address, account: { data: await encodeRule(good) } },
        { pubkey: bad, account: { data: Buffer.alloc(12) } },
      ];
    }) as unknown as ProgramAccountsReader["getProgramAccounts"],
  };
  const logs: string[] = [];
  const found = await discoverAgentRules({ connection, programId: PROGRAM, agent: AGENT, coder, log: (l) => logs.push(l) });
  assert.deepEqual(seenFilters, [
    { memcmp: { offset: 0, bytes: coder.memcmp(MANDATE_ACCOUNT).bytes } },
    { memcmp: { offset: 40, bytes: AGENT.toBase58() } },
  ]);
  assert.equal(found.length, 1);
  assert.ok(found[0]!.address.equals(good.address));
  assert.equal(found[0]!.mandateId, 7n);
  assert.equal(found[0]!.lastNonce, 42n);
  assert.ok(logs.some((l) => l.includes(bad.toBase58()) && l.includes("does not decode")));
});

test("selection skips closed, expired, other-mint, other-payee, empty, already-paid and configured rules", () => {
  const configured = key();
  const open = rule();
  const cases: [AgentRule, string][] = [
    [rule({ address: configured }), "configured rule, charged on its own path"],
    [rule({ agent: key() }), "another agent"],
    [rule({ status: 1 }), "not open"],
    [rule({ status: 2 }), "not open"],
    [rule({ expiresAt: NOW_UNIX }), "expired"],
    [rule({ mint: key() }), "another mint"],
    [rule({ merchant: key() }), "another payee"],
    [rule({ spent: 20_000_000n }), "nothing left"],
    [rule({ lastNonce: NONCE }), "already paid this slot"],
    [rule({ lastNonce: NONCE + 21_600n }), "already paid this slot"],
  ];
  const { selected, skipped } = selectAgentRules([open, ...cases.map(([r]) => r)], selectOpts(configured));
  assert.deepEqual(selected.map((r) => r.address.toBase58()), [open.address.toBase58()]);
  for (const [r, reason] of cases) {
    const hit = skipped.find((s) => s.rule === r);
    assert.equal(hit?.reason, reason);
  }
});

test("a rule listed twice is selected once", () => {
  const r = rule();
  const { selected } = selectAgentRules([r, { ...r }], selectOpts());
  assert.equal(selected.length, 1);
});

test("the per-run cap bounds the selection and the rotation reaches every rule over a few slots", () => {
  const rules = Array.from({ length: 30 }, () => rule());
  const first = selectAgentRules(rules, selectOpts(key(), 25));
  assert.equal(first.selected.length, 25);
  assert.equal(first.skipped.filter((s) => s.reason === "over the per-run cap").length, 5);

  const reached = new Set<string>();
  for (let i = 0n; i < 3n; i += 1n) {
    const nonce = NONCE + i * 21_600n;
    const { selected } = selectAgentRules(rules, { ...selectOpts(key(), 25), nonce });
    assert.equal(selected.length, 25);
    for (const r of selected) reached.add(r.address.toBase58());
  }
  assert.equal(reached.size, 30);

  assert.equal(selectAgentRules(rules, selectOpts(key(), 0)).selected.length, 0);
});

test("VETO_AGENT_RULES_MAX defaults to 25, accepts 0 to turn the pass off, and refuses junk", () => {
  assert.equal(DEFAULT_AGENT_RULES_MAX, 25);
  assert.equal(parseAgentRulesMax(undefined), 25);
  assert.equal(parseAgentRulesMax(" "), 25);
  assert.equal(parseAgentRulesMax("0"), 0);
  assert.equal(parseAgentRulesMax("40"), 40);
  assert.throws(() => parseAgentRulesMax("-1"));
  assert.throws(() => parseAgentRulesMax("2.5"));
  assert.throws(() => parseAgentRulesMax("101"));
});

test("one failing rule does not stop the others, and charges are paused between", async () => {
  const rules = [rule(), rule(), rule()].sort((a, b) => (a.address.toBase58() < b.address.toBase58() ? -1 : 1));
  const tried: string[] = [];
  const pauses: number[] = [];
  const deps: AgentRulesDeps = {
    quote: quoteOk(),
    discover: async () => rules,
    readLedgers: async (rs) => rs.map(() => null),
    submit: async (r) => {
      tried.push(r.address.toBase58());
      if (r === rules[1]) throw new Error("boom from https://rpc.example.com/secret-key");
      if (r === rules[2]) {
        return { decision: "refused", reason: "over per-payment maximum", reasonCode: 5, suggestedOverride: 300_000n, signature: "rsig" };
      }
      return paid("psig");
    },
  };
  const lines: string[] = [];
  const errs: string[] = [];
  const summary = await chargeAgentRules({
    ...runArgs(deps, key(), lines, errs),
    sleep: async (ms: number) => {
      pauses.push(ms);
    },
  });
  assert.deepEqual(tried, rules.map((r) => r.address.toBase58()));
  assert.deepEqual(pauses, [7, 7]);
  assert.equal(summary.paid, 1);
  assert.equal(summary.refused, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.rateLimited, false);
  const id0 = rules[0]!.address.toBase58();
  const id2 = rules[2]!.address.toBase58();
  assert.ok(lines.some((l) => l.includes(`agent rule ${id0} paid amount=300000`) && l.includes("sig=psig")));
  assert.ok(lines.some((l) => l.includes(`agent rule ${id2} refused reason=over per-payment maximum`) && l.includes("sig=rsig")));
  const failLine = errs.find((l) => l.includes(rules[1]!.address.toBase58()));
  assert.ok(failLine !== undefined);
  assert.ok(!failLine.includes("secret-key"), "the RPC URL path is not logged");
});

test("a rate limit ends the pass and leaves the rest for the next slot", async () => {
  const rules = [rule(), rule(), rule()];
  let calls = 0;
  const deps: AgentRulesDeps = {
    quote: quoteOk(),
    discover: async () => rules,
    readLedgers: async (rs) => rs.map(() => null),
    submit: async () => {
      calls += 1;
      throw new RateLimitedError("429");
    },
  };
  const errs: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, key(), [], errs));
  assert.equal(calls, 1);
  assert.equal(summary.rateLimited, true);
  assert.ok(errs.some((l) => l.includes("rate limited")));
});

test("no price means no discovery and no charge", async () => {
  let discovered = false;
  const deps: AgentRulesDeps = {
    quote: async () => ({ ok: false, reason: "feed unavailable" }),
    discover: async () => {
      discovered = true;
      return [rule()];
    },
    readLedgers: async () => [],
    submit: async () => paid(),
  };
  const lines: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, key(), lines, []));
  assert.equal(summary.quoted, false);
  assert.equal(discovered, false);
  assert.ok(lines.some((l) => l.includes("reason=feed unavailable")));
});

test("the configured rule is never charged here, and a second run in the same slot charges nothing again", async () => {
  const configured = rule();
  const tester = rule();
  const refusedEarlier = rule();
  // Minimal chain: a paid charge moves last_nonce and writes a ring row, a
  // refusal writes a ring row only. Both are what the program does.
  const ledgers = new Map<string, Uint8Array>();
  ledgers.set(refusedEarlier.address.toBase58(), ledgerWith(NONCE, 2));
  const state = [configured, tester, refusedEarlier];
  const charged: string[] = [];
  const deps: AgentRulesDeps = {
    quote: quoteOk(),
    discover: async () => state.map((r) => ({ ...r })),
    readLedgers: async (rs) => rs.map((r) => ledgers.get(r.address.toBase58()) ?? null),
    submit: async (r, _amount, nonce) => {
      charged.push(r.address.toBase58());
      const live = state.find((s) => s.address.equals(r.address))!;
      live.lastNonce = nonce;
      ledgers.set(r.address.toBase58(), ledgerWith(nonce, 1));
      return paid();
    },
  };
  const lines: string[] = [];
  const first = await chargeAgentRules(runArgs(deps, configured.address, lines, []));
  assert.deepEqual(charged, [tester.address.toBase58()]);
  assert.equal(first.paid, 1);
  assert.ok(lines.some((l) => l.includes(configured.address.toBase58()) && l.includes("configured rule")));
  assert.ok(lines.some((l) => l.includes(refusedEarlier.address.toBase58()) && l.includes("already decided this slot")));

  const second = await chargeAgentRules(runArgs(deps, configured.address, [], []));
  assert.deepEqual(charged, [tester.address.toBase58()], "nothing is charged twice for one slot");
  assert.equal(second.charged, 0);
});

test("the discovered-rule amount is the configured rule's spot amount for the same window", async () => {
  const feed: PriceFeed = {
    async getWindow() {
      return { timeStart: "2026-09-20T00:00:00+02:00", timeEnd: "2026-09-20T00:15:00+02:00", sekPerKwh: "0.00892" };
    },
  };
  const q = await quoteSlotAmount({ at: SLOT, feed, kwhMilli: 50_000n, mintDecimals: 6, quoteCurrency: "SEK" });
  assert.deepEqual(q.ok && q.amount, 446_000n);

  const negative: PriceFeed = {
    async getWindow() {
      return { timeStart: "2026-09-20T00:00:00+02:00", timeEnd: "2026-09-20T00:15:00+02:00", sekPerKwh: "-0.01" };
    },
  };
  const n = await quoteSlotAmount({ at: SLOT, feed: negative, kwhMilli: 50_000n, mintDecimals: 6, quoteCurrency: "SEK" });
  assert.deepEqual(n, { ok: false, reason: "negative price" });

  const usdNoFx = await quoteSlotAmount({ at: SLOT, feed, kwhMilli: 6_000n, mintDecimals: 6, quoteCurrency: "USD" });
  assert.deepEqual(usdNoFx, { ok: false, reason: "fx unavailable" });
});

// submitRuleCharge against the real IDL program with a fake connection, so the
// instruction keys are the ones the program would see.
function fakeProgram(
  sendTransaction: (tx: Transaction) => Promise<string>,
  extra: Record<string, unknown> = {},
) {
  const connection = { sendTransaction, ...extra } as unknown as Connection;
  const payer = Keypair.generate();
  const program = programFromIdl(connection, payer, IDL_PATH, PROGRAM.toBase58());
  return { connection, program, payer };
}

test("submitRuleCharge charges the rule's own source into the configured merchant account", async () => {
  let sent: Transaction | null = null;
  const { connection, program, payer } = fakeProgram(async (tx) => {
    sent = tx;
    throw new Error("stop after capture");
  });
  const r = rule();
  const destination = key();
  await assert.rejects(
    submitRuleCharge({
      connection,
      program,
      programId: PROGRAM,
      agent: payer,
      mandate: r.address,
      source: r.source,
      destination,
      mint: MINT,
      amount: 300_000n,
      nonce: NONCE,
    }),
    /stop after capture/,
  );
  const ix = (sent as Transaction | null)?.instructions[0];
  assert.ok(ix !== undefined);
  assert.ok(ix.programId.equals(PROGRAM));
  assert.deepEqual(
    ix.keys.map((k) => k.pubkey.toBase58()),
    [
      payer.publicKey.toBase58(),
      r.address.toBase58(),
      ledgerPda(PROGRAM, r.address).toBase58(),
      r.source.toBase58(),
      destination.toBase58(),
      MINT.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ],
  );
  assert.equal(ix.data.readBigUInt64LE(8), 300_000n);
  assert.equal(ix.data.readBigUInt64LE(16), NONCE);
});

function pendingTimeouts(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

test("a charge that never confirms times out as failed, stops its confirm wait, and the next rule is still charged", async () => {
  let statusCalls = 0;
  const removed: number[] = [];
  const { connection, program, payer } = fakeProgram(async () => "stuck-sig", {
    onSignature: () => 7,
    removeSignatureListener: async (id: number) => {
      removed.push(id);
    },
    getSignatureStatus: async () => {
      statusCalls += 1;
      return { value: null };
    },
  });
  const timersBefore = pendingTimeouts();
  const rules = [rule(), rule()].sort((a, b) => (a.address.toBase58() < b.address.toBase58() ? -1 : 1));
  const charged: string[] = [];
  const deps: AgentRulesDeps = {
    quote: quoteOk(),
    discover: async () => rules,
    readLedgers: async (rs) => rs.map(() => null),
    submit: async (r, amount, nonce) => {
      charged.push(r.address.toBase58());
      if (r !== rules[0]) return paid("next");
      return submitRuleCharge({
        connection,
        program,
        programId: PROGRAM,
        agent: payer,
        mandate: r.address,
        source: r.source,
        destination: key(),
        mint: MINT,
        amount,
        nonce,
        timeoutMs: 50,
      });
    },
  };
  const errs: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, key(), [], errs));
  assert.equal(charged.length, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.paid, 1);
  assert.ok(errs.some((l) => l.includes(rules[0]!.address.toBase58()) && l.includes("not confirmed within 50ms")));
  assert.equal(RULE_CHARGE_TIMEOUT_MS, 90_000);

  // The losing confirm wait is torn down: the listener is removed once, and
  // polling stops after at most the poll sleep that was already running.
  assert.deepEqual(removed, [7]);
  const callsAtReject = statusCalls;
  assert.ok(callsAtReject >= 1);
  await new Promise((r) => setTimeout(r, 1_300));
  assert.equal(statusCalls, callsAtReject, "no status poll after the deadline");
  assert.equal(pendingTimeouts(), timersBefore, "no timer left pending");
});

test("a slot with a price gap a retry cannot change is settled; feed and fx outages stay open", () => {
  assert.equal(agentRulesSlotSettled({ quoted: true, quoteReason: null }), true);
  for (const reason of ["negative price", "zero amount", "window start does not match slot"]) {
    assert.equal(agentRulesSlotSettled({ quoted: false, quoteReason: reason }), true, reason);
  }
  for (const reason of ["feed unavailable", "fx unavailable", "fx rate stale (2026-09-10)", "unreadable price"]) {
    assert.equal(agentRulesSlotSettled({ quoted: false, quoteReason: reason }), false, reason);
  }
});

test("the running Program's coder names the account mandate and decodes camelCase fields", () => {
  assert.equal(MANDATE_ACCOUNT, "mandate");
  assert.throws(() => coder.memcmp("Mandate"), /Account not found: Mandate/);
  assert.equal(coder.memcmp(MANDATE_ACCOUNT).bytes, "L3ScUhMvnTK");
});

test("a recorded devnet mandate decodes through the running coder and is found by discovery", async () => {
  // Devnet mandate id 3, the same account bytes as sdk/fixtures/mandate-3.bin.
  const raw = readFileSync(fileURLToPath(new URL("./fixtures/mandate-3.bin", import.meta.url)));
  const address = key();
  const decoded = decodeAgentRule(coder, address, raw);
  assert.equal(decoded.owner.toBase58(), "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc");
  assert.ok(decoded.agent.equals(AGENT));
  assert.equal(decoded.mint.toBase58(), "2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU");
  assert.equal(decoded.source.toBase58(), "FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE");
  assert.ok(decoded.merchant.equals(MERCHANT));
  assert.equal(decoded.mandateId, 3n);
  assert.equal(decoded.cap, 300_000_000n);
  assert.equal(decoded.spent, 0n);
  assert.equal(decoded.perTxMax, 10_000_000n);
  assert.equal(decoded.expiresAt, 1_797_805_739n);
  assert.equal(decoded.lastNonce, 0n);
  assert.equal(decoded.status, 0);
  assert.ok(raw.subarray(MANDATE_AGENT_OFFSET, MANDATE_AGENT_OFFSET + 32).equals(AGENT.toBuffer()));

  const connection: ProgramAccountsReader = {
    getProgramAccounts: (async () => [{ pubkey: address, account: { data: raw } }]) as unknown as ProgramAccountsReader["getProgramAccounts"],
  };
  const logs: string[] = [];
  const found = await discoverAgentRules({ connection, programId: PROGRAM, agent: AGENT, coder, log: (l) => logs.push(l) });
  assert.equal(found.length, 1, logs.join("\n"));
  assert.equal(found[0]!.mandateId, 3n);
  // Old test mint, so selection skips it for the USDC watcher; it is still decoded, not dropped.
  const { skipped } = selectAgentRules(found, selectOpts());
  assert.equal(skipped[0]?.reason, "another mint");
});

// ---- Allow one: the agent retries the request the owner allowed ----

type Row = { kind: 1 | 2 | 3; nonce: bigint; amount: bigint; reason?: number };

/** A ledger ring written the way Ledger::record writes it (state.rs), oldest row first. */
function ledgerRows(rows: readonly Row[]): Uint8Array {
  const buf = Buffer.alloc(8 + 40 + 32 * 72);
  LEDGER_DISCRIMINATOR.copy(buf, 0);
  let head = 0;
  for (const row of rows) {
    const entry = 8 + 40 + head * 72;
    buf.fill(0, entry, entry + 72);
    buf.writeBigUInt64LE(row.amount, entry + 8);
    buf.writeBigUInt64LE(row.nonce, entry + 48);
    buf.writeUInt8(row.kind, entry + 64);
    buf.writeUInt8(row.reason ?? 0, entry + 65);
    head = (head + 1) % 32;
  }
  buf.writeUInt32LE(rows.length, 8 + 32);
  buf.writeUInt16LE(head, 8 + 36);
  return buf;
}

const PREV = NONCE - 21_600n;
const OVER_MAX = 5;

/** A tester rule whose PREV request was refused over the per-payment maximum and then allowed once. */
function allowedRule(over: Partial<AgentRule> = {}): { rule: AgentRule; rows: Row[] } {
  const r = rule({ perTxMax: 1_000_000n, overrideAmount: 1_200_000n, overrideNonce: PREV, ...over });
  const rows: Row[] = [
    { kind: 2, nonce: PREV, amount: 1_200_000n, reason: OVER_MAX },
    { kind: 3, nonce: PREV, amount: 1_200_000n },
  ];
  return { rule: r, rows };
}

/** The charge decision of lib.rs evaluate() and the paid branch of charge(),
 * enough of it to prove the order of a retry and a slot charge. */
function simulateChain(rules: AgentRule[], rows: Map<string, Row[]>) {
  const sent: { id: string; amount: bigint; nonce: bigint; decision: string }[] = [];
  const submit: AgentRulesDeps["submit"] = async (r, amount, nonce) => {
    const live = rules.find((s) => s.address.equals(r.address))!;
    const id = live.address.toBase58();
    const ring = rows.get(id) ?? [];
    const effective =
      live.overrideNonce !== 0n && live.overrideNonce === nonce && live.overrideAmount > live.perTxMax
        ? live.overrideAmount
        : live.perTxMax;
    let reason = 0;
    if (nonce <= live.lastNonce) reason = 3;
    else if (amount > effective) reason = OVER_MAX;
    else if (live.spent + amount > live.cap) reason = 6;
    if (reason === 0) {
      live.spent += amount;
      live.lastNonce = nonce;
      if (live.overrideNonce === nonce) {
        live.overrideNonce = 0n;
        live.overrideAmount = 0n;
      }
      ring.push({ kind: 1, nonce, amount });
    } else {
      ring.push({ kind: 2, nonce, amount, reason });
    }
    rows.set(id, ring);
    sent.push({ id, amount, nonce, decision: reason === 0 ? "paid" : "refused" });
    return reason === 0
      ? paid(`sig-${nonce.toString()}`)
      : { decision: "refused", reason: `code ${reason}`, reasonCode: reason, suggestedOverride: null, signature: "rsig" };
  };
  const deps: AgentRulesDeps = {
    quote: quoteOk(300_000n),
    discover: async () => rules.map((r) => ({ ...r })),
    readLedgers: async (rs) => rs.map((r) => ledgerRows(rows.get(r.address.toBase58()) ?? [])),
    submit,
  };
  return { deps, sent };
}

test("an allowed request is retried with its own nonce and refused amount, before the slot charge, and both pay", async () => {
  const { rule: r, rows } = allowedRule();
  const rules = [r];
  const ring = new Map([[r.address.toBase58(), rows]]);
  const { deps, sent } = simulateChain(rules, ring);
  const lines: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, key(), lines, []));
  const id = r.address.toBase58();
  assert.deepEqual(sent, [
    { id, amount: 1_200_000n, nonce: PREV, decision: "paid" },
    { id, amount: 300_000n, nonce: NONCE, decision: "paid" },
  ]);
  assert.equal(summary.retried, 1);
  assert.equal(summary.charged, 2);
  assert.equal(summary.paid, 2);
  const retryLines = lines.filter((l) => l.includes("allow-one retry"));
  assert.deepEqual(retryLines, [
    `agent rule ${id} allow-one retry paid amount=1200000 nonce=${PREV.toString()} sig=sig-${PREV.toString()}`,
  ]);
  assert.ok(lines.some((l) => l.includes("retried=1")));
  // The program cleared the override on the paid retry (lib.rs charge), so it is not pending any more.
  assert.equal(rules[0]!.overrideNonce, 0n);
});

test("the slot charge first would strand the allowed request: the program refuses it as stale", async () => {
  // The reason the pass retries first, shown on the same simulated chain.
  const { rule: r, rows } = allowedRule();
  const { deps, sent } = simulateChain([r], new Map([[r.address.toBase58(), rows]]));
  await deps.submit(r, 300_000n, NONCE);
  await deps.submit(r, 1_200_000n, PREV);
  assert.deepEqual(
    sent.map((s) => s.decision),
    ["paid", "refused"],
  );
});

test("a second pass after the retry paid sends nothing again, in the same slot or the next", async () => {
  const { rule: r, rows } = allowedRule();
  const rules = [r];
  const ring = new Map([[r.address.toBase58(), rows]]);
  const { deps, sent } = simulateChain(rules, ring);
  await chargeAgentRules(runArgs(deps, key(), [], []));
  assert.equal(sent.length, 2);
  const again = await chargeAgentRules(runArgs(deps, key(), [], []));
  assert.equal(sent.length, 2);
  assert.equal(again.retried, 0);
  const nextSlot = new Date(SLOT.getTime() + 21_600_000);
  const next = await chargeAgentRules({
    ...runArgs(deps, key(), [], []),
    slot: nextSlot,
    now: new Date(nextSlot.getTime() + 60_000),
  });
  assert.equal(next.retried, 0);
  assert.deepEqual(
    sent.slice(2).map((s) => s.nonce),
    [nonceFromSlot(nextSlot)],
  );
});

test("a used or stranded allow is not retried", async () => {
  const opts = { agent: AGENT, mint: MINT, merchant: MERCHANT, nowUnix: NOW_UNIX, nonce: NONCE };
  const cases: Partial<AgentRule>[] = [
    { overrideNonce: 0n, overrideAmount: 0n },
    { lastNonce: PREV },
    { lastNonce: PREV + 1n },
  ];
  for (const over of cases) {
    const { rule: r, rows } = allowedRule(over);
    assert.deepEqual(allowOnceRetry(r, ledgerRows(rows), opts), { skip: "no allow pending" });
  }

  const { rule: r, rows } = allowedRule({ lastNonce: PREV });
  const { deps, sent } = simulateChain([r], new Map([[r.address.toBase58(), rows]]));
  const summary = await chargeAgentRules(runArgs(deps, key(), [], []));
  assert.equal(summary.retried, 0);
  assert.deepEqual(
    sent.map((s) => s.nonce),
    [NONCE],
    "only the slot charge",
  );
});

test("no allow means no retry: the pass is the slot charge alone", async () => {
  const r = rule();
  const { deps, sent } = simulateChain([r], new Map());
  const lines: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, key(), lines, []));
  assert.deepEqual(
    sent.map((s) => s.nonce),
    [NONCE],
  );
  assert.equal(summary.retried, 0);
  assert.ok(!lines.some((l) => l.includes("allow-one")));
});

test("a refused retry is not sent again for the same allow; a new allow gets a new retry", () => {
  // The source ran dry: the retry is refused and the override stays set.
  const { rule: r, rows } = allowedRule();
  rows.push({ kind: 2, nonce: PREV, amount: 1_200_000n, reason: 8 });
  const opts = { agent: AGENT, mint: MINT, merchant: MERCHANT, nowUnix: NOW_UNIX, nonce: NONCE };
  assert.deepEqual(allowOnceRetry(r, ledgerRows(rows), opts), { skip: "already retried since the allow" });
  rows.push({ kind: 3, nonce: PREV, amount: 1_200_000n });
  assert.deepEqual(allowOnceRetry(r, ledgerRows(rows), opts), { nonce: PREV, amount: 1_200_000n });
});

test("the retry is not sent when the program would refuse it again or it would strand a charge", () => {
  const opts = { agent: AGENT, mint: MINT, merchant: MERCHANT, nowUnix: NOW_UNIX, nonce: NONCE };
  const plan = (over: Partial<AgentRule>, rows?: Row[]) => {
    const built = allowedRule(over);
    return allowOnceRetry(built.rule, ledgerRows(rows ?? built.rows), opts);
  };
  assert.deepEqual(plan({ overrideAmount: 1_100_000n }), { skip: "the refused amount is above the allowed amount" });
  assert.deepEqual(plan({ spent: 19_000_000n }), { skip: "over the remaining cap" });
  assert.deepEqual(plan({ overrideNonce: NONCE + 21_600n }), { skip: "the allowed request is later than this slot" });
  assert.deepEqual(plan({ status: 1 }), { skip: "not open" });
  assert.deepEqual(plan({ expiresAt: NOW_UNIX }), { skip: "expired" });
  assert.deepEqual(plan({}, []), { skip: "the allow is not in the ledger ring" });
  assert.deepEqual(plan({}, [{ kind: 3, nonce: PREV, amount: 1_200_000n }]), {
    skip: "no refused request for that nonce in the ledger ring",
  });
  assert.deepEqual(allowOnceRetry(allowedRule().rule, null, opts), { skip: "no ledger" });
  // An allow for this very slot is retried; the slot charge then sees the ring row and stays out.
  const same = allowedRule({ overrideNonce: NONCE });
  const rows: Row[] = [
    { kind: 2, nonce: NONCE, amount: 1_200_000n, reason: OVER_MAX },
    { kind: 3, nonce: NONCE, amount: 1_200_000n },
  ];
  assert.deepEqual(allowOnceRetry(same.rule, ledgerRows(rows), opts), { nonce: NONCE, amount: 1_200_000n });
});

test("the ring reader finds the allow after the ring wraps", () => {
  const filler: Row[] = Array.from({ length: 35 }, (_, i) => ({ kind: 1 as const, nonce: BigInt(i + 1), amount: 1n }));
  const rows: Row[] = [
    ...filler,
    { kind: 2, nonce: PREV, amount: 1_200_000n, reason: OVER_MAX },
    { kind: 3, nonce: PREV, amount: 1_200_000n },
  ];
  assert.deepEqual(findAllowOnceInLedgerBytes(ledgerRows(rows), PREV), {
    refused: { amount: 1_200_000n, reason: OVER_MAX, suggestedOverride: 0n },
    retried: false,
  });
  assert.equal(findAllowOnceInLedgerBytes(ledgerRows(filler), PREV), null);
});

test("a failing retry does not block its slot charge or other rules", async () => {
  const a = allowedRule();
  const b = allowedRule();
  const c = rule();
  const rules = [a.rule, b.rule, c];
  const ring = new Map([
    [a.rule.address.toBase58(), a.rows],
    [b.rule.address.toBase58(), b.rows],
  ]);
  const { deps, sent } = simulateChain(rules, ring);
  const failing = a.rule.address.toBase58();
  const inner = deps.submit;
  deps.submit = async (r, amount, nonce) => {
    if (r.address.toBase58() === failing && nonce === PREV) {
      throw new Error("boom at https://rpc.example.com/secret-key");
    }
    return inner(r, amount, nonce);
  };
  const errs: string[] = [];
  const pauses: number[] = [];
  const summary = await chargeAgentRules({
    ...runArgs(deps, key(), [], errs),
    sleep: async (ms: number) => {
      pauses.push(ms);
    },
  });
  assert.equal(summary.retried, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.paid, 4, "the other retry and all three slot charges");
  assert.deepEqual(
    sent
      .filter((s) => s.nonce === NONCE)
      .map((s) => s.id)
      .sort(),
    rules.map((r) => r.address.toBase58()).sort(),
  );
  assert.equal(pauses.length, 4, "a pause between every two sends");
  const failLine = errs.find((l) => l.includes(failing) && l.includes("allow-one retry failed"));
  assert.ok(failLine !== undefined);
  assert.ok(!failLine.includes("secret-key"), "the RPC URL path is not logged");
});

test("a rate-limited retry ends the pass", async () => {
  const { rule: r, rows } = allowedRule();
  const { deps } = simulateChain([r, rule()], new Map([[r.address.toBase58(), rows]]));
  let calls = 0;
  deps.submit = async () => {
    calls += 1;
    throw new RateLimitedError("429");
  };
  const summary = await chargeAgentRules(runArgs(deps, key(), [], []));
  assert.equal(summary.rateLimited, true);
  assert.equal(calls, 1);
  assert.equal(summary.charged, 1);
});

test("retries count toward the per-run cap and the configured rule is left to its own path", async () => {
  const a = allowedRule();
  const configured = allowedRule();
  const other = rule();
  const ring = new Map([
    [a.rule.address.toBase58(), a.rows],
    [configured.rule.address.toBase58(), configured.rows],
  ]);
  const { deps, sent } = simulateChain([a.rule, configured.rule, other], ring);
  const lines: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, configured.rule.address, lines, [], 1));
  assert.deepEqual(
    sent.map((s) => [s.id, s.nonce]),
    [[a.rule.address.toBase58(), PREV]],
  );
  assert.equal(summary.charged, 1);
  assert.ok(lines.some((l) => l.includes("over the per-run cap")));
});

test("without a price the allowed request waits for the priced pass and nothing is read", async () => {
  const { rule: r, rows } = allowedRule();
  const { deps, sent } = simulateChain([r], new Map([[r.address.toBase58(), rows]]));
  const quote = deps.quote;
  let discovered = 0;
  const discover = deps.discover;
  deps.discover = async () => {
    discovered += 1;
    return discover();
  };
  deps.quote = async () => ({ ok: false, reason: "feed unavailable" });
  const outage = await chargeAgentRules(runArgs(deps, key(), [], []));
  assert.equal(outage.retried, 0);
  assert.equal(discovered, 0);
  deps.quote = quote;
  const priced = await chargeAgentRules(runArgs(deps, key(), [], []));
  assert.equal(priced.retried, 1);
  assert.deepEqual(
    sent.map((s) => s.nonce),
    [PREV, NONCE],
  );
});

test("the configured rule's retry reads its mandate and ledger and charges its own source with the allowed nonce and amount", async () => {
  let sent: Transaction | null = null;
  const { connection, program, payer } = fakeProgram(async (tx) => {
    sent = tx;
    throw new Error("stop after capture");
  });
  const { rule: r, rows } = allowedRule({ agent: payer.publicKey });
  const ledger = ledgerPda(PROGRAM, r.address);
  const destination = key();
  const reads: string[][] = [];
  const errs: string[] = [];
  const outcome = await retryConfiguredAllowOnce({
    mandate: r.address,
    ledger,
    coder,
    readAccounts: async (addresses) => {
      reads.push(addresses.map((a) => a.toBase58()));
      return [await encodeRule(r), ledgerRows(rows)];
    },
    opts: { agent: payer.publicKey, mint: MINT, merchant: MERCHANT, nowUnix: NOW_UNIX, nonce: NONCE },
    submit: (rl, amount, nonce) =>
      submitRuleCharge({
        connection,
        program,
        programId: PROGRAM,
        agent: payer,
        mandate: rl.address,
        source: rl.source,
        destination,
        mint: MINT,
        amount,
        nonce,
      }),
    log: () => {},
    logError: (l) => errs.push(l),
  });
  assert.equal(outcome, "failed");
  assert.deepEqual(reads, [[r.address.toBase58(), ledger.toBase58()]]);
  const ix = (sent as Transaction | null)?.instructions[0];
  assert.ok(ix !== undefined);
  assert.deepEqual(
    ix.keys.map((k) => k.pubkey.toBase58()),
    [
      payer.publicKey.toBase58(),
      r.address.toBase58(),
      ledger.toBase58(),
      r.source.toBase58(),
      destination.toBase58(),
      MINT.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ],
  );
  assert.equal(ix.data.readBigUInt64LE(8), 1_200_000n);
  assert.equal(ix.data.readBigUInt64LE(16), PREV);
  assert.ok(errs.some((l) => l.includes("allow-one retry failed") && l.includes("stop after capture")));
});

test("the configured rule's check is silent with no allow, and a read failure does not throw", async () => {
  const r = rule();
  const lines: string[] = [];
  const errs: string[] = [];
  let submitted = false;
  const base = {
    mandate: r.address,
    ledger: ledgerPda(PROGRAM, r.address),
    coder,
    opts: { agent: AGENT, mint: MINT, merchant: MERCHANT, nowUnix: NOW_UNIX, nonce: NONCE },
    submit: async () => {
      submitted = true;
      return paid();
    },
    log: (l: string) => lines.push(l),
    logError: (l: string) => errs.push(l),
  };
  assert.equal(await retryConfiguredAllowOnce({ ...base, readAccounts: async () => [await encodeRule(r), null] }), "none");
  assert.equal(
    await retryConfiguredAllowOnce({
      ...base,
      readAccounts: async () => {
        throw new Error("down at https://rpc.example.com/secret-key");
      },
    }),
    "none",
  );
  assert.equal(submitted, false);
  assert.deepEqual(lines, []);
  assert.equal(errs.length, 1);
  assert.ok(!errs[0]!.includes("secret-key"));
});

test("a mandate's override fields decode through the running coder", async () => {
  const { rule: r } = allowedRule();
  const decoded = decodeAgentRule(coder, r.address, await encodeRule(r));
  assert.equal(decoded.overrideNonce, PREV);
  assert.equal(decoded.overrideAmount, 1_200_000n);
});

/** n rules whose addresses come out in ascending order. */
function sortedRules(n: number, over: Partial<AgentRule> = {}): AgentRule[] {
  return Array.from({ length: n }, () => rule(over)).sort((a, b) => (a.address.toBase58() < b.address.toBase58() ? -1 : 1));
}

test("final audit M1: rules holding far-future allows do not take the retry places from a real pending retry", async () => {
  // 31 addresses in order; the real allow gets the highest, so a list cut in
  // address order after 25 would leave it out.
  const addresses = sortedRules(31).map((r) => r.address);
  const crafted = addresses.slice(0, 30).map((address, i) =>
    rule({ address, perTxMax: 1_000_000n, overrideAmount: 1_200_000n, overrideNonce: NONCE + 21_600n * BigInt(i + 1) }),
  );
  const real = allowedRule({ address: addresses[30]! });
  const ring = new Map<string, Row[]>([[real.rule.address.toBase58(), real.rows]]);
  for (const r of crafted) {
    ring.set(r.address.toBase58(), [
      { kind: 2, nonce: r.overrideNonce, amount: 1_200_000n, reason: OVER_MAX },
      { kind: 3, nonce: r.overrideNonce, amount: 1_200_000n },
    ]);
  }
  const { deps, sent } = simulateChain([...crafted, real.rule], ring);
  const lines: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, key(), lines, []));
  const id = real.rule.address.toBase58();
  assert.equal(summary.retried, 1);
  assert.deepEqual(sent[0], { id, amount: 1_200_000n, nonce: PREV, decision: "paid" });
  assert.ok(!sent.some((s) => s.nonce > NONCE), "no future nonce is sent");
  assert.ok(!lines.some((l) => l.includes("allow-one retry skipped: over the per-run cap")));
});

test("final audit M1: unusable rules with a pending allow do not take retry places", async () => {
  const addresses = sortedRules(3).map((r) => r.address);
  const closed = allowedRule({ address: addresses[0]!, status: 1 });
  const otherPayee = allowedRule({ address: addresses[1]!, merchant: key() });
  const real = allowedRule({ address: addresses[2]! });
  const ring = new Map<string, Row[]>([
    [closed.rule.address.toBase58(), closed.rows],
    [otherPayee.rule.address.toBase58(), otherPayee.rows],
    [real.rule.address.toBase58(), real.rows],
  ]);
  const { deps, sent } = simulateChain([closed.rule, otherPayee.rule, real.rule], ring);
  const summary = await chargeAgentRules(runArgs(deps, key(), [], [], 1));
  assert.equal(summary.retried, 1);
  assert.deepEqual(
    sent.map((s) => [s.id, s.nonce]),
    [[real.rule.address.toBase58(), PREV]],
  );
});

test("final audit M1: retry places rotate by slot, so a pending allow is not shut out by one that never sends", async () => {
  // `stuck` keeps a pending allow it cannot send (over its remaining cap) and
  // sorts first. With one place, an address-order cut gives it the place every slot.
  const [first, second] = sortedRules(2).map((r) => r.address);
  const stuck = allowedRule({ address: first!, spent: 20_000_000n });
  const real = allowedRule({ address: second! });
  const retriedIn: number[] = [];
  for (let k = 0; k < 2; k += 1) {
    const slot = new Date(SLOT.getTime() + k * 21_600_000);
    const sent: { id: string; nonce: bigint }[] = [];
    const deps: AgentRulesDeps = {
      quote: async () => ({
        ok: true,
        amount: 300_000n,
        window: { timeStart: slot.toISOString(), timeEnd: slot.toISOString(), sekPerKwh: "0.5" },
      }),
      discover: async () => [{ ...stuck.rule }, { ...real.rule }],
      readLedgers: async (rs) => rs.map((r) => ledgerRows(r.address.equals(stuck.rule.address) ? stuck.rows : real.rows)),
      submit: async (r, _amount, nonce) => {
        sent.push({ id: r.address.toBase58(), nonce });
        return paid();
      },
    };
    await chargeAgentRules({ ...runArgs(deps, key(), [], [], 1), slot, now: new Date(slot.getTime() + 60_000) });
    if (sent.some((s) => s.id === real.rule.address.toBase58() && s.nonce === PREV)) retriedIn.push(k);
  }
  assert.equal(retriedIn.length, 1, "the real allow gets the place in one of two slots");
});

test("final audit M2: no new charge starts after the pass budget, with one log line, and the slot is settled", async () => {
  const rules = sortedRules(5);
  let now = 1_000_000;
  const tried: string[] = [];
  const deps: AgentRulesDeps = {
    quote: quoteOk(),
    discover: async () => rules,
    readLedgers: async (rs) => rs.map(() => null),
    submit: async (r) => {
      tried.push(r.address.toBase58());
      now += 400;
      return paid();
    },
  };
  const lines: string[] = [];
  const errs: string[] = [];
  const summary = await chargeAgentRules({
    ...runArgs(deps, key(), lines, errs),
    budgetMs: 1_000,
    clock: () => now,
  });
  assert.equal(tried.length, 3, "charges started at 0, 400 and 800 ms; the one at 1200 ms waits");
  assert.equal(summary.charged, 3);
  assert.equal(summary.outOfTime, true);
  const budgetLines = errs.filter((l) => l.includes("time budget"));
  assert.equal(budgetLines.length, 1);
  assert.ok(budgetLines[0]!.includes("the rest wait for the next slot"));
  assert.ok(lines.some((l) => l.startsWith("agent rules: found=5 charged=3")));
  assert.equal(agentRulesSlotSettled(summary), true);
});

test("final audit M2: the budget also stops allow-one retries", async () => {
  const a = allowedRule();
  const b = allowedRule();
  const ring = new Map([
    [a.rule.address.toBase58(), a.rows],
    [b.rule.address.toBase58(), b.rows],
  ]);
  const { deps, sent } = simulateChain([a.rule, b.rule], ring);
  let now = 0;
  const inner = deps.submit;
  deps.submit = async (r, amount, nonce) => {
    now += 2_000;
    return inner(r, amount, nonce);
  };
  const summary = await chargeAgentRules({ ...runArgs(deps, key(), [], []), budgetMs: 1_000, clock: () => now });
  assert.equal(sent.length, 1);
  assert.equal(summary.retried, 1);
  assert.equal(summary.outOfTime, true);
});

test("final audit M2: VETO_AGENT_PASS_BUDGET_MS defaults to 8 minutes and refuses junk", () => {
  assert.equal(DEFAULT_AGENT_PASS_BUDGET_MS, 480_000);
  assert.equal(parseAgentPassBudgetMs(undefined), 480_000);
  assert.equal(parseAgentPassBudgetMs(" "), 480_000);
  assert.equal(parseAgentPassBudgetMs("60000"), 60_000);
  assert.throws(() => parseAgentPassBudgetMs("0"));
  assert.throws(() => parseAgentPassBudgetMs("-5"));
  assert.throws(() => parseAgentPassBudgetMs("1.5"));
});

test("final audit L3: a transient ledger read failure logs the summary and leaves the slot open", async () => {
  const deps: AgentRulesDeps = {
    quote: quoteOk(),
    discover: async () => [rule(), rule()],
    readLedgers: async () => {
      throw new Error("failed to get info about accounts: TypeError: fetch failed at https://rpc.example.com/secret-key");
    },
    submit: async () => {
      throw new Error("must not send");
    },
  };
  const lines: string[] = [];
  const errs: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, key(), lines, errs));
  assert.equal(summary.charged, 0);
  assert.equal(summary.unfinished, true);
  assert.equal(agentRulesSlotSettled(summary), false);
  assert.ok(lines.some((l) => l.startsWith("agent rules: found=2 charged=0")));
  assert.ok(errs.every((l) => !l.includes("secret-key")));
});

test("final audit L3: a deterministic ledger read failure logs the summary and settles the slot", async () => {
  const deps: AgentRulesDeps = {
    quote: quoteOk(),
    discover: async () => [rule()],
    readLedgers: async () => {
      throw new Error("failed to get info about accounts: Invalid param: WrongSize");
    },
    submit: async () => paid(),
  };
  const lines: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, key(), lines, []));
  assert.equal(summary.unfinished, false);
  assert.equal(agentRulesSlotSettled(summary), true);
  assert.ok(lines.some((l) => l.startsWith("agent rules: found=1 charged=0")));
});

test("final audit L3: a failed ledger read for the retries ends the pass before any slot charge strands the allow", async () => {
  const { rule: r, rows } = allowedRule();
  const { deps, sent } = simulateChain([r, rule()], new Map([[r.address.toBase58(), rows]]));
  deps.readLedgers = async () => {
    throw new Error("socket hang up");
  };
  const lines: string[] = [];
  const summary = await chargeAgentRules(runArgs(deps, key(), lines, []));
  assert.deepEqual(sent, []);
  assert.equal(summary.unfinished, true);
  assert.equal(agentRulesSlotSettled(summary), false);
  assert.ok(lines.some((l) => l.startsWith("agent rules: found=2 charged=0")));
});

test("issue 389: the configured rule's retry check runs once per owed slot while the read answers", async () => {
  const r = rule();
  let reads = 0;
  let fail = false;
  const memo: ConfiguredRetryMemo = { doneNonce: null };
  const call = (nonce: bigint) =>
    retryConfiguredAllowOnce({
      mandate: r.address,
      ledger: ledgerPda(PROGRAM, r.address),
      coder,
      memo,
      readAccounts: async () => {
        reads += 1;
        if (fail) throw new Error("fetch failed");
        return [await encodeRule(r), null];
      },
      opts: { agent: AGENT, mint: MINT, merchant: MERCHANT, nowUnix: NOW_UNIX, nonce },
      submit: async () => paid(),
      log: () => {},
      logError: () => {},
    });
  await call(NONCE);
  await call(NONCE);
  await call(NONCE);
  assert.equal(reads, 1, "a gap that keeps the slot owed does not add a read per loop");
  await call(NONCE + 21_600n);
  assert.equal(reads, 2, "the next owed slot is checked again");
  fail = true;
  const later = NONCE + 43_200n;
  await call(later);
  await call(later);
  assert.equal(reads, 4, "a failed read is not recorded, so the next loop reads again");
  fail = false;
  await call(later);
  await call(later);
  assert.equal(reads, 5);
});

test("issue 389: a failed send of the configured rule's retry is tried again on the next loop", async () => {
  const { rule: r, rows } = allowedRule();
  const memo: ConfiguredRetryMemo = { doneNonce: null };
  let sends = 0;
  const call = () =>
    retryConfiguredAllowOnce({
      mandate: r.address,
      ledger: ledgerPda(PROGRAM, r.address),
      coder,
      memo,
      readAccounts: async () => [await encodeRule(r), ledgerRows(rows)],
      opts: { agent: AGENT, mint: MINT, merchant: MERCHANT, nowUnix: NOW_UNIX, nonce: NONCE },
      submit: async () => {
        sends += 1;
        if (sends === 1) throw new Error("fetch failed");
        return paid();
      },
      log: () => {},
      logError: () => {},
    });
  assert.equal(await call(), "failed");
  assert.equal(await call(), "paid");
  assert.equal(await call(), "none");
  assert.equal(sends, 2);
});
