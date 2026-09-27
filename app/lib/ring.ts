import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import {
  buffersEqual,
  ENTRY_SIZE,
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  kindName,
  LEDGER_ACCOUNT_SIZE,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  LEDGER_HEADER_SIZE,
  readI64Le,
  readU16Le,
  readU32Le,
  readU64Le,
  reasonText,
  u64Le,
} from './constants';

export type RingEntry = {
  ts: bigint;
  amount: bigint;
  counterparty: string;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  kindName: string;
  reason: number;
  reasonText: string;
  /** Set on a trade ledger row. Payment rows leave these unset. */
  amountOut?: bigint;
  minOut?: bigint;
  outMint?: string;
  outDecimals?: number;
  family?: 'payment' | 'trade';
};

export type LedgerSnapshot = {
  address: string;
  mandate: string;
  total: number;
  head: number;
  bump: number;
  entries: RingEntry[];
};

export type LedgerRow = RingEntry & { signature: string | null; slot?: number | null };

export function ledgerPda(programId: PublicKey, mandate: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('ledger'), mandate.toBuffer()],
    programId,
  );
  return pda;
}

export function mandatePda(programId: PublicKey, owner: PublicKey, mandateId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('mandate'), owner.toBuffer(), u64Le(mandateId)],
    programId,
  );
  return pda;
}

export function decodeLedgerAccount(address: string, data: Uint8Array): LedgerSnapshot {
  if (data.length < LEDGER_ACCOUNT_SIZE) {
    throw new Error(`ledger ${address} is ${data.length} bytes, expected ${LEDGER_ACCOUNT_SIZE}`);
  }
  if (!buffersEqual(data.subarray(0, 8), LEDGER_DISCRIMINATOR)) {
    throw new Error(`ledger ${address} does not have the Ledger discriminator`);
  }
  const body = data.subarray(8);
  const mandate = new PublicKey(body.subarray(0, 32)).toBase58();
  const total = readU32Le(body, 32);
  const head = readU16Le(body, 36);
  const bump = body[38] ?? 0;
  const occupied = Math.min(total, LEDGER_CAPACITY);
  const start = total >= LEDGER_CAPACITY ? head % LEDGER_CAPACITY : 0;
  const entries: RingEntry[] = [];
  for (let i = 0; i < occupied; i++) {
    const idx = (start + i) % LEDGER_CAPACITY;
    const off = LEDGER_HEADER_SIZE + idx * ENTRY_SIZE;
    entries.push(decodeEntry(body.subarray(off, off + ENTRY_SIZE)));
  }
  return { address, mandate, total, head, bump, entries };
}

function decodeEntry(raw: Uint8Array): RingEntry {
  const kind = raw[64] ?? 0;
  const reason = raw[65] ?? 0;
  return {
    ts: readI64Le(raw, 0),
    amount: readU64Le(raw, 8),
    counterparty: new PublicKey(raw.subarray(16, 48)).toBase58(),
    nonce: readU64Le(raw, 48),
    suggestedOverride: readU64Le(raw, 56),
    kind,
    kindName: kindName(kind),
    reason,
    reasonText: reasonText(reason),
  };
}

export type DecodedTxDecision = {
  signature: string;
  kind: number;
  amount: bigint;
  nonce: bigint;
  reason: number;
  blockTime?: number | null;
  slot?: number | null;
  suggestedOverride?: bigint;
  counterparty?: string | null;
};

// The program clock and the RPC block time are the same second on a healthy
// cluster, but a second or two of skew is common. A match farther away than
// this is a different charge still sitting in the signature window.
const SIGNATURE_SKEW_SEC = 120;

/**
 * The oldest block time a transaction can have and still attach to one of these entries. A
 * timed transaction older than this is never matched, so its body need not be read.
 */
export function oldestMatchableBlockTime(entries: readonly RingEntry[]): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    oldest = Math.min(oldest, Number(entry.ts));
  }
  return oldest - SIGNATURE_SKEW_SEC;
}

function decisionKeyMatches(tx: DecodedTxDecision, entry: RingEntry): boolean {
  if (tx.kind !== entry.kind) {
    return false;
  }
  if (entry.kind === KIND_PAID || entry.kind === KIND_REFUSED || entry.kind === KIND_OVERRIDE) {
    return tx.amount === entry.amount && tx.nonce === entry.nonce;
  }
  return true;
}

export function attachSignatures(
  entries: RingEntry[],
  txs: DecodedTxDecision[],
): LedgerRow[] {
  const used = new Set<number>();
  return entries.map((entry) => {
    let best = -1;
    let bestSkew = Number.POSITIVE_INFINITY;
    let untimed = -1;
    for (let index = 0; index < txs.length; index += 1) {
      if (used.has(index)) {
        continue;
      }
      const tx = txs[index];
      if (!tx || !decisionKeyMatches(tx, entry)) {
        continue;
      }
      if (tx.blockTime == null) {
        if (untimed < 0) {
          untimed = index;
        }
        continue;
      }
      const skew = Math.abs(tx.blockTime - Number(entry.ts));
      if (skew > SIGNATURE_SKEW_SEC || skew >= bestSkew) {
        continue;
      }
      best = index;
      bestSkew = skew;
    }
    const chosen = best >= 0 ? best : untimed;
    if (chosen >= 0) {
      used.add(chosen);
      const tx = txs[chosen];
      return { ...entry, signature: tx?.signature ?? null, slot: tx?.slot ?? null };
    }
    return { ...entry, signature: null, slot: null };
  });
}
