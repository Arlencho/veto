import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type Connection,
  type VersionedTransactionResponse,
} from '@solana/web3.js';

import { decisionFace } from '../components/records/copy';
import {
  ENTRY_SIZE,
  KIND_PAID,
  KIND_REFUSED,
  LEDGER_ACCOUNT_SIZE,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  LEDGER_HEADER_SIZE,
  PAID_EVENT_DISC,
  REASON_OVER_PER_TX_MAX,
  writeU64Le,
} from './constants';
import { ledgerPda, type LedgerRow } from './ring';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });

const chainModule = import('./chain');

const BLOCK_TIME = 1_700_000_100;
const ENTRY_TS = 1_700_000_100n;
const REFUSED_LINE =
  'Program data: 5jGF0Go+aqmKnwXesECFqx2ayX1miaRMTVINs+HNVSAqkrHzZi0GZOCTBAAAAAAAAgAAAAAAAAAF4JMEAAAAAAA=';

function key(seed: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, seed));
}

const PROGRAM_ID = key(1);

function entryBytes(args: {
  ts: bigint;
  amount: bigint;
  counterparty: Uint8Array;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  reason: number;
}): Buffer {
  const raw = Buffer.alloc(ENTRY_SIZE);
  raw.writeBigInt64LE(args.ts, 0);
  raw.writeBigUInt64LE(args.amount, 8);
  Buffer.from(args.counterparty).copy(raw, 16);
  raw.writeBigUInt64LE(args.nonce, 48);
  raw.writeBigUInt64LE(args.suggestedOverride, 56);
  raw[64] = args.kind;
  raw[65] = args.reason;
  return raw;
}

function ledgerBytes(args: {
  mandate: Uint8Array;
  total: number;
  head: number;
  bump: number;
  slots: Array<Buffer | null>;
}): Buffer {
  const data = Buffer.alloc(LEDGER_ACCOUNT_SIZE);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  Buffer.from(args.mandate).copy(data, 8);
  data.writeUInt32LE(args.total, 40);
  data.writeUInt16LE(args.head, 44);
  data[46] = args.bump;
  for (let i = 0; i < LEDGER_CAPACITY; i += 1) {
    const slot = args.slots[i];
    if (!slot) {
      continue;
    }
    slot.copy(data, 8 + LEDGER_HEADER_SIZE + i * ENTRY_SIZE);
  }
  return data;
}

function paidLog(amount: bigint, nonce: bigint): string {
  const raw = Buffer.alloc(64);
  PAID_EVENT_DISC.copy(raw, 0);
  writeU64Le(raw, 40, amount);
  writeU64Le(raw, 48, nonce);
  return `Program data: ${raw.toString('base64')}`;
}

function txBody(signature: string, log: string): VersionedTransactionResponse {
  return {
    slot: 9,
    blockTime: BLOCK_TIME,
    meta: { err: null, fee: 5000, logMessages: [log] },
    transaction: { signatures: [signature] },
  } as unknown as VersionedTransactionResponse;
}

function listed(signature: string): ConfirmedSignatureInfo {
  return {
    signature,
    slot: 9,
    err: null,
    memo: null,
    blockTime: BLOCK_TIME,
    confirmationStatus: 'confirmed',
  };
}

function paidEntry(): Buffer {
  return entryBytes({
    ts: ENTRY_TS,
    amount: 8n,
    counterparty: key(7).toBytes(),
    nonce: 3n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    reason: 0,
  });
}

function refusedEntry(): Buffer {
  return entryBytes({
    ts: ENTRY_TS,
    amount: 300_000n,
    counterparty: key(7).toBytes(),
    nonce: 2n,
    suggestedOverride: 300_000n,
    kind: KIND_REFUSED,
    reason: REASON_OVER_PER_TX_MAX,
  });
}

function clientFor(args: {
  mandate: PublicKey;
  entries: Buffer[];
  signatures: ConfirmedSignatureInfo[];
  getTransaction: (signature: string) => Promise<VersionedTransactionResponse | null>;
}) {
  const ledger = ledgerPda(PROGRAM_ID, args.mandate);
  const data = ledgerBytes({
    mandate: args.mandate.toBytes(),
    total: args.entries.length,
    head: 0,
    bump: 255,
    slots: args.entries,
  });
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(ledger)) {
        return { data, owner: PROGRAM_ID, executable: false, lamports: 1 };
      }
      return null;
    },
    getSignaturesForAddress: async () => args.signatures,
    getTransaction: args.getTransaction,
  };
  return {
    config: {} as import('./chain').ChainClient['config'],
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
  };
}

function shown(rows: LedgerRow[], kind: number) {
  const row = rows.find((item) => item.kind === kind);
  assert.ok(row, `missing kind ${kind}`);
  return { row, face: decisionFace(row, 0, 10n, undefined) };
}

type BodyFetch = {
  concurrency: number;
  retryMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
};

function bodyFetch(loaded: { ledgerBodyFetch?: BodyFetch }): BodyFetch | null {
  return loaded.ledgerBodyFetch ?? null;
}

test.describe('ledger transaction links', { concurrency: 1 }, () => {
  test('a dropped then rate limited transaction read backs off and the decision gets its blockchain link', async () => {
    const loaded = await chainModule;
    const clock = bodyFetch(loaded);
    const slept: number[] = [];
    const saved = clock?.sleep;
    if (clock) {
      clock.sleep = async (ms: number) => {
        slept.push(ms);
      };
    }
    const errors = [new TypeError('Network request failed'), new Error('Server responded with 429')];
    let attempts = 0;
    try {
      const { rows } = await loaded.fetchLedgerRows(
        clientFor({
          mandate: key(21),
          entries: [refusedEntry()],
          signatures: [listed('sig-limited')],
          getTransaction: async () => {
            const err = errors[attempts];
            attempts += 1;
            if (err) {
              throw err;
            }
            return txBody('sig-limited', REFUSED_LINE);
          },
        }),
        key(21),
      );
      const { row, face } = shown(rows, KIND_REFUSED);
      assert.equal(row.signature, 'sig-limited');
      assert.equal(face.chainLink, 'See it on the blockchain');
      assert.equal(slept.length, 2);
      assert.ok(slept[0]! > 0);
      assert.ok(slept[1]! > slept[0]!);
    } finally {
      if (clock && saved) {
        clock.sleep = saved;
      }
    }
  });

  test('a transaction read that keeps failing does not crash and the row says it is saved on the blockchain', async () => {
    const loaded = await chainModule;
    const clock = bodyFetch(loaded);
    const savedSleep = clock?.sleep;
    if (clock) {
      clock.sleep = async () => undefined;
    }
    const warnings: string[] = [];
    const savedWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((item) => String(item)).join(' '));
    };
    let attempts = 0;
    try {
      const { rows } = await loaded.fetchLedgerRows(
        clientFor({
          mandate: key(22),
          entries: [refusedEntry()],
          signatures: [listed('sig-missing')],
          getTransaction: async () => {
            attempts += 1;
            throw new Error('429 Too Many Requests');
          },
        }),
        key(22),
      );
      const { row, face } = shown(rows, KIND_REFUSED);
      assert.equal(row.signature, null);
      assert.equal(face.chainLink, null);
      assert.match(face.detail, /Saved on the blockchain/);
      assert.ok(attempts >= 3);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /1 transaction body could not be read/);
    } finally {
      console.warn = savedWarn;
      if (clock && savedSleep) {
        clock.sleep = savedSleep;
      }
    }
  });

  test('a later read keeps the link it already matched and retries the row that was still missing', async () => {
    const loaded = await chainModule;
    const clock = bodyFetch(loaded);
    const saved = clock?.sleep;
    if (clock) {
      clock.sleep = async () => undefined;
    }
    const calls: string[] = [];
    let refusedFails = true;
    const mandate = key(23);
    const client = clientFor({
      mandate,
      entries: [paidEntry(), refusedEntry()],
      signatures: [listed('sig-kept'), listed('sig-later')],
      getTransaction: async (signature: string) => {
        calls.push(signature);
        if (signature === 'sig-kept') {
          return txBody('sig-kept', paidLog(8n, 3n));
        }
        if (refusedFails) {
          throw new Error('429 Too Many Requests');
        }
        return txBody('sig-later', REFUSED_LINE);
      },
    });
    try {
      const first = await loaded.fetchLedgerRows(client, mandate);
      const paid = shown(first.rows, KIND_PAID);
      const refused = shown(first.rows, KIND_REFUSED);
      assert.equal(paid.face.chainLink, 'See it on the blockchain');
      assert.equal(paid.row.signature, 'sig-kept');
      assert.equal(refused.row.signature, null);
      assert.equal(refused.face.chainLink, null);
      assert.match(refused.face.detail, /Saved on the blockchain/);

      refusedFails = false;
      const before = calls.filter((signature) => signature === 'sig-kept').length;
      const second = await loaded.fetchLedgerRows(client, mandate);
      const paidAgain = shown(second.rows, KIND_PAID);
      const refusedAgain = shown(second.rows, KIND_REFUSED);
      assert.equal(paidAgain.row.signature, 'sig-kept');
      assert.equal(paidAgain.face.chainLink, 'See it on the blockchain');
      assert.equal(refusedAgain.row.signature, 'sig-later');
      assert.equal(refusedAgain.face.chainLink, 'See it on the blockchain');
      assert.equal(calls.filter((signature) => signature === 'sig-kept').length, before);
    } finally {
      if (clock && saved) {
        clock.sleep = saved;
      }
    }
  });

  test('transaction bodies are read two at a time', async () => {
    const loaded = await chainModule;
    let hold = true;
    let started = 0;
    let active = 0;
    let maxActive = 0;
    const blocked: Array<() => void> = [];
    const mandate = key(24);
    const signatures = ['sig-1', 'sig-2', 'sig-3', 'sig-4'].map(listed);
    const pending = loaded.fetchLedgerRows(
      clientFor({
        mandate,
        // An entry in the same second keeps every body in the window the ring can match.
        entries: [refusedEntry()],
        signatures,
        getTransaction: async (signature: string) => {
          active += 1;
          started += 1;
          maxActive = Math.max(maxActive, active);
          if (hold) {
            await new Promise<void>((resolve) => {
              blocked.push(resolve);
            });
          }
          active -= 1;
          return txBody(signature, REFUSED_LINE);
        },
      }),
      mandate,
    );
    for (let i = 0; i < 40 && started < 2; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, 2);
    assert.equal(maxActive, 2);
    hold = false;
    for (const release of blocked.splice(0)) {
      release();
    }
    await pending;
    assert.equal(started, signatures.length);
    assert.equal(maxActive, 2);
  });
});
