import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type Connection,
  type VersionedTransactionResponse,
} from '@solana/web3.js';

import {
  ENTRY_SIZE,
  KIND_PAID,
  LEDGER_ACCOUNT_SIZE,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  LEDGER_HEADER_SIZE,
  PAID_EVENT_DISC,
  writeU64Le,
} from './constants';
import {
  attachSignatures,
  decodeLedgerAccount,
  ledgerPda,
  type DecodedTxDecision,
  type LedgerRow,
} from './ring';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });

const chainModule = import('./chain');

// Decisions ten minutes apart, so each one is far outside the matching skew of its neighbours.
const T0 = 1_700_000_000;
const GAP = 600;

function key(seed: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, seed));
}

const PROGRAM_ID = key(1);

function decisionTs(d: number): number {
  return T0 + d * GAP;
}

function entryBytes(d: number): Buffer {
  const raw = Buffer.alloc(ENTRY_SIZE);
  raw.writeBigInt64LE(BigInt(decisionTs(d)), 0);
  raw.writeBigUInt64LE(BigInt(1000 + d), 8);
  Buffer.from(key(7).toBytes()).copy(raw, 16);
  raw.writeBigUInt64LE(BigInt(d), 48);
  raw[64] = KIND_PAID;
  return raw;
}

/**
 * A ledger after `total` decisions, the way the program writes it. Its decisions are numbered
 * from `base`, so a test can list older transactions that never reached this ring.
 */
function ledgerBytes(mandate: PublicKey, total: number, base: number): Buffer {
  const data = Buffer.alloc(LEDGER_ACCOUNT_SIZE);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  Buffer.from(mandate.toBytes()).copy(data, 8);
  data.writeUInt32LE(total, 40);
  data.writeUInt16LE(total % LEDGER_CAPACITY, 44);
  data[46] = 255;
  for (let i = Math.max(0, total - LEDGER_CAPACITY); i < total; i += 1) {
    entryBytes(base + i).copy(data, 8 + LEDGER_HEADER_SIZE + (i % LEDGER_CAPACITY) * ENTRY_SIZE);
  }
  return data;
}

function paidLog(d: number): string {
  const raw = Buffer.alloc(64);
  PAID_EVENT_DISC.copy(raw, 0);
  writeU64Le(raw, 40, BigInt(1000 + d));
  writeU64Le(raw, 48, BigInt(d));
  return `Program data: ${raw.toString('base64')}`;
}

type Sig = { d: number; listedTime: number | null };

function signature(d: number): string {
  return `sig-${d}`;
}

function listed(sig: Sig): ConfirmedSignatureInfo {
  return {
    signature: signature(sig.d),
    slot: 100 + sig.d,
    err: null,
    memo: null,
    blockTime: sig.listedTime,
    confirmationStatus: 'confirmed',
  };
}

function body(d: number): VersionedTransactionResponse {
  return {
    slot: 100 + d,
    blockTime: decisionTs(d),
    meta: { err: null, fee: 5000, logMessages: [paidLog(d)] },
    transaction: { signatures: [signature(d)] },
  } as unknown as VersionedTransactionResponse;
}

function harness(mandate: PublicKey, total: number, sigs: Sig[], base = 0) {
  const ledger = ledgerPda(PROGRAM_ID, mandate);
  const data = ledgerBytes(mandate, total, base);
  // Newest first, as the RPC lists them.
  const all = [...sigs].sort((a, b) => b.d - a.d).map(listed);
  const counts = { listings: 0, bodies: 0 };
  const connection = {
    getAccountInfo: async (address: PublicKey) =>
      address.equals(ledger) ? { data, owner: PROGRAM_ID, executable: false, lamports: 1 } : null,
    getSignaturesForAddress: async (
      _address: PublicKey,
      options: { limit: number; before?: string },
    ) => {
      counts.listings += 1;
      const from = options.before ? all.findIndex((item) => item.signature === options.before) + 1 : 0;
      return all.slice(from, from + options.limit);
    },
    getTransaction: async (sig: string) => {
      counts.bodies += 1;
      return body(Number(sig.slice(4)));
    },
  };
  const client = {
    config: {} as import('./chain').ChainClient['config'],
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
  };
  // What the ledger showed when every listed body was read.
  const everyBody: DecodedTxDecision[] = sigs.map((sig) => ({
    signature: signature(sig.d),
    kind: KIND_PAID,
    amount: BigInt(1000 + sig.d),
    nonce: BigInt(sig.d),
    reason: 0,
    blockTime: sig.listedTime ?? decisionTs(sig.d),
    slot: 100 + sig.d,
  }));
  const expected = attachSignatures(decodeLedgerAccount(ledger.toBase58(), data).entries, everyBody);
  return { client, counts, expected };
}

function links(rows: LedgerRow[]): Array<[string, string | null]> {
  return rows.map((row) => [row.nonce.toString(), row.signature]);
}

test.describe('ledger bodies read only for decisions the ring can show', { concurrency: 1 }, () => {
  test('a ring with fewer than 32 entries keeps every link and skips an older timed body', async () => {
    const { fetchLedgerRows } = await chainModule;
    const sigs: Sig[] = [];
    for (let d = 20; d < 30; d += 1) {
      sigs.push({ d, listedTime: d === 25 ? null : decisionTs(d) });
    }
    // Two older transactions on the ledger that match no ring entry: one timed, one untimed.
    sigs.push({ d: 1, listedTime: decisionTs(1) });
    sigs.push({ d: 2, listedTime: null });
    const mandate = key(31);
    const run = harness(mandate, 10, sigs, 20);
    const { rows } = await fetchLedgerRows(run.client, mandate);
    assert.equal(rows.length, 10);
    assert.deepEqual(links(rows), links(run.expected));
    assert.deepEqual(rows, run.expected);
    assert.ok(rows.every((row) => row.signature === `sig-${row.nonce}`));
    assert.equal(rows.find((row) => row.nonce === 25n)?.signature, 'sig-25', 'an untimed signature is still read');
    assert.equal(run.counts.bodies, 11, 'the untimed older body is read, the timed older one is not');
  });

  test('a full ring with 68 older signatures reads 32 bodies and stops paging early', async () => {
    const { fetchLedgerRows } = await chainModule;
    const sigs: Sig[] = [];
    for (let d = 0; d < 100; d += 1) {
      sigs.push({ d, listedTime: decisionTs(d) });
    }
    const mandate = key(32);
    const run = harness(mandate, 100, sigs);
    const { rows } = await fetchLedgerRows(run.client, mandate);
    assert.equal(rows.length, LEDGER_CAPACITY);
    assert.deepEqual(links(rows), links(run.expected));
    assert.deepEqual(rows, run.expected);
    assert.ok(rows.every((row) => row.signature === `sig-${row.nonce}`));
    // Before: 3 listings (50, 50, then an empty page) and 100 bodies.
    assert.equal(run.counts.bodies, 32);
    assert.equal(run.counts.listings, 2);
  });

  test('a decision at the edge of the skew window is still read and linked', async () => {
    const { fetchLedgerRows } = await chainModule;
    // Decision 3 is listed 120 seconds before its ring entry, the widest skew that still matches.
    const sigs: Sig[] = [
      { d: 3, listedTime: decisionTs(3) - 120 },
      { d: 4, listedTime: decisionTs(4) },
    ];
    const mandate = key(33);
    const run = harness(mandate, 5, sigs);
    const { rows } = await fetchLedgerRows(run.client, mandate);
    assert.deepEqual(rows, run.expected);
    assert.equal(rows.find((row) => row.nonce === 3n)?.signature, 'sig-3');
    assert.equal(run.counts.bodies, 2);
  });
});
