import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';

import {
  decodeHoldLedger,
  decodeHoldVault,
  holdWithdrawalOutlook,
  type HoldLedger,
  type HoldOutlook,
} from './holdRead';
import {
  migrateHoldVaultInstruction,
  closeHoldVaultInstruction,
  depositInstruction,
  freezeInstruction,
  initVaultInstruction,
  recoverInstruction,
  skipInstruction,
  stopInstruction,
  unfreezeInstruction,
  withdrawInstruction,
} from './holdTx';
import { HOLD_LEDGER_DISCRIMINATOR, HOLD_VAULT_DISCRIMINATOR } from '../../sdk/src/idl';
import {
  HoldVault,
  decodeHoldLedger as sdkDecodeHoldLedger,
  decodeHoldVault as sdkDecodeHoldVault,
  withdrawalOutlook,
  type WithdrawalOutlook,
} from '../../sdk/src/hold';

const DAY = 86_400n;
const NOW = 1_700_000_000n;
const VAULT_LEN = 1691;
const LEDGER_LEN = 2096;
const PENDING_SIZE = 57;
const ENTRY_SIZE = 64;
const ENTRY_BASE = 48;
const LEDGER_CAPACITY = 32;
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

const ownerKey = Keypair.generate().publicKey;
const guardianKey = Keypair.generate().publicKey;
const safeKey = Keypair.generate().publicKey;
const mintKey = Keypair.generate().publicKey;
const vaultTokenKey = Keypair.generate().publicKey;
const knownDest = Keypair.generate().publicKey;
const otherDest = Keypair.generate().publicKey;
const changeGuardian = Keypair.generate().publicKey;
const changeSafe = Keypair.generate().publicKey;

type PendingSlot = {
  id: bigint;
  amount: bigint;
  destination: PublicKey;
  unlockAt: bigint;
  status: number;
};

type ChangeSpec = {
  active: boolean;
  fields: number;
  bigShareBps: number;
  dailyLimit: bigint;
  delaySecs: bigint;
  guardian: PublicKey;
  safeAddress: PublicKey;
  effectiveAt: bigint;
};

type VaultSpec = {
  owner: PublicKey;
  guardian: PublicKey;
  safeAddress: PublicKey;
  mint: PublicKey;
  vaultToken: PublicKey;
  vaultId: bigint;
  dailyLimit: bigint;
  dailyBuckets: { hour: bigint; amount: bigint }[];
  windowSpent: bigint;
  windowStart: bigint;
  delaySecs: bigint;
  unfreezeAt: bigint;
  nextWithdrawalId: bigint;
  bigShareBps: number;
  frozen: number;
  known: PublicKey[];
  pending: (PendingSlot | null)[];
  change: ChangeSpec;
  bump: number;
  tokenBump: number;
  ledgerBump: number;
};

type Rig = {
  programId: PublicKey;
  owner: Keypair;
  guardian: Keypair;
  safe: PublicKey;
  mint: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  tokenProgram: PublicKey;
  vaultId: bigint;
};

function rig(): Rig {
  return {
    programId: Keypair.generate().publicKey,
    owner: Keypair.generate(),
    guardian: Keypair.generate(),
    safe: Keypair.generate().publicKey,
    mint: Keypair.generate().publicKey,
    source: Keypair.generate().publicKey,
    destination: Keypair.generate().publicKey,
    tokenProgram: Keypair.generate().publicKey,
    vaultId: 7n,
  };
}

function instructionShape(ix: TransactionInstruction) {
  return {
    programId: ix.programId.toBase58(),
    data: Buffer.from(ix.data).toString('hex'),
    keys: ix.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
  };
}

/** The fee payer is writable on the wire. Compile both sides the same way before comparing. */
function compiled(ix: TransactionInstruction, feePayer: PublicKey) {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = PublicKey.default.toBase58();
  tx.add(ix);
  const back = Transaction.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).instructions[0];
  assert.ok(back);
  return instructionShape(back);
}

async function sentInstruction(
  programId: PublicKey,
  run: (vault: HoldVault) => Promise<unknown>,
): Promise<TransactionInstruction> {
  let raw: Buffer | null = null;
  const connection = {
    async getLatestBlockhash() {
      return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 };
    },
    async sendRawTransaction(bytes: Uint8Array) {
      raw = Buffer.from(bytes);
      return 'sig';
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
  };
  const vault = new HoldVault({ connection: connection as unknown as Connection, programId });
  await run(vault);
  assert.ok(raw, 'the vault client sent no transaction');
  const ix = Transaction.from(raw).instructions[0];
  assert.ok(ix);
  return ix;
}

function vaultBytes(spec: VaultSpec): Buffer {
  const data = Buffer.alloc(VAULT_LEN);
  HOLD_VAULT_DISCRIMINATOR.copy(data, 0);
  data.set(spec.owner.toBuffer(), 8);
  data.set(spec.guardian.toBuffer(), 40);
  data.set(spec.safeAddress.toBuffer(), 72);
  data.set(spec.mint.toBuffer(), 104);
  data.set(spec.vaultToken.toBuffer(), 136);
  data.writeBigUInt64LE(spec.vaultId, 168);
  data.writeBigUInt64LE(spec.dailyLimit, 176);
  spec.dailyBuckets.forEach((bucket, i) => {
    data.writeBigInt64LE(bucket.hour, 1291 + i * 16);
    data.writeBigUInt64LE(bucket.amount, 1299 + i * 16);
  });
  data.writeBigUInt64LE(spec.windowSpent, 184);
  data.writeBigInt64LE(spec.windowStart, 192);
  data.writeBigInt64LE(spec.delaySecs, 200);
  data.writeBigInt64LE(spec.unfreezeAt, 208);
  data.writeBigUInt64LE(spec.nextWithdrawalId, 216);
  data.writeUInt16LE(spec.bigShareBps, 224);
  data.writeUInt8(spec.frozen, 226);
  data.writeUInt8(spec.known.length, 227);
  data.writeUInt8(spec.bump, 228);
  data.writeUInt8(spec.tokenBump, 229);
  data.writeUInt8(spec.ledgerBump, 230);
  spec.known.forEach((key, index) => {
    data.set(key.toBuffer(), 231 + index * 32);
  });
  spec.pending.forEach((row, index) => {
    if (!row) return;
    const off = 743 + index * PENDING_SIZE;
    data.writeBigUInt64LE(row.id, off);
    data.writeBigUInt64LE(row.amount, off + 8);
    data.set(row.destination.toBuffer(), off + 16);
    data.writeBigInt64LE(row.unlockAt, off + 48);
    data.writeUInt8(row.status, off + 56);
  });
  const changeAt = 1199;
  data.writeUInt8(spec.change.active ? 1 : 0, changeAt);
  data.writeUInt8(spec.change.fields, changeAt + 1);
  data.writeUInt16LE(spec.change.bigShareBps, changeAt + 2);
  data.writeBigUInt64LE(spec.change.dailyLimit, changeAt + 4);
  data.writeBigInt64LE(spec.change.delaySecs, changeAt + 12);
  data.set(spec.change.guardian.toBuffer(), changeAt + 20);
  data.set(spec.change.safeAddress.toBuffer(), changeAt + 52);
  data.writeBigInt64LE(spec.change.effectiveAt, changeAt + 84);
  return data;
}

function keyText(value: PublicKey): string {
  return value.toBase58();
}

function intText(value: bigint): string {
  return value.toString();
}

function plainVault(account: {
  address: PublicKey;
  owner: PublicKey;
  guardian: PublicKey;
  safeAddress: PublicKey;
  mint: PublicKey;
  vaultToken: PublicKey;
  vaultId: bigint;
  dailyLimit: bigint;
  dailyBuckets: { hour: bigint; amount: bigint }[];
  windowSpent: bigint;
  windowStart: bigint;
  delaySecs: bigint;
  unfreezeAt: bigint;
  nextWithdrawalId: bigint;
  bigShareBps: number;
  frozen: boolean;
  known: PublicKey[];
  pending: PendingSlot[];
  change: ChangeSpec;
  bump: number;
  tokenBump: number;
  ledgerBump: number;
}) {
  return {
    address: keyText(account.address),
    owner: keyText(account.owner),
    guardian: keyText(account.guardian),
    safeAddress: keyText(account.safeAddress),
    mint: keyText(account.mint),
    vaultToken: keyText(account.vaultToken),
    vaultId: intText(account.vaultId),
    dailyLimit: intText(account.dailyLimit),
    dailyBuckets: account.dailyBuckets.map((b) => ({ hour: intText(b.hour), amount: intText(b.amount) })),
    windowSpent: intText(account.windowSpent),
    windowStart: intText(account.windowStart),
    delaySecs: intText(account.delaySecs),
    unfreezeAt: intText(account.unfreezeAt),
    nextWithdrawalId: intText(account.nextWithdrawalId),
    bigShareBps: account.bigShareBps,
    frozen: account.frozen,
    known: account.known.map(keyText),
    pending: account.pending.map((row) => ({
      id: intText(row.id),
      amount: intText(row.amount),
      destination: keyText(row.destination),
      unlockAt: intText(row.unlockAt),
      status: row.status,
    })),
    change: {
      active: account.change.active,
      fields: account.change.fields,
      bigShareBps: account.change.bigShareBps,
      dailyLimit: intText(account.change.dailyLimit),
      delaySecs: intText(account.change.delaySecs),
      guardian: keyText(account.change.guardian),
      safeAddress: keyText(account.change.safeAddress),
      effectiveAt: intText(account.change.effectiveAt),
    },
    bump: account.bump,
    tokenBump: account.tokenBump,
    ledgerBump: account.ledgerBump,
  };
}

function expectedVault(spec: VaultSpec, address: PublicKey) {
  return {
    address: keyText(address),
    owner: keyText(spec.owner),
    guardian: keyText(spec.guardian),
    safeAddress: keyText(spec.safeAddress),
    mint: keyText(spec.mint),
    vaultToken: keyText(spec.vaultToken),
    vaultId: intText(spec.vaultId),
    dailyLimit: intText(spec.dailyLimit),
    dailyBuckets: Array.from({ length: 25 }, (_, i) => ({ hour: intText(spec.dailyBuckets[i]?.hour ?? 0n), amount: intText(spec.dailyBuckets[i]?.amount ?? 0n) })),
    windowSpent: intText(spec.windowSpent),
    windowStart: intText(spec.windowStart),
    delaySecs: intText(spec.delaySecs),
    unfreezeAt: intText(spec.unfreezeAt),
    nextWithdrawalId: intText(spec.nextWithdrawalId),
    bigShareBps: spec.bigShareBps,
    frozen: spec.frozen !== 0,
    known: spec.known.map(keyText),
    pending: spec.pending.flatMap((row) =>
      row && row.status === 1
        ? [
            {
              id: intText(row.id),
              amount: intText(row.amount),
              destination: keyText(row.destination),
              unlockAt: intText(row.unlockAt),
              status: row.status,
            },
          ]
        : [],
    ),
    change: {
      active: spec.change.active,
      fields: spec.change.fields,
      bigShareBps: spec.change.bigShareBps,
      dailyLimit: intText(spec.change.dailyLimit),
      delaySecs: intText(spec.change.delaySecs),
      guardian: keyText(spec.change.guardian),
      safeAddress: keyText(spec.change.safeAddress),
      effectiveAt: intText(spec.change.effectiveAt),
    },
    bump: spec.bump,
    tokenBump: spec.tokenBump,
    ledgerBump: spec.ledgerBump,
  };
}

function baseChange(): ChangeSpec {
  return {
    active: false,
    fields: 0,
    bigShareBps: 0,
    dailyLimit: 0n,
    delaySecs: 0n,
    guardian: PublicKey.default,
    safeAddress: PublicKey.default,
    effectiveAt: 0n,
  };
}

function baseVault(over: Partial<VaultSpec> = {}): VaultSpec {
  return {
    owner: ownerKey,
    guardian: guardianKey,
    safeAddress: safeKey,
    mint: mintKey,
    vaultToken: vaultTokenKey,
    vaultId: 4n,
    dailyLimit: 50n,
    windowSpent: 0n,
    windowStart: NOW - 10n,
    delaySecs: DAY,
    unfreezeAt: 0n,
    nextWithdrawalId: 1n,
    bigShareBps: 10_000,
    frozen: 0,
    known: [knownDest],
    pending: [],
    change: baseChange(),
    bump: 1,
    tokenBump: 2,
    ledgerBump: 3,
    ...over,
    dailyBuckets: over.dailyBuckets ?? [{ hour: ((over.windowStart ?? NOW - 10n) / 3600n), amount: over.windowSpent ?? 0n }],
  };
}

type LedgerEntrySpec = {
  index: number;
  ts: bigint;
  amount: bigint;
  destination: PublicKey;
  withdrawalId: bigint;
  kind: number;
  reason: number;
};

function ledgerBytes(args: {
  vault: PublicKey;
  total: number;
  head: number;
  bump: number;
  entries: LedgerEntrySpec[];
}): Buffer {
  const data = Buffer.alloc(LEDGER_LEN);
  HOLD_LEDGER_DISCRIMINATOR.copy(data, 0);
  data.set(args.vault.toBuffer(), 8);
  data.writeUInt32LE(args.total, 40);
  data.writeUInt16LE(args.head, 44);
  data.writeUInt8(args.bump, 46);
  for (const entry of args.entries) {
    const off = ENTRY_BASE + entry.index * ENTRY_SIZE;
    data.writeBigInt64LE(entry.ts, off);
    data.writeBigUInt64LE(entry.amount, off + 8);
    data.set(entry.destination.toBuffer(), off + 16);
    data.writeBigUInt64LE(entry.withdrawalId, off + 48);
    data.writeUInt8(entry.kind, off + 56);
    data.writeUInt8(entry.reason, off + 57);
  }
  return data;
}

function plainLedger(account: HoldLedger) {
  return {
    address: keyText(account.address),
    vault: keyText(account.vault),
    total: account.total,
    head: account.head,
    bump: account.bump,
    entries: account.entries.map((entry) => ({
      ts: intText(entry.ts),
      amount: intText(entry.amount),
      destination: keyText(entry.destination),
      withdrawalId: intText(entry.withdrawalId),
      kind: entry.kind,
      reason: entry.reason,
    })),
  };
}

function plainOutlook(value: HoldOutlook | WithdrawalOutlook) {
  if (value.outcome === 'held') {
    return { outcome: 'held' as const, reasons: value.reasons, unlockAt: intText(value.unlockAt) };
  }
  if (value.outcome === 'refused') {
    return { outcome: 'refused' as const, reason: value.reason };
  }
  return { outcome: 'at_once' as const };
}

function sameOutlook(
  spec: VaultSpec,
  args: { amount: bigint; destination: PublicKey; balance: bigint; now: bigint },
  expected: ReturnType<typeof plainOutlook>,
) {
  const data = vaultBytes(spec);
  const address = vaultTokenKey;
  const app = holdWithdrawalOutlook(decodeHoldVault(data, address), args);
  const sdk = withdrawalOutlook(sdkDecodeHoldVault(data, address), args);
  assert.deepEqual(plainOutlook(app), expected);
  assert.deepEqual(plainOutlook(sdk), expected);
}

const instructionCases: {
  name: string;
  length: number;
  feePayer: (row: Rig) => PublicKey;
  app: (row: Rig) => TransactionInstruction;
  sdk: (row: Rig, vault: HoldVault) => Promise<unknown>;
}[] = [
  {
    name: 'opening a vault',
    length: 98,
    feePayer: (row) => row.owner.publicKey,
    app: (row) =>
      initVaultInstruction({
        programId: row.programId,
        owner: row.owner.publicKey,
        vaultId: row.vaultId,
        guardian: row.guardian.publicKey,
        safeAddress: row.safe,
        dailyLimit: 50n,
        delaySecs: DAY * 2n,
        bigShareBps: 2500,
        mint: row.mint,
        tokenProgram: row.tokenProgram,
      }),
    sdk: (row, vault) =>
      vault.initVault({
        owner: row.owner,
        vaultId: row.vaultId,
        guardian: row.guardian.publicKey,
        safeAddress: row.safe,
        dailyLimit: 50n,
        delaySecs: DAY * 2n,
        bigShareBps: 2500,
        mint: row.mint,
        tokenProgram: row.tokenProgram,
      }),
  },
  {
    name: 'depositing into a vault',
    length: 16,
    feePayer: (row) => row.owner.publicKey,
    app: (row) =>
      depositInstruction({
        programId: row.programId,
        owner: row.owner.publicKey,
        vaultId: row.vaultId,
        source: row.source,
        mint: row.mint,
        amount: 42n,
      }),
    sdk: (row, vault) =>
      vault.deposit({
        owner: row.owner,
        vaultId: row.vaultId,
        source: row.source,
        mint: row.mint,
        amount: 42n,
      }),
  },
  {
    name: 'withdrawing from a vault',
    length: 16,
    feePayer: (row) => row.owner.publicKey,
    app: (row) =>
      withdrawInstruction({
        programId: row.programId,
        owner: row.owner.publicKey,
        vaultId: row.vaultId,
        destination: row.destination,
        mint: row.mint,
        amount: 77n,
        tokenProgram: row.tokenProgram,
      }),
    sdk: (row, vault) =>
      vault.withdraw({
        owner: row.owner,
        vaultId: row.vaultId,
        destination: row.destination,
        mint: row.mint,
        amount: 77n,
        tokenProgram: row.tokenProgram,
      }),
  },
  {
    name: 'stopping a withdrawal',
    length: 16,
    feePayer: (row) => row.guardian.publicKey,
    app: (row) =>
      stopInstruction({
        programId: row.programId,
        authority: row.guardian.publicKey,
        owner: row.owner.publicKey,
        vaultId: row.vaultId,
        id: 9n,
      }),
    sdk: (row, vault) =>
      vault.stop({
        authority: row.guardian,
        owner: row.owner.publicKey,
        vaultId: row.vaultId,
        id: 9n,
      }),
  },
  {
    name: 'migrating a legacy vault', length: 8,
    feePayer: (row) => row.owner.publicKey,
    app: (row) => migrateHoldVaultInstruction({ programId: row.programId, owner: row.owner.publicKey, vaultId: row.vaultId }),
    sdk: (row, vault) => vault.migrateHoldVault({ owner: row.owner, vaultId: row.vaultId }),
  },
  {
    name: 'closing a vault to its safe address', length: 8,
    feePayer: (row) => row.owner.publicKey,
    app: (row) => closeHoldVaultInstruction({ programId: row.programId, owner: row.owner.publicKey,
      vaultId: row.vaultId, destination: row.destination, mint: row.mint }),
    sdk: (row, vault) => vault.closeHoldVault({ owner: row.owner, vaultId: row.vaultId,
      destination: row.destination, mint: row.mint }),
  },
  {
    name: 'freezing a vault',
    length: 8,
    feePayer: (row) => row.guardian.publicKey,
    app: (row) =>
      freezeInstruction({
        programId: row.programId,
        authority: row.guardian.publicKey,
        owner: row.owner.publicKey,
        vaultId: row.vaultId,
      }),
    sdk: (row, vault) =>
      vault.freeze({
        authority: row.guardian,
        owner: row.owner.publicKey,
        vaultId: row.vaultId,
      }),
  },
  {
    name: 'recovering a frozen vault',
    length: 8,
    feePayer: (row) => row.guardian.publicKey,
    app: (row) =>
      recoverInstruction({
        programId: row.programId,
        authority: row.guardian.publicKey,
        owner: row.owner.publicKey,
        vaultId: row.vaultId,
        destination: row.destination,
        mint: row.mint,
      }),
    sdk: (row, vault) =>
      vault.recover({
        authority: row.guardian,
        owner: row.owner.publicKey,
        vaultId: row.vaultId,
        destination: row.destination,
        mint: row.mint,
      }),
  },
  {
    name: 'skipping a wait',
    length: 16,
    feePayer: (row) => row.owner.publicKey,
    app: (row) =>
      skipInstruction({
        programId: row.programId,
        owner: row.owner.publicKey,
        guardian: row.guardian.publicKey,
        vaultId: row.vaultId,
        destination: row.destination,
        mint: row.mint,
        id: 3n,
        tokenProgram: row.tokenProgram,
      }),
    sdk: (row, vault) =>
      vault.skip({
        owner: row.owner,
        guardian: row.guardian,
        vaultId: row.vaultId,
        destination: row.destination,
        mint: row.mint,
        id: 3n,
        tokenProgram: row.tokenProgram,
      }),
  },
  {
    name: 'unfreezing with the guardian',
    length: 8,
    feePayer: (row) => row.owner.publicKey,
    app: (row) =>
      unfreezeInstruction({
        programId: row.programId,
        owner: row.owner.publicKey,
        guardian: row.guardian.publicKey,
        vaultId: row.vaultId,
      }),
    sdk: (row, vault) =>
      vault.unfreeze({
        owner: row.owner,
        guardian: row.guardian,
        vaultId: row.vaultId,
      }),
  },
  {
    name: 'unfreezing without a guardian',
    length: 8,
    feePayer: (row) => row.owner.publicKey,
    app: (row) =>
      unfreezeInstruction({
        programId: row.programId,
        owner: row.owner.publicKey,
        guardian: null,
        vaultId: row.vaultId,
      }),
    sdk: (row, vault) =>
      vault.unfreeze({
        owner: row.owner,
        vaultId: row.vaultId,
      }),
  },
];

for (const item of instructionCases) {
  test(`${item.name} builds the same instruction as the vault client`, async () => {
    const row = rig();
    const appIx = item.app(row);
    const sdkIx = await sentInstruction(row.programId, (vault) => item.sdk(row, vault));
    assert.equal(sdkIx.data.length, item.length);
    assert.deepEqual(compiled(appIx, item.feePayer(row)), instructionShape(sdkIx));
  });
}

test('a vault account decodes to the same fields as the vault client', () => {
  const address = Keypair.generate().publicKey;
  const spec = baseVault({
    dailyLimit: 18_446_744_073_709_551_615n,
    windowSpent: 99n,
    windowStart: -5n,
    delaySecs: DAY * 3n,
    unfreezeAt: -8n,
    nextWithdrawalId: 12n,
    bigShareBps: 2500,
    frozen: 2,
    known: [knownDest, otherDest],
    pending: [
      { id: 4n, amount: 40n, destination: knownDest, unlockAt: NOW + DAY, status: 1 },
      null,
      { id: 6n, amount: 60n, destination: otherDest, unlockAt: NOW + DAY * 2n, status: 1 },
    ],
    change: {
      active: true,
      fields: 5,
      bigShareBps: 1000,
      dailyLimit: 9n,
      delaySecs: DAY * 2n,
      guardian: changeGuardian,
      safeAddress: changeSafe,
      effectiveAt: -3n,
    },
    bump: 7,
    tokenBump: 8,
    ledgerBump: 9,
  });
  const data = vaultBytes(spec);
  const app = plainVault(decodeHoldVault(data, address));
  const sdk = plainVault(sdkDecodeHoldVault(data, address));
  const expected = expectedVault(spec, address);
  assert.deepEqual(sdk, expected);
  assert.deepEqual(app, sdk);
});

test('a short ledger decodes to the same entries as the vault client', () => {
  const address = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const data = ledgerBytes({
    vault,
    total: 2,
    head: 0,
    bump: 3,
    entries: [
      {
        index: 0,
        ts: -4n,
        amount: 15n,
        destination: knownDest,
        withdrawalId: 4n,
        kind: 3,
        reason: 0,
      },
      {
        index: 1,
        ts: NOW,
        amount: 20n,
        destination: otherDest,
        withdrawalId: 5n,
        kind: 2,
        reason: 1,
      },
    ],
  });
  const app = plainLedger(decodeHoldLedger(data, address));
  const sdk = plainLedger(sdkDecodeHoldLedger(data, address));
  assert.equal(sdk.entries.length, 2);
  assert.equal(sdk.entries[0]?.amount, '15');
  assert.equal(sdk.entries[0]?.ts, '-4');
  assert.equal(sdk.entries[1]?.destination, keyText(otherDest));
  assert.deepEqual(app, sdk);
});

test('a wrapped ledger decodes to the same oldest-first entries as the vault client', () => {
  const address = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const data = ledgerBytes({
    vault,
    total: 34,
    head: 2,
    bump: 6,
    entries: [
      {
        index: 2,
        ts: 1n,
        amount: 2n,
        destination: knownDest,
        withdrawalId: 1n,
        kind: 1,
        reason: 0,
      },
      {
        index: 0,
        ts: 2n,
        amount: 100n,
        destination: otherDest,
        withdrawalId: 2n,
        kind: 4,
        reason: 1,
      },
      {
        index: 1,
        ts: 3n,
        amount: 101n,
        destination: safeKey,
        withdrawalId: 3n,
        kind: 5,
        reason: 2,
      },
    ],
  });
  const app = plainLedger(decodeHoldLedger(data, address));
  const sdk = plainLedger(sdkDecodeHoldLedger(data, address));
  assert.equal(sdk.entries.length, LEDGER_CAPACITY);
  assert.equal(sdk.entries[0]?.amount, '2');
  assert.equal(sdk.entries[1]?.amount, '0');
  assert.equal(sdk.entries[1]?.destination, PublicKey.default.toBase58());
  assert.equal(sdk.entries[LEDGER_CAPACITY - 2]?.amount, '100');
  assert.equal(sdk.entries[LEDGER_CAPACITY - 1]?.amount, '101');
  assert.deepEqual(app, sdk);
});

test('a withdrawal pays at once when the destination is known and the amount fits', () => {
  sameOutlook(
    baseVault(),
    { amount: 20n, destination: knownDest, balance: 1_000n, now: NOW },
    { outcome: 'at_once' },
  );
});

test('a withdrawal to a new address waits', () => {
  sameOutlook(
    baseVault(),
    { amount: 10n, destination: otherDest, balance: 1_000n, now: NOW },
    { outcome: 'held', reasons: ['new_address'], unlockAt: intText(NOW + DAY) },
  );
});

test('a withdrawal over the daily limit waits', () => {
  sameOutlook(
    baseVault({ windowSpent: 40n }),
    { amount: 20n, destination: knownDest, balance: 1_000n, now: NOW },
    { outcome: 'held', reasons: ['over_daily_limit'], unlockAt: intText(NOW + DAY) },
  );
});

test('a withdrawal over a quarter of the vault waits', () => {
  sameOutlook(
    baseVault({ dailyLimit: 10_000n, bigShareBps: 2500 }),
    { amount: 300n, destination: knownDest, balance: 1_000n, now: NOW },
    { outcome: 'held', reasons: ['over_share'], unlockAt: intText(NOW + DAY) },
  );
});

test('a withdrawal from a frozen vault waits', () => {
  sameOutlook(
    baseVault({ frozen: 1 }),
    { amount: 10n, destination: knownDest, balance: 1_000n, now: NOW },
    { outcome: 'held', reasons: ['frozen'], unlockAt: intText(NOW + DAY) },
  );
});

test('a withdrawal lists every blocking reason in program order', () => {
  sameOutlook(
    baseVault({ frozen: 1, dailyLimit: 10n, bigShareBps: 2500, known: [] }),
    { amount: 300n, destination: otherDest, balance: 1_000n, now: NOW },
    {
      outcome: 'held',
      reasons: ['frozen', 'new_address', 'over_daily_limit', 'over_share'],
      unlockAt: intText(NOW + DAY),
    },
  );
});

test('a withdrawal the vault cannot cover is refused', () => {
  sameOutlook(
    baseVault({ frozen: 1 }),
    { amount: 2_000n, destination: otherDest, balance: 1_000n, now: NOW },
    { outcome: 'refused', reason: 'insufficient_funds' },
  );
});

test('a ninth withdrawal is refused when eight are already waiting', () => {
  const pending = Array.from({ length: 8 }, (_, index) => ({
    id: BigInt(index + 1),
    amount: 1n,
    destination: knownDest,
    unlockAt: NOW + DAY,
    status: 1,
  }));
  sameOutlook(
    baseVault({ pending }),
    { amount: 10n, destination: otherDest, balance: 1_000n, now: NOW },
    { outcome: 'refused', reason: 'pending_full' },
  );
});

test('the oldest hourly bucket still holds a withdrawal at the old window edge', () => {
  sameOutlook(
    baseVault({ windowStart: NOW - DAY, windowSpent: 40n }),
    { amount: 20n, destination: knownDest, balance: 1_000n, now: NOW },
    { outcome: 'held', reasons: ['over_daily_limit'], unlockAt: intText(NOW + DAY) },
  );
});

function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (
      name === 'node_modules' ||
      name === 'e2e' ||
      name === '.expo' ||
      name === 'dist' ||
      name === 'android' ||
      name === 'ios' ||
      name === 'web-build'
    ) {
      continue;
    }
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      found.push(...productionSources(full));
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) continue;
    found.push(full);
  }
  return found;
}

const SDK_IMPORT = /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"](?:[^'"]*sdk\/|@veto-hq\/agent-sdk)/;
const NODE_CRYPTO = /['"]node:crypto['"]|from\s+['"]crypto['"]|require\(\s*['"]crypto['"]\s*\)|node-crypto/;

test('the hold client does not import the sdk or node crypto', () => {
  for (const name of ['holdIdl.ts', 'holdTx.ts', 'holdRead.ts']) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.equal(source.includes('sdk/'), false, name);
    assert.equal(source.includes('node:crypto'), false, name);
    assert.equal(source.includes('node-crypto'), false, name);
  }
});

test('shipped app modules do not import the sdk or node crypto', () => {
  const offenders: string[] = [];
  for (const file of productionSources(APP_ROOT)) {
    const source = readFileSync(file, 'utf8');
    if (SDK_IMPORT.test(source) || NODE_CRYPTO.test(source)) {
      offenders.push(path.relative(APP_ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});


test('all 25 rolling buckets preserve signed hours and large amounts in both clients', () => {
  const buckets = Array.from({ length: 25 }, (_, i) => ({ hour: BigInt(i - 1), amount: 9007199254740993n + BigInt(i) }));
  const vaultKey = Keypair.generate().publicKey;
  const data = vaultBytes(baseVault({ dailyBuckets: buckets }));
  assert.deepEqual(decodeHoldVault(data, vaultKey).dailyBuckets, buckets);
  assert.deepEqual(sdkDecodeHoldVault(data, vaultKey).dailyBuckets, buckets);
  assert.throws(() => decodeHoldVault(data.subarray(0, 1291), vaultKey), /1691/);
  assert.throws(() => sdkDecodeHoldVault(data.subarray(0, 1291), vaultKey), /1691/);
});

test('rolling preview counts multiple hours and future buckets after a clock rewind', () => {
  const hour = NOW / 3600n;
  sameOutlook(
    baseVault({ dailyBuckets: [
      { hour: hour - 24n, amount: 15n },
      { hour: hour - 1n, amount: 15n },
      { hour: hour + 1n, amount: 15n },
      { hour: hour - 25n, amount: 1000n },
    ] }),
    { amount: 10n, destination: knownDest, balance: 1000n, now: NOW },
    { outcome: 'held', reasons: ['over_daily_limit'], unlockAt: intText(NOW + DAY) },
  );
});

test('the share preview holds a burst across the old window edge', () => {
  sameOutlook(
    baseVault({
      dailyLimit: 10_000n,
      bigShareBps: 2_500,
      windowStart: NOW - DAY,
      windowSpent: 201n,
      dailyBuckets: [{ hour: (NOW - 1n) / 3600n, amount: 201n }],
    }),
    { amount: 100n, destination: knownDest, balance: 800n, now: NOW },
    { outcome: 'held', reasons: ['over_share'], unlockAt: intText(NOW + DAY) },
  );
});

test('legacy display preserves rules and blocks withdrawal previews until migration', () => {
  const vaultKey = Keypair.generate().publicKey;
  const legacy = vaultBytes(baseVault({})).subarray(0, 1291);
  const account = decodeHoldVault(legacy, vaultKey, true);
  assert.equal(account.migrationRequired, true);
  assert.equal(account.dailyLimit, legacy.readBigUInt64LE(176));
  assert.throws(() => holdWithdrawalOutlook(account, {
    amount: 1n, destination: knownDest, balance: 1000n, now: NOW,
  }), /Update this vault/);
});
