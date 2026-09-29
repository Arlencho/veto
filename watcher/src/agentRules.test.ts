import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import anchorPkg from "@coral-xyz/anchor";
import { Keypair, PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import {
  agentRulesSlotSettled,
  chargeAgentRules,
  decodeAgentRule,
  DEFAULT_AGENT_RULES_MAX,
  discoverAgentRules,
  MANDATE_AGENT_OFFSET,
  parseAgentRulesMax,
  quoteSlotAmount,
  selectAgentRules,
  type AgentRule,
  type AgentRulesDeps,
  type MandateCoder,
  type ProgramAccountsReader,
} from "./agentRules.js";
import type { ChargeReceipt } from "./chain.js";
import { ledgerPda, loadIdl, RULE_CHARGE_TIMEOUT_MS, submitRuleCharge, TOKEN_PROGRAM_ID } from "./chain.js";
import type { Veto } from "./idl.js";
import { WATCHER_DIR } from "./config.js";
import type { PriceFeed } from "./feed.js";
import { nonceFromSlot } from "./nonce.js";
import { RateLimitedError } from "./rpc.js";

const { AnchorProvider, BN, BorshAccountsCoder, Program, Wallet } = anchorPkg;

const coder = new BorshAccountsCoder(loadIdl(join(WATCHER_DIR, "idl", "veto.json")) as never) as unknown as MandateCoder & {
  encode(name: string, value: unknown): Promise<Buffer>;
};

const PROGRAM = new PublicKey("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");
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
    status: 0,
    ...over,
  };
}

async function encodeRule(r: AgentRule): Promise<Buffer> {
  return coder.encode("Mandate", {
    owner: r.owner,
    agent: r.agent,
    mint: r.mint,
    source: r.source,
    merchant: r.merchant,
    mandate_id: new BN(r.mandateId.toString()),
    cap: new BN(r.cap.toString()),
    spent: new BN(r.spent.toString()),
    per_tx_max: new BN(r.perTxMax.toString()),
    expires_at: new BN(r.expiresAt.toString()),
    override_amount: new BN(0),
    override_nonce: new BN(0),
    last_nonce: new BN(r.lastNonce.toString()),
    purpose: "tester rule",
    status: r.status,
    spend_count: 0,
    refusal_count: 0,
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
    { memcmp: { offset: 0, bytes: coder.memcmp("Mandate").bytes } },
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
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const idl = loadIdl(join(WATCHER_DIR, "idl", "veto.json"));
  const program = new Program<Veto>({ ...idl, address: PROGRAM.toBase58() } as never, provider);
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
