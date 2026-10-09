import { readFileSync } from "node:fs";
import anchorPkg, { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
// BN is not exposed as a named export on the CommonJS build of anchor, so a
// named import of it is a SyntaxError on Node 22, which is the floor the
// READMEs document and the version CI runs. Node 26 accepts it, which is why
// this survived: every seat and every local run was on 26. Take BN off the
// default export, where it is present on both.
const { BN } = anchorPkg;
import type { Idl } from "@coral-xyz/anchor";
import type { Connection, VersionedTransactionResponse } from "@solana/web3.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { sendAndConfirm } from "./confirm.js";
import type { WatcherConfig } from "./config.js";
import type { Veto } from "./idl.js";
import { logLine } from "./log.js";
import { parseChargeLogs, type ChargeOutcome } from "./parse.js";
import { reasonText } from "./reasons.js";
import { createFailoverConnection, isRateLimitError } from "./rpc.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function u64Le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function mandatePda(programId: PublicKey, owner: PublicKey, mandateId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), owner.toBuffer(), u64Le(mandateId)],
    programId,
  );
  return pda;
}

export function ledgerPda(programId: PublicKey, mandate: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ledger"), mandate.toBuffer()],
    programId,
  );
  return pda;
}

export function loadIdl(path: string): Veto {
  return JSON.parse(readFileSync(path, "utf8")) as Veto;
}

export function connect(cfg: WatcherConfig, payer: Keypair): {
  connection: Connection;
  program: Program<Veto>;
  programId: PublicKey;
} {
  const connection = createFailoverConnection(cfg.rpcs, logLine, { timeoutMs: cfg.rpcTimeoutMs });
  const program = programFromIdl(connection, payer, cfg.idlPath, cfg.programId);
  return { connection, program, programId: new PublicKey(cfg.programId) };
}

/** The typed program the watcher runs with. Tests build theirs here too.
 *
 * The Program constructor rewrites the IDL to camelCase: its coder knows the
 * account as `mandate` (not the JSON's `Mandate`) and decodes fields such as
 * `lastNonce` and `perTxMax` (not `last_nonce`). */
export function programFromIdl(
  connection: Connection,
  payer: Keypair,
  idlPath: string,
  programId: string,
): Program<Veto> {
  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: false,
  });
  const idl = loadIdl(idlPath) as unknown as Idl;
  if (idl.address && idl.address !== programId) {
    idl.address = programId;
  }
  return new Program<Veto>(idl as unknown as Veto & Idl, provider);
}

export type ChargeReceipt = ChargeOutcome & { signature: string };

export type RecoveredCharge = ChargeReceipt & { amount: bigint };

const CHARGE_DISCRIMINATOR = Buffer.from([26, 55, 197, 209, 93, 77, 242, 15]);
const LEDGER_DISCRIMINATOR = Buffer.from([43, 41, 21, 213, 180, 176, 95, 32]);
const LEDGER_CAPACITY = 32;
const LEDGER_HEADER_SIZE = 40;
const ENTRY_SIZE = 72;
const KIND_PAID = 1;
const KIND_REFUSED = 2;
const KIND_OVERRIDE = 3;
const MANDATE_LAST_NONCE_OFFSET = 224;
const RECOVERED_SIGNATURE = "recovered-from-chain";

export async function submitCharge(args: {
  cfg: WatcherConfig;
  agent: Keypair;
  amount: bigint;
  nonce: bigint;
}): Promise<ChargeReceipt> {
  const { connection, program, programId } = connect(args.cfg, args.agent);
  const owner = new PublicKey(args.cfg.owner);
  const mandate = mandatePda(programId, owner, args.cfg.mandateId);
  const ledger = ledgerPda(programId, mandate);

  const lastNonce = await readLastNonceFromAccount(connection, mandate);
  if (args.nonce <= lastNonce) {
    const recovered = await recoverFromConnection(connection, programId, mandate, args.nonce);
    if (recovered !== null) return recovered;
    return {
      decision: "paid",
      reason: "chain shows this window paid; signature could not be recovered",
      reasonCode: 0,
      suggestedOverride: null,
      signature: "",
    };
  }

  const ix = await program.methods
    .charge(new BN(args.amount.toString()), new BN(args.nonce.toString()))
    .accountsPartial({
      agent: args.agent.publicKey,
      mandate,
      ledger,
      source: new PublicKey(args.cfg.ownerTokenAccount),
      destination: new PublicKey(args.cfg.merchantTokenAccount),
      mint: new PublicKey(args.cfg.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirm(connection, tx, [args.agent], {
    commitment: "confirmed",
  });
  const parsed = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = parsed?.meta?.logMessages ?? [];
  const outcome = parseChargeLogs(logs);
  return { ...outcome, signature };
}

export const RULE_CHARGE_TIMEOUT_MS = 90_000;

/** Charge one discovered rule. The source is the rule's own token account,
 * the destination is the configured merchant token account. The caller has
 * already checked last_nonce and the ledger ring for this nonce; the program
 * still refuses a stale nonce on its own. */
export async function submitRuleCharge(args: {
  connection: Connection;
  program: Program<Veto>;
  programId: PublicKey;
  agent: Keypair;
  mandate: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  mint: PublicKey;
  amount: bigint;
  nonce: bigint;
  /** The confirm wait gives up after this long, so one stuck rule cannot hold the pass. */
  timeoutMs?: number;
}): Promise<ChargeReceipt> {
  const ix = await args.program.methods
    .charge(new BN(args.amount.toString()), new BN(args.nonce.toString()))
    .accountsPartial({
      agent: args.agent.publicKey,
      mandate: args.mandate,
      ledger: ledgerPda(args.programId, args.mandate),
      source: args.source,
      destination: args.destination,
      mint: args.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  const tx = new Transaction().add(ix);
  // The confirm wait stops its own polling and listener at the deadline, so a
  // stuck charge cannot keep a `once` process alive.
  const signature = await sendAndConfirm(args.connection, tx, [args.agent], {
    commitment: "confirmed",
    timeoutMs: args.timeoutMs ?? RULE_CHARGE_TIMEOUT_MS,
  });
  const parsed = await args.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  let outcome: ChargeOutcome;
  try {
    outcome = parseChargeLogs(parsed?.meta?.logMessages ?? []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} sig=${signature}`);
  }
  return { ...outcome, signature };
}

export async function openMandate(args: {
  cfg: WatcherConfig;
  owner: Keypair;
  expiresAtUnix: bigint;
}): Promise<{ signature: string; mandate: string; ledger: string }> {
  const { connection, program, programId } = connect(args.cfg, args.owner);
  const ownerPk = args.owner.publicKey;
  const mandate = mandatePda(programId, ownerPk, args.cfg.mandateId);
  const ledger = ledgerPda(programId, mandate);

  const existing = await connection.getAccountInfo(mandate, "confirmed");
  if (existing !== null) {
    return { signature: "", mandate: mandate.toBase58(), ledger: ledger.toBase58() };
  }

  const ix = await program.methods
    .openMandate({
      mandateId: new BN(args.cfg.mandateId.toString()),
      agent: new PublicKey(args.cfg.agent),
      merchant: new PublicKey(args.cfg.merchant),
      cap: new BN(args.cfg.cap.toString()),
      perTxMax: new BN(args.cfg.perTxMax.toString()),
      expiresAt: new BN(args.expiresAtUnix.toString()),
      purpose: args.cfg.purpose,
    })
    .accountsPartial({
      owner: ownerPk,
      mandate,
      ledger,
      source: new PublicKey(args.cfg.ownerTokenAccount),
      mint: new PublicKey(args.cfg.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirm(connection, tx, [args.owner], {
    commitment: "confirmed",
  });
  return { signature, mandate: mandate.toBase58(), ledger: ledger.toBase58() };
}

export function decodeMandateLastNonce(data: Uint8Array): bigint {
  if (data.length < MANDATE_LAST_NONCE_OFFSET + 8) {
    throw new Error("mandate account too small to read last_nonce");
  }
  return Buffer.from(data.subarray(MANDATE_LAST_NONCE_OFFSET, MANDATE_LAST_NONCE_OFFSET + 8)).readBigUInt64LE(0);
}

async function readLastNonceFromAccount(connection: Connection, mandate: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(mandate, "confirmed");
  if (!info) throw new Error(`mandate ${mandate.toBase58()} not found`);
  return decodeMandateLastNonce(info.data);
}

export async function readLastNonce(args: {
  cfg: WatcherConfig;
  agent: Keypair;
}): Promise<bigint> {
  const { connection, programId } = connect(args.cfg, args.agent);
  const owner = new PublicKey(args.cfg.owner);
  const mandate = mandatePda(programId, owner, args.cfg.mandateId);
  return readLastNonceFromAccount(connection, mandate);
}

type RingPaid = { amount: bigint; suggestedOverride: bigint };

export function findPaidInLedgerBytes(data: Uint8Array, nonce: bigint): RingPaid | null {
  const minSize = 8 + LEDGER_HEADER_SIZE + ENTRY_SIZE;
  if (data.length < minSize) return null;
  if (!LEDGER_DISCRIMINATOR.equals(Buffer.from(data.subarray(0, 8)))) return null;
  const body = data.subarray(8);
  const total = Buffer.from(body.subarray(32, 36)).readUInt32LE(0);
  const head = Buffer.from(body.subarray(36, 38)).readUInt16LE(0);
  const occupied = Math.min(total, LEDGER_CAPACITY);
  const start = total >= LEDGER_CAPACITY ? head % LEDGER_CAPACITY : 0;
  for (let i = 0; i < occupied; i += 1) {
    const idx = (start + i) % LEDGER_CAPACITY;
    const off = LEDGER_HEADER_SIZE + idx * ENTRY_SIZE;
    const raw = body.subarray(off, off + ENTRY_SIZE);
    if (raw.length < ENTRY_SIZE) continue;
    const entryNonce = Buffer.from(raw.subarray(48, 56)).readBigUInt64LE(0);
    const kind = raw[64] ?? 0;
    if (entryNonce !== nonce || kind !== KIND_PAID) continue;
    return {
      amount: Buffer.from(raw.subarray(8, 16)).readBigUInt64LE(0),
      suggestedOverride: Buffer.from(raw.subarray(56, 64)).readBigUInt64LE(0),
    };
  }
  return null;
}

type RingRefused = { amount: bigint; reason: number; suggestedOverride: bigint };

/** Last refused ring row for this nonce. A paid row is not a refusal. */
export function findRefusedInLedgerBytes(data: Uint8Array, nonce: bigint): RingRefused | null {
  const minSize = 8 + LEDGER_HEADER_SIZE + ENTRY_SIZE;
  if (data.length < minSize) return null;
  if (!LEDGER_DISCRIMINATOR.equals(Buffer.from(data.subarray(0, 8)))) return null;
  const body = data.subarray(8);
  const total = Buffer.from(body.subarray(32, 36)).readUInt32LE(0);
  const head = Buffer.from(body.subarray(36, 38)).readUInt16LE(0);
  const occupied = Math.min(total, LEDGER_CAPACITY);
  const start = total >= LEDGER_CAPACITY ? head % LEDGER_CAPACITY : 0;
  let found: RingRefused | null = null;
  for (let i = 0; i < occupied; i += 1) {
    const idx = (start + i) % LEDGER_CAPACITY;
    const off = LEDGER_HEADER_SIZE + idx * ENTRY_SIZE;
    const raw = body.subarray(off, off + ENTRY_SIZE);
    if (raw.length < ENTRY_SIZE) continue;
    const entryNonce = Buffer.from(raw.subarray(48, 56)).readBigUInt64LE(0);
    const kind = raw[64] ?? 0;
    if (entryNonce !== nonce || kind !== KIND_REFUSED) continue;
    found = {
      amount: Buffer.from(raw.subarray(8, 16)).readBigUInt64LE(0),
      reason: raw[65] ?? 0,
      suggestedOverride: Buffer.from(raw.subarray(56, 64)).readBigUInt64LE(0),
    };
  }
  return found;
}

export type RingAllowOnce = {
  /** The refusal the owner allowed: the last refused row for the nonce before the allow. */
  refused: RingRefused | null;
  /** True when a refusal for the nonce was written after the allow, so the agent already retried it. */
  retried: boolean;
};

/** What the ring says about an "Allow one" (grant_override) for this nonce.
 *
 * Null when the ring holds no override row for the nonce. Rows are read
 * oldest first, and the last override row counts, so a second allow of the
 * same request gets its own retry.
 */
export function findAllowOnceInLedgerBytes(data: Uint8Array, nonce: bigint): RingAllowOnce | null {
  const minSize = 8 + LEDGER_HEADER_SIZE + ENTRY_SIZE;
  if (data.length < minSize) return null;
  if (!LEDGER_DISCRIMINATOR.equals(Buffer.from(data.subarray(0, 8)))) return null;
  const body = data.subarray(8);
  const total = Buffer.from(body.subarray(32, 36)).readUInt32LE(0);
  const head = Buffer.from(body.subarray(36, 38)).readUInt16LE(0);
  const occupied = Math.min(total, LEDGER_CAPACITY);
  const start = total >= LEDGER_CAPACITY ? head % LEDGER_CAPACITY : 0;
  let allowed = false;
  let refusedBefore: RingRefused | null = null;
  let lastRefused: RingRefused | null = null;
  let retried = false;
  for (let i = 0; i < occupied; i += 1) {
    const idx = (start + i) % LEDGER_CAPACITY;
    const off = LEDGER_HEADER_SIZE + idx * ENTRY_SIZE;
    const raw = body.subarray(off, off + ENTRY_SIZE);
    if (raw.length < ENTRY_SIZE) continue;
    const entryNonce = Buffer.from(raw.subarray(48, 56)).readBigUInt64LE(0);
    if (entryNonce !== nonce) continue;
    const kind = raw[64] ?? 0;
    if (kind === KIND_OVERRIDE) {
      allowed = true;
      refusedBefore = lastRefused;
      retried = false;
    } else if (kind === KIND_REFUSED) {
      lastRefused = {
        amount: Buffer.from(raw.subarray(8, 16)).readBigUInt64LE(0),
        reason: raw[65] ?? 0,
        suggestedOverride: Buffer.from(raw.subarray(56, 64)).readBigUInt64LE(0),
      };
      if (allowed) retried = true;
    }
  }
  if (!allowed) return null;
  return { refused: refusedBefore, retried };
}

/** Ring row for this nonce. A payment wins over a refusal of the same nonce. One account read, no history walk. */
export function recordedFromLedgerBytes(data: Uint8Array, nonce: bigint): RecoveredCharge | null {
  const paid = findPaidInLedgerBytes(data, nonce);
  if (paid !== null) {
    return {
      decision: "paid",
      reason: "ok",
      reasonCode: 0,
      suggestedOverride: paid.suggestedOverride === 0n ? null : paid.suggestedOverride,
      signature: RECOVERED_SIGNATURE,
      amount: paid.amount,
    };
  }
  const refused = findRefusedInLedgerBytes(data, nonce);
  if (refused === null) return null;
  return {
    decision: "refused",
    reason: reasonText(refused.reason),
    reasonCode: refused.reason,
    suggestedOverride: refused.suggestedOverride === 0n ? null : refused.suggestedOverride,
    signature: RECOVERED_SIGNATURE,
    amount: refused.amount,
  };
}

export async function readRecordedCharge(args: {
  cfg: WatcherConfig;
  agent: Keypair;
  nonce: bigint;
}): Promise<RecoveredCharge | null> {
  const { connection, programId } = connect(args.cfg, args.agent);
  const owner = new PublicKey(args.cfg.owner);
  const mandate = mandatePda(programId, owner, args.cfg.mandateId);
  const info = await connection.getAccountInfo(ledgerPda(programId, mandate), "confirmed");
  if (!info) return null;
  return recordedFromLedgerBytes(info.data, args.nonce);
}

export function chargeFromTx(
  tx: VersionedTransactionResponse,
  programId: PublicKey,
): { amount: bigint; nonce: bigint } | null {
  const msg = tx.transaction.message;
  const staticKeys = (
    "staticAccountKeys" in msg && Array.isArray(msg.staticAccountKeys)
      ? msg.staticAccountKeys
      : "accountKeys" in msg && Array.isArray((msg as { accountKeys?: PublicKey[] }).accountKeys)
        ? (msg as { accountKeys: PublicKey[] }).accountKeys
        : []
  );
  const loaded = tx.meta?.loadedAddresses;
  const keys = [
    ...staticKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ];
  const compiled =
    "compiledInstructions" in msg && Array.isArray(msg.compiledInstructions)
      ? msg.compiledInstructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          data: Buffer.from(ix.data),
        }))
      : [];
  for (const ix of compiled) {
    const pid = keys[ix.programIdIndex];
    if (!pid || !pid.equals(programId)) continue;
    if (ix.data.length < 24) continue;
    if (!ix.data.subarray(0, 8).equals(CHARGE_DISCRIMINATOR)) continue;
    return {
      amount: ix.data.readBigUInt64LE(8),
      nonce: ix.data.readBigUInt64LE(16),
    };
  }
  return null;
}

// Walk signatures that touched this mandate. Charge writes the mandate, so
// this is the paid history for this window without paging every other
// mandate's transactions. Used when the 32-entry ring has rolled past.
async function findPaidInHistory(
  connection: Connection,
  programId: PublicKey,
  mandate: PublicKey,
  nonce: bigint,
): Promise<RecoveredCharge | null> {
  let before: string | undefined;
  const pageSize = 200;
  for (let page = 0; page < 50; page += 1) {
    const sigs = await connection.getSignaturesForAddress(mandate, {
      limit: pageSize,
      before,
    });
    if (sigs.length === 0) break;
    for (const info of sigs) {
      if (info.err) continue;
      const tx = await connection.getTransaction(info.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;
      const charge = chargeFromTx(tx, programId);
      if (charge === null || charge.nonce !== nonce) continue;
      const logs = tx.meta?.logMessages ?? [];
      try {
        const outcome = parseChargeLogs(logs);
        if (outcome.decision !== "paid") continue;
        return {
          ...outcome,
          signature: info.signature,
          amount: charge.amount,
        };
      } catch {
        continue;
      }
    }
    if (sigs.length < pageSize) break;
    before = sigs[sigs.length - 1]?.signature;
  }
  return null;
}

async function recoverFromConnection(
  connection: Connection,
  programId: PublicKey,
  mandate: PublicKey,
  nonce: bigint,
): Promise<RecoveredCharge | null> {
  const ledger = ledgerPda(programId, mandate);
  const info = await connection.getAccountInfo(ledger, "confirmed");
  const ringHit = info ? findPaidInLedgerBytes(info.data, nonce) : null;
  if (ringHit !== null) {
    let signature = "";
    try {
      const historyHit = await findPaidInHistory(connection, programId, mandate, nonce);
      if (historyHit !== null) signature = historyHit.signature;
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
    }
    return {
      decision: "paid",
      reason: "ok",
      reasonCode: 0,
      suggestedOverride: ringHit.suggestedOverride === 0n ? null : ringHit.suggestedOverride,
      signature,
      amount: ringHit.amount,
    };
  }
  return findPaidInHistory(connection, programId, mandate, nonce);
}

export async function recoverSettledCharge(args: {
  cfg: WatcherConfig;
  agent: Keypair;
  nonce: bigint;
}): Promise<RecoveredCharge | null> {
  const { connection, programId } = connect(args.cfg, args.agent);
  const owner = new PublicKey(args.cfg.owner);
  const mandate = mandatePda(programId, owner, args.cfg.mandateId);
  return recoverFromConnection(connection, programId, mandate, args.nonce);
}
