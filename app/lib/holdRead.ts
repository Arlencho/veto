import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

import { HOLD_LEDGER_DISC, HOLD_VAULT_DISC } from './holdIdl';

/** Current account size. Only the exact legacy size may be read for migration. */
export const HOLD_VAULT_LEN = 1691;
export const HOLD_LEDGER_LEN = 2096;
export const HOLD_OWNER_OFFSET = 8;
export const HOLD_GUARDIAN_OFFSET = 40;
export const HOLD_KNOWN_CAPACITY = 16;
export const HOLD_PENDING_CAPACITY = 8;
export const HOLD_LEDGER_CAPACITY = 32;
export const HOLD_WINDOW_SECS = 86_400n;
export const HOLD_BUCKET_SECS = 3_600n;
export const HOLD_BUCKET_COUNT = 25;
export const HOLD_BPS_DENOMINATOR = 10_000n;

const WITHDRAWAL_PENDING = 1;
const ENTRY_SIZE = 64;
const ENTRY_BASE = 48;
const PENDING_SIZE = 57;
const OFF_SAFE = 72;
const OFF_MINT = 104;
const OFF_VAULT_TOKEN = 136;
const OFF_VAULT_ID = 168;
const OFF_DAILY = 176;
const OFF_WINDOW_SPENT = 184;
const OFF_WINDOW_START = 192;
const OFF_DELAY = 200;
const OFF_UNFREEZE = 208;
const OFF_NEXT_ID = 216;
const OFF_BPS = 224;
const OFF_FROZEN = 226;
const OFF_KNOWN_LEN = 227;
const OFF_BUMP = 228;
const OFF_TOKEN_BUMP = 229;
const OFF_LEDGER_BUMP = 230;
const OFF_KNOWN = 231;
const OFF_PENDING = 743;
const OFF_CHANGE = 1199;
const OFF_DAILY_BUCKETS = 1291;
const BUCKET_SIZE = 16;
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

export type HoldPending = {
  id: bigint;
  amount: bigint;
  destination: PublicKey;
  unlockAt: bigint;
  status: number;
};

export type HoldChange = {
  active: boolean;
  fields: number;
  bigShareBps: number;
  dailyLimit: bigint;
  delaySecs: bigint;
  guardian: PublicKey;
  safeAddress: PublicKey;
  effectiveAt: bigint;
};

export type HoldAccount = {
  migrationRequired?: boolean;
  address: PublicKey;
  owner: PublicKey;
  guardian: PublicKey;
  safeAddress: PublicKey;
  mint: PublicKey;
  vaultToken: PublicKey;
  vaultId: bigint;
  dailyLimit: bigint;
  dailyBuckets: { hour: bigint; amount: bigint }[];
  /** Legacy window total retained for layout migration. */
  windowSpent: bigint;
  windowStart: bigint;
  delaySecs: bigint;
  unfreezeAt: bigint;
  nextWithdrawalId: bigint;
  bigShareBps: number;
  frozen: boolean;
  known: PublicKey[];
  pending: HoldPending[];
  change: HoldChange;
  bump: number;
  tokenBump: number;
  ledgerBump: number;
};

export type HoldLedgerEntry = {
  ts: bigint;
  amount: bigint;
  destination: PublicKey;
  withdrawalId: bigint;
  kind: number;
  reason: number;
};

export type HoldLedger = {
  address: PublicKey;
  vault: PublicKey;
  total: number;
  head: number;
  bump: number;
  entries: HoldLedgerEntry[];
};

export type HoldWaitReason = 'frozen' | 'new_address' | 'over_daily_limit' | 'over_share';

export type HoldOutlook =
  | { outcome: 'at_once' }
  | { outcome: 'held'; reasons: HoldWaitReason[]; unlockAt: bigint }
  | { outcome: 'refused'; reason: 'insufficient_funds' | 'pending_full' };

export function holdVaultPda(programId: PublicKey, owner: PublicKey, vaultId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('hold'), owner.toBuffer(), u64le(vaultId)],
    programId,
  );
  return pda;
}

export function holdLedgerPda(programId: PublicKey, vault: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('hold-ledger'), vault.toBuffer()],
    programId,
  );
  return pda;
}

export function holdTokenPda(programId: PublicKey, vault: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('hold-token'), vault.toBuffer()],
    programId,
  );
  return pda;
}

export function writeU64(data: Buffer, offset: number, value: bigint): void {
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    data[offset + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

export function writeI64(data: Buffer, offset: number, value: bigint): void {
  const wrapped = value < 0n ? value + 0x1_0000_0000_0000_0000n : value;
  writeU64(data, offset, wrapped);
}

export function readU64(data: Buffer, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value |= BigInt(data[offset + i] ?? 0) << (8n * BigInt(i));
  }
  return value;
}

export function readI64(data: Buffer, offset: number): bigint {
  const value = readU64(data, offset);
  return value >= 0x8000_0000_0000_0000n ? value - 0x1_0000_0000_0000_0000n : value;
}

function u64le(value: bigint): Buffer {
  const data = Buffer.alloc(8);
  writeU64(data, 0, value);
  return data;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function requireDisc(data: Buffer, expected: Buffer, what: string): void {
  if (data.length < expected.length || !sameBytes(data.subarray(0, expected.length), expected)) {
    throw new Error(`${what} account discriminator mismatch`);
  }
}

export function decodeHoldVault(data: Buffer, address: PublicKey, allowLegacy = false): HoldAccount {
  const migrationRequired = data.length === 1291;
  if (migrationRequired) {
    if (!allowLegacy) throw new Error('Legacy Hold vault: owner must migrate to the 1691 byte layout before use');
    data = Buffer.concat([data, Buffer.alloc(400)]);
  }
  requireDisc(data, HOLD_VAULT_DISC, 'Hold vault');
  if (data.length < HOLD_VAULT_LEN) {
    throw new Error(`Hold vault account is ${data.length} bytes, need ${HOLD_VAULT_LEN}`);
  }
  const knownLen = Math.min(data.readUInt8(OFF_KNOWN_LEN), HOLD_KNOWN_CAPACITY);
  const known: PublicKey[] = [];
  for (let i = 0; i < knownLen; i += 1) {
    const off = OFF_KNOWN + i * 32;
    known.push(new PublicKey(data.subarray(off, off + 32)));
  }
  const pending: HoldPending[] = [];
  for (let i = 0; i < HOLD_PENDING_CAPACITY; i += 1) {
    const off = OFF_PENDING + i * PENDING_SIZE;
    const status = data.readUInt8(off + 56);
    if (status !== WITHDRAWAL_PENDING) continue;
    pending.push({
      id: readU64(data, off),
      amount: readU64(data, off + 8),
      destination: new PublicKey(data.subarray(off + 16, off + 48)),
      unlockAt: readI64(data, off + 48),
      status,
    });
  }
  const changeAt = OFF_CHANGE;
  return {
    ...(migrationRequired ? { migrationRequired: true } : {}),
    address,
    owner: new PublicKey(data.subarray(HOLD_OWNER_OFFSET, HOLD_OWNER_OFFSET + 32)),
    guardian: new PublicKey(data.subarray(HOLD_GUARDIAN_OFFSET, HOLD_GUARDIAN_OFFSET + 32)),
    safeAddress: new PublicKey(data.subarray(OFF_SAFE, OFF_SAFE + 32)),
    mint: new PublicKey(data.subarray(OFF_MINT, OFF_MINT + 32)),
    vaultToken: new PublicKey(data.subarray(OFF_VAULT_TOKEN, OFF_VAULT_TOKEN + 32)),
    vaultId: readU64(data, OFF_VAULT_ID),
    dailyLimit: readU64(data, OFF_DAILY),
    dailyBuckets: Array.from({ length: HOLD_BUCKET_COUNT }, (_, i) => ({
      hour: readI64(data, OFF_DAILY_BUCKETS + i * BUCKET_SIZE),
      amount: readU64(data, OFF_DAILY_BUCKETS + i * BUCKET_SIZE + 8),
    })),
    windowSpent: readU64(data, OFF_WINDOW_SPENT),
    windowStart: readI64(data, OFF_WINDOW_START),
    delaySecs: readI64(data, OFF_DELAY),
    unfreezeAt: readI64(data, OFF_UNFREEZE),
    nextWithdrawalId: readU64(data, OFF_NEXT_ID),
    bigShareBps: data.readUInt16LE(OFF_BPS),
    frozen: data.readUInt8(OFF_FROZEN) !== 0,
    known,
    pending,
    change: {
      active: data.readUInt8(changeAt) !== 0,
      fields: data.readUInt8(changeAt + 1),
      bigShareBps: data.readUInt16LE(changeAt + 2),
      dailyLimit: readU64(data, changeAt + 4),
      delaySecs: readI64(data, changeAt + 12),
      guardian: new PublicKey(data.subarray(changeAt + 20, changeAt + 52)),
      safeAddress: new PublicKey(data.subarray(changeAt + 52, changeAt + 84)),
      effectiveAt: readI64(data, changeAt + 84),
    },
    bump: data.readUInt8(OFF_BUMP),
    tokenBump: data.readUInt8(OFF_TOKEN_BUMP),
    ledgerBump: data.readUInt8(OFF_LEDGER_BUMP),
  };
}

export function decodeHoldLedger(data: Buffer, address: PublicKey): HoldLedger {
  requireDisc(data, HOLD_LEDGER_DISC, 'Hold ledger');
  if (data.length < HOLD_LEDGER_LEN) {
    throw new Error(`Hold ledger account is ${data.length} bytes, need ${HOLD_LEDGER_LEN}`);
  }
  const total = data.readUInt32LE(40);
  const head = data.readUInt16LE(44);
  const live = Math.min(total, HOLD_LEDGER_CAPACITY);
  const start = total >= HOLD_LEDGER_CAPACITY ? head % HOLD_LEDGER_CAPACITY : 0;
  const entries: HoldLedgerEntry[] = [];
  for (let n = 0; n < live; n += 1) {
    const index = (start + n) % HOLD_LEDGER_CAPACITY;
    const off = ENTRY_BASE + index * ENTRY_SIZE;
    entries.push({
      ts: readI64(data, off),
      amount: readU64(data, off + 8),
      destination: new PublicKey(data.subarray(off + 16, off + 48)),
      withdrawalId: readU64(data, off + 48),
      kind: data.readUInt8(off + 56),
      reason: data.readUInt8(off + 57),
    });
  }
  return {
    address,
    vault: new PublicKey(data.subarray(8, 40)),
    total,
    head,
    bump: data.readUInt8(46),
    entries,
  };
}

function shareCap(balance: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > Number(HOLD_BPS_DENOMINATOR)) {
    throw new Error('big share is outside 0 to 10000');
  }
  const denom = HOLD_BPS_DENOMINATOR;
  const share = BigInt(bps);
  const whole = balance / denom;
  const rem = balance % denom;
  return whole * share + (rem * share) / denom;
}

function addI64(left: bigint, right: bigint): bigint {
  const sum = left + right;
  if (sum < I64_MIN || sum > I64_MAX) throw new Error('unlock time overflows');
  return sum;
}

/**
 * Whether a withdrawal pays at once or waits, using the same checks as the vault client.
 * `now` is the chain clock in unix seconds. `destination` is the destination token account.
 */
export function holdWithdrawalOutlook(
  vault: HoldAccount,
  args: { amount: bigint; destination: PublicKey; balance: bigint; now: bigint },
): HoldOutlook {
  if (vault.migrationRequired) throw new Error('Update this vault before previewing withdrawals.');
  const { amount, balance, now, destination } = args;
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount > balance) return { outcome: 'refused', reason: 'insufficient_funds' };
  const reasons: HoldWaitReason[] = [];
  if (vault.frozen) reasons.push('frozen');
  if (!vault.known.some((key) => key.equals(destination))) reasons.push('new_address');
  // BigInt division truncates toward zero; chain hours use floor division.
  const hour = now >= 0n ? now / HOLD_BUCKET_SECS : (now - HOLD_BUCKET_SECS + 1n) / HOLD_BUCKET_SECS;
  const dailyNext = vault.dailyBuckets.filter((bucket) => bucket.hour >= hour - 24n)
    .reduce((total, bucket) => total + bucket.amount, amount);
  if (dailyNext > U64_MAX || dailyNext > vault.dailyLimit) reasons.push('over_daily_limit');
  if (dailyNext > shareCap(balance, vault.bigShareBps)) reasons.push('over_share');
  if (reasons.length === 0) return { outcome: 'at_once' };
  if (vault.pending.length >= HOLD_PENDING_CAPACITY) {
    return { outcome: 'refused', reason: 'pending_full' };
  }
  return { outcome: 'held', reasons, unlockAt: addI64(now, vault.delaySecs) };
}

export function holdCreatedAt(
  vault: HoldAccount,
  row: HoldPending,
  entries: readonly HoldLedgerEntry[],
): bigint {
  let ts: bigint | null = null;
  for (const entry of entries) {
    if (entry.kind === 3 && entry.withdrawalId === row.id) ts = entry.ts;
  }
  if (ts !== null) return ts;
  if (row.unlockAt >= vault.delaySecs) return row.unlockAt - vault.delaySecs;
  return row.unlockAt;
}
