import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  buffersEqual,
  CHARGE_IX_DISC,
  KIND_PAID,
  PAID_EVENT_DISC,
  TRADED_EVENT_DISC,
  TRADE_IX_DISC,
  TRADE_REFUSED_EVENT_DISC,
  reasonText,
  readU64Le,
  REFUSED_EVENT_DISC,
} from "./constants.js";
import type { CompiledIx, Decision, DecisionKind, TxView } from "./types.js";

const PROGRAM_DATA = /^Program data: ([A-Za-z0-9+/=]+)$/;
const PROGRAM_INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/;
const PROGRAM_END = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed\b.*)$/;

// Solana writes one frame per program: "Program <id> invoke [n]" ... "Program <id> success"
// or "Program <id> failed". Program log and Program data lines belong to whichever
// program is on top of that stack. A sibling instruction (an SPL Memo before charge,
// a CPI into another program) cannot supply a VETO line or a Paid event.
// A trace with no invoke line was not written by the runtime. It carries no
// attributable decision for verification. Callers that still have a bare
// "Program log:" or "Program data:" line wrap it in a frame first.
export function linesForProgram(logs: readonly string[], programId: string): readonly string[] {
  let framed = false;
  for (const line of logs) {
    if (PROGRAM_INVOKE.test(line)) {
      framed = true;
      break;
    }
  }
  if (!framed) return [];
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of logs) {
    const invoke = PROGRAM_INVOKE.exec(line);
    if (invoke?.[1]) {
      stack.push(invoke[1]);
      continue;
    }
    const ended = PROGRAM_END.exec(line);
    if (ended?.[1] && stack.length > 0 && stack[stack.length - 1] === ended[1]) {
      stack.pop();
      continue;
    }
    if (!line.startsWith("Program log:") && !line.startsWith("Program data:")) continue;
    if (stack.length > 0 && stack[stack.length - 1] === programId) out.push(line);
  }
  return out;
}

export type DecodedEvent = {
  vault?: string;
  owner?: string;
  destination?: string;
  rule?: string;
  amountIn?: bigint;
  amountOut?: bigint;
  minOut?: bigint;
  kind: DecisionKind;
  kindCode: number;
  mandate: string;
  amount: bigint;
  nonce: bigint;
  reason: number;
  suggestedOverride: bigint;
};

export function decodeEventsFromLogs(logs: readonly string[], programId?: string): DecodedEvent[] {
  const source = programId === undefined ? logs : linesForProgram(logs, programId);
  const out: DecodedEvent[] = [];
  for (const line of source) {
    const match = PROGRAM_DATA.exec(line);
    if (!match?.[1]) continue;
    const raw = Buffer.from(match[1], "base64");
    const event = decodeEventBytes(raw);
    if (event) out.push(event);
  }
  return out;
}

export function decodeEventBytes(raw: Uint8Array): DecodedEvent | null {
  if (raw.length < 8) return null;
  const disc = raw.subarray(0, 8);
  for (const [name, kind] of [["HoldMigrated", "hold_migrated"], ["HoldClosed", "hold_closed"]] as const) {
    if (!buffersEqual(disc, createHash("sha256").update(`event:${name}`).digest().subarray(0, 8))) continue;
    if (raw.length !== 112) return null;
    const vault = new PublicKey(raw.subarray(8, 40)).toBase58();
    return { vault, mandate: vault, owner: new PublicKey(raw.subarray(40, 72)).toBase58(),
      amount: readU64Le(raw, 72), destination: new PublicKey(raw.subarray(80, 112)).toBase58(),
      kind, kindCode: kind === "hold_migrated" ? 14 : 15, nonce: 0n, reason: 0, suggestedOverride: 0n };
  }
  const traded = buffersEqual(disc, TRADED_EVENT_DISC);
  const refusedTrade = buffersEqual(disc, TRADE_REFUSED_EVENT_DISC);
  if (traded || refusedTrade) {
    if (raw.length !== (traded ? 72 : 73)) return null;
    const rule = new PublicKey(raw.subarray(8, 40)).toBase58();
    return {
      rule, mandate: rule, kind: traded ? "traded" : "refused", kindCode: traded ? 1 : 2,
      amount: readU64Le(raw, 40), amountIn: readU64Le(raw, 40),
      amountOut: traded ? readU64Le(raw, 48) : 0n,
      ...(refusedTrade ? { minOut: readU64Le(raw, 48) } : {}),
      nonce: readU64Le(raw, 56), reason: traded ? 0 : raw[64]!,
      suggestedOverride: traded ? 0n : readU64Le(raw, 65),
    };
  }
  if (buffersEqual(disc, PAID_EVENT_DISC)) {
    if (raw.length < 64) return null;
    return {
      kind: "paid",
      kindCode: KIND_PAID,
      mandate: new PublicKey(raw.subarray(8, 40)).toBase58(),
      amount: readU64Le(raw, 40),
      nonce: readU64Le(raw, 48),
      reason: 0,
      suggestedOverride: 0n,
    };
  }
  if (buffersEqual(disc, REFUSED_EVENT_DISC)) {
    if (raw.length < 65) return null;
    return {
      kind: "refused",
      kindCode: 2,
      mandate: new PublicKey(raw.subarray(8, 40)).toBase58(),
      amount: readU64Le(raw, 40),
      nonce: readU64Le(raw, 48),
      reason: raw[56] ?? 0,
      suggestedOverride: readU64Le(raw, 57),
    };
  }
  return null;
}

export function decodeIxData(data: string | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  try {
    return Buffer.from(bs58.decode(data));
  } catch {
    return Buffer.alloc(0);
  }
}

export function isChargeIx(ix: CompiledIx): boolean {
  return ix.data.length >= 8 && buffersEqual(ix.data.subarray(0, 8), CHARGE_IX_DISC);
}

export function counterpartyFromCharge(tx: TxView, mandate: string): string {
  for (const ix of tx.instructions) {
    if (!isChargeIx(ix)) continue;
    if (ix.accounts.length < 5) continue;
    if (ix.accounts[1] === mandate || ix.accounts.includes(mandate)) {
      return ix.accounts[4] ?? "";
    }
  }
  const charge = tx.instructions.find(isChargeIx);
  return charge?.accounts[4] ?? "";
}

const LOG_TRUNCATED = "Log truncated";

// The runtime appends this exact line when it drops the rest of the log.
// A program cannot write it: its own lines are prefixed with "Program log:".
export function decisionLogTruncated(decisions: readonly Decision[]): boolean {
  return (decisions as { truncated?: boolean }).truncated === true;
}

function markTruncation(tx: TxView, decisions: Decision[]): Decision[] {
  if (tx.logs.includes(LOG_TRUNCATED)) {
    Object.defineProperty(decisions, "truncated", { value: true });
  }
  return decisions;
}

export function decisionsFromTx(tx: TxView, programId: string, mandateFilter?: string): Decision[] {
  if (tx.err) return [];
  const events = decodeEventsFromLogs(tx.logs, programId);
  if (events.length > 0) {
    const out: Decision[] = [];
    for (const event of events) {
      if (mandateFilter && event.mandate !== mandateFilter) continue;
      const trade = event.rule ? tx.instructions.find(ix =>
        ix.programId === programId && ix.accounts[1] === event.rule &&
        ix.data.length === 32 && ix.data.subarray(0, 8).equals(TRADE_IX_DISC) &&
        readU64Le(ix.data, 8) === event.amountIn && readU64Le(ix.data, 24) === event.nonce,
      ) : undefined;
      out.push({
        ...(event.rule ? { rule: event.rule, amountIn: event.amountIn, amountOut: event.amountOut, minOut: event.minOut ?? (trade ? readU64Le(trade.data, 16) : undefined) } : {}),
        ...(event.vault ? { vault: event.vault, owner: event.owner, destination: event.destination } : {}),
        signature: tx.signature,
        slot: tx.slot,
        timestamp: tx.blockTime,
        mandate: event.mandate,
        amount: event.amount,
        nonce: event.nonce,
        // Reason 12 may name any of seven pool accounts. The event does not
        // carry which one differed, so history must not guess it from the pool.
        counterparty: event.destination ?? (event.rule
          ? (event.reason === 12 ? "" : trade?.accounts[event.reason === 11 ? 4 : 6] ?? "")
          : counterpartyFromCharge(tx, event.mandate)),
        kind: event.kind,
        reason: event.reason,
        reasonText: event.rule && event.reason === 1 ? "rule not active" : event.rule && event.reason === 5 ? "over per-trade maximum" : reasonText(event.reason),
        suggestedOverride: event.suggestedOverride,
      });
    }
    return markTruncation(tx, out);
  }
  const fromLog = decisionFromChargeLog(tx, programId);
  if (!fromLog) return markTruncation(tx, []);
  if (mandateFilter && fromLog.mandate !== mandateFilter) return markTruncation(tx, []);
  return markTruncation(tx, [fromLog]);
}

// A charge that landed before event logs were available, or a fixture that
// only kept the text line, still names one decision. Program data wins when
// both are present, so a normal charge is not counted twice.
function decisionFromChargeLog(tx: TxView, programId: string): Decision | null {
  const parsed = parseVetoTextLog(tx.logs, programId);
  if (!parsed) return null;
  const charge = tx.instructions.find(
    (ix) => ix.programId === programId && isChargeIx(ix) && ix.accounts.length >= 5 && ix.data.length >= 24,
  );
  if (!charge) return null;
  const amount = readU64Le(charge.data, 8);
  const nonce = readU64Le(charge.data, 16);
  if (amount !== parsed.amount) return null;
  const mandate = charge.accounts[1] ?? "";
  if (mandate.length === 0) return null;
  return {
    signature: tx.signature,
    slot: tx.slot,
    timestamp: tx.blockTime,
    mandate,
    amount,
    nonce,
    counterparty: charge.accounts[4] ?? "",
    kind: parsed.kind,
    reason: parsed.reason,
    reasonText: reasonText(parsed.reason),
    suggestedOverride: parsed.suggestedOverride,
  };
}

function parseVetoTextLog(
  logs: readonly string[],
  programId: string,
): {
  kind: DecisionKind;
  reason: number;
  amount: bigint;
  suggestedOverride: bigint;
} | null {
  for (const line of linesForProgram(logs, programId)) {
    const paid = /VETO PAID amount=(\d+)/.exec(line);
    if (paid?.[1]) {
      return { kind: "paid", reason: 0, amount: BigInt(paid[1]), suggestedOverride: 0n };
    }
    const refused = /VETO REFUSED reason=(\d+) \([^)]*\) amount=(\d+).*override_to_clear=(\d+)/.exec(line);
    if (refused?.[1] && refused[2] && refused[3]) {
      return {
        kind: "refused",
        reason: Number.parseInt(refused[1], 10),
        amount: BigInt(refused[2]),
        suggestedOverride: BigInt(refused[3]),
      };
    }
  }
  return null;
}

export function encodePaidLog(args: {
  mandate: PublicKey;
  amount: bigint;
  nonce: bigint;
  spent: bigint;
}): string {
  const raw = Buffer.concat([
    PAID_EVENT_DISC,
    args.mandate.toBuffer(),
    u64(args.amount),
    u64(args.nonce),
    u64(args.spent),
  ]);
  return `Program data: ${raw.toString("base64")}`;
}

export function encodeRefusedLog(args: {
  mandate: PublicKey;
  amount: bigint;
  nonce: bigint;
  reason: number;
  suggestedOverride: bigint;
}): string {
  const raw = Buffer.concat([
    REFUSED_EVENT_DISC,
    args.mandate.toBuffer(),
    u64(args.amount),
    u64(args.nonce),
    Buffer.from([args.reason & 0xff]),
    u64(args.suggestedOverride),
  ]);
  return `Program data: ${raw.toString("base64")}`;
}

function u64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}
