import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  MIGRATE_HOLD_VAULT_DISCRIMINATOR,
  CLOSE_HOLD_VAULT_DISCRIMINATOR,
  APPLY_CHANGE_DISCRIMINATOR,
  CANCEL_CHANGE_DISCRIMINATOR,
  DEPOSIT_DISCRIMINATOR,
  EXECUTE_HOLD_DISCRIMINATOR,
  FREEZE_DISCRIMINATOR,
  HOLD_LEDGER_DISCRIMINATOR,
  HOLD_VAULT_DISCRIMINATOR,
  INIT_VAULT_DISCRIMINATOR,
  PROGRAM_ID,
  PROPOSE_CHANGE_DISCRIMINATOR,
  RECOVER_DISCRIMINATOR,
  SKIP_DISCRIMINATOR,
  STOP_DISCRIMINATOR,
  UNFREEZE_DISCRIMINATOR,
  WITHDRAW_DISCRIMINATOR,
} from "./idl.js";
import { asU64, toPublicKey, u64Le } from "./layout.js";

/** Remembered destination token accounts. A full list does not grow. */
export const HOLD_KNOWN_CAPACITY = 16;
/** Concurrent held withdrawals. A full list refuses the next hold. */
export const HOLD_PENDING_CAPACITY = 8;
/** Decisions kept on the hold ledger. Older ones fall out of the ring. */
export const HOLD_LEDGER_CAPACITY = 32;
export const HOLD_WINDOW_SECS = 86_400n;
export const HOLD_BUCKET_SECS = 3_600n;
export const HOLD_BUCKET_COUNT = 25;
export const HOLD_BPS_DENOMINATOR = 10_000n;

const WITHDRAWAL_PENDING = 1;
const VAULT_LEN = 1691;
const LEDGER_LEN = 2096;
const ENTRY_SIZE = 64;
const ENTRY_BASE = 48;
const PENDING_SIZE = 57;

const OFF_OWNER = 8;
const OFF_GUARDIAN = 40;
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
const NO_PUBKEY = PublicKey.default;

export type PendingWithdrawal = {
  id: bigint;
  amount: bigint;
  destination: PublicKey;
  unlockAt: bigint;
  status: number;
};

export type PendingChange = {
  active: boolean;
  fields: number;
  bigShareBps: number;
  dailyLimit: bigint;
  delaySecs: bigint;
  guardian: PublicKey;
  safeAddress: PublicKey;
  effectiveAt: bigint;
};

export type HoldVaultAccount = {
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
  /** Destination token accounts this vault has already paid, in list order. */
  known: PublicKey[];
  /** Withdrawals that are still waiting. Empty slots are left out. */
  pending: PendingWithdrawal[];
  change: PendingChange;
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

export type HoldLedgerAccount = {
  address: PublicKey;
  vault: PublicKey;
  total: number;
  head: number;
  bump: number;
  /** Live ring entries, oldest first. */
  entries: HoldLedgerEntry[];
};

export type HoldVaultView = {
  account: HoldVaultAccount;
  pending: PendingWithdrawal[];
  ledger: HoldLedgerAccount;
};

export type SentHoldTx = {
  signature: string;
  vault: PublicKey;
  ledger: PublicKey;
  vaultToken: PublicKey;
};

/** Why an immediate payment is blocked. Order matches the program's checks. */
export type HoldWaitReason = "frozen" | "new_address" | "over_daily_limit" | "over_share";

export type WithdrawalOutlook =
  | { outcome: "at_once" }
  | { outcome: "held"; reasons: HoldWaitReason[]; unlockAt: bigint }
  | { outcome: "refused"; reason: "insufficient_funds" | "pending_full" };

export type HoldVaultArgs = {
  connection: Connection;
  programId?: PublicKey | string;
};

type TokenProgram = PublicKey | string | undefined;

/** PDA seeds: "hold", owner, vault id as a u64 little-endian. */
export function holdVaultPda(programId: PublicKey, owner: PublicKey, vaultId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hold"), owner.toBuffer(), u64Le(vaultId)],
    programId,
  );
  return pda;
}

/** PDA seeds: "hold-ledger", vault address. */
export function holdLedgerPda(programId: PublicKey, vault: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hold-ledger"), vault.toBuffer()],
    programId,
  );
  return pda;
}

/** PDA seeds: "hold-token", vault address. The program owns this token account. */
export function holdTokenPda(programId: PublicKey, vault: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hold-token"), vault.toBuffer()],
    programId,
  );
  return pda;
}

function asI64(value: bigint | number, field: string): bigint {
  const v = typeof value === "bigint" ? value : safeInt(value, field);
  if (v < I64_MIN || v > I64_MAX) throw new Error(`${field} is outside i64`);
  return v;
}

function safeInt(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer or a bigint`);
  }
  return BigInt(value);
}

function asU16(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${field} must be an integer from 0 to 65535`);
  }
  return value;
}

function addI64(left: bigint, right: bigint, field: string): bigint {
  const sum = left + right;
  if (sum < I64_MIN || sum > I64_MAX) throw new Error(`${field} overflows i64`);
  return sum;
}

function tokenProgramOf(value: TokenProgram, field: string): PublicKey {
  if (value === undefined) return TOKEN_PROGRAM_ID;
  return toPublicKey(value, field);
}

function requireDisc(data: Buffer, expected: Buffer, what: string): void {
  if (data.length < expected.length || !data.subarray(0, expected.length).equals(expected)) {
    throw new Error(`${what} account discriminator mismatch`);
  }
}

function needLen(data: Buffer, length: number, what: string): void {
  if (data.length < length) throw new Error(`${what} account is ${data.length} bytes, need ${length}`);
}

export function decodeHoldVault(data: Buffer, address: PublicKey): HoldVaultAccount {
  requireDisc(data, HOLD_VAULT_DISCRIMINATOR, "Hold vault");
  if (data.length === 1291) throw new Error("Legacy Hold vault: owner must call migrateHoldVault for the 1691 byte layout before use");
  needLen(data, VAULT_LEN, "Hold vault");
  const knownLen = Math.min(data.readUInt8(OFF_KNOWN_LEN), HOLD_KNOWN_CAPACITY);
  const known: PublicKey[] = [];
  for (let i = 0; i < knownLen; i += 1) {
    const off = OFF_KNOWN + i * 32;
    known.push(new PublicKey(data.subarray(off, off + 32)));
  }
  const pending: PendingWithdrawal[] = [];
  for (let i = 0; i < HOLD_PENDING_CAPACITY; i += 1) {
    const off = OFF_PENDING + i * PENDING_SIZE;
    const status = data.readUInt8(off + 56);
    if (status !== WITHDRAWAL_PENDING) continue;
    pending.push({
      id: data.readBigUInt64LE(off),
      amount: data.readBigUInt64LE(off + 8),
      destination: new PublicKey(data.subarray(off + 16, off + 48)),
      unlockAt: data.readBigInt64LE(off + 48),
      status,
    });
  }
  const changeAt = OFF_CHANGE;
  return {
    address,
    owner: new PublicKey(data.subarray(OFF_OWNER, OFF_OWNER + 32)),
    guardian: new PublicKey(data.subarray(OFF_GUARDIAN, OFF_GUARDIAN + 32)),
    safeAddress: new PublicKey(data.subarray(OFF_SAFE, OFF_SAFE + 32)),
    mint: new PublicKey(data.subarray(OFF_MINT, OFF_MINT + 32)),
    vaultToken: new PublicKey(data.subarray(OFF_VAULT_TOKEN, OFF_VAULT_TOKEN + 32)),
    vaultId: data.readBigUInt64LE(OFF_VAULT_ID),
    dailyLimit: data.readBigUInt64LE(OFF_DAILY),
    dailyBuckets: Array.from({ length: HOLD_BUCKET_COUNT }, (_, i) => ({
      hour: data.readBigInt64LE(OFF_DAILY_BUCKETS + i * BUCKET_SIZE),
      amount: data.readBigUInt64LE(OFF_DAILY_BUCKETS + i * BUCKET_SIZE + 8),
    })),
    windowSpent: data.readBigUInt64LE(OFF_WINDOW_SPENT),
    windowStart: data.readBigInt64LE(OFF_WINDOW_START),
    delaySecs: data.readBigInt64LE(OFF_DELAY),
    unfreezeAt: data.readBigInt64LE(OFF_UNFREEZE),
    nextWithdrawalId: data.readBigUInt64LE(OFF_NEXT_ID),
    bigShareBps: data.readUInt16LE(OFF_BPS),
    frozen: data.readUInt8(OFF_FROZEN) !== 0,
    known,
    pending,
    change: {
      active: data.readUInt8(changeAt) !== 0,
      fields: data.readUInt8(changeAt + 1),
      bigShareBps: data.readUInt16LE(changeAt + 2),
      dailyLimit: data.readBigUInt64LE(changeAt + 4),
      delaySecs: data.readBigInt64LE(changeAt + 12),
      guardian: new PublicKey(data.subarray(changeAt + 20, changeAt + 52)),
      safeAddress: new PublicKey(data.subarray(changeAt + 52, changeAt + 84)),
      effectiveAt: data.readBigInt64LE(changeAt + 84),
    },
    bump: data.readUInt8(OFF_BUMP),
    tokenBump: data.readUInt8(OFF_TOKEN_BUMP),
    ledgerBump: data.readUInt8(OFF_LEDGER_BUMP),
  };
}

export function decodeHoldLedger(data: Buffer, address: PublicKey): HoldLedgerAccount {
  requireDisc(data, HOLD_LEDGER_DISCRIMINATOR, "Hold ledger");
  needLen(data, LEDGER_LEN, "Hold ledger");
  const total = data.readUInt32LE(40);
  const head = data.readUInt16LE(44);
  const live = Math.min(total, HOLD_LEDGER_CAPACITY);
  const start = total >= HOLD_LEDGER_CAPACITY ? head % HOLD_LEDGER_CAPACITY : 0;
  const entries: HoldLedgerEntry[] = [];
  for (let n = 0; n < live; n += 1) {
    const index = (start + n) % HOLD_LEDGER_CAPACITY;
    const off = ENTRY_BASE + index * ENTRY_SIZE;
    entries.push({
      ts: data.readBigInt64LE(off),
      amount: data.readBigUInt64LE(off + 8),
      destination: new PublicKey(data.subarray(off + 16, off + 48)),
      withdrawalId: data.readBigUInt64LE(off + 48),
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
    throw new Error("HoldVault.previewWithdrawal: big_share_bps is outside 0 to 10000");
  }
  const denom = HOLD_BPS_DENOMINATOR;
  const share = BigInt(bps);
  const whole = balance / denom;
  const rem = balance % denom;
  return whole * share + (rem * share) / denom;
}

/**
 * Says whether a withdrawal would pay at once or wait, and why.
 * `destination` is the destination token account. `balance` is the vault
 * token account's current amount. `now` is the chain clock, in unix seconds.
 * A reason is listed for every rule that blocks an immediate payment.
 */
export function withdrawalOutlook(
  vault: HoldVaultAccount,
  args: {
    amount: bigint | number;
    destination: PublicKey | string;
    balance: bigint | number;
    now: bigint | number;
  },
): WithdrawalOutlook {
  const amount = asU64(args.amount, "HoldVault.previewWithdrawal amount");
  const balance = asU64(args.balance, "HoldVault.previewWithdrawal balance");
  const now = asI64(args.now, "HoldVault.previewWithdrawal now");
  const destination = toPublicKey(args.destination, "HoldVault.previewWithdrawal destination");
  if (amount === 0n) throw new Error("HoldVault.previewWithdrawal: amount must be positive");
  if (amount > balance) return { outcome: "refused", reason: "insufficient_funds" };
  const reasons: HoldWaitReason[] = [];
  if (vault.frozen) reasons.push("frozen");
  if (!vault.known.some((key) => key.equals(destination))) reasons.push("new_address");
  // BigInt division truncates toward zero; chain hours use floor division.
  const hour = now >= 0n ? now / HOLD_BUCKET_SECS : (now - HOLD_BUCKET_SECS + 1n) / HOLD_BUCKET_SECS;
  const dailyNext = vault.dailyBuckets.filter((bucket) => bucket.hour >= hour - 24n)
    .reduce((total, bucket) => total + bucket.amount, amount);
  if (dailyNext > U64_MAX || dailyNext > vault.dailyLimit) reasons.push("over_daily_limit");
  if (dailyNext > shareCap(balance, vault.bigShareBps)) reasons.push("over_share");
  if (reasons.length === 0) return { outcome: "at_once" };
  if (vault.pending.length >= HOLD_PENDING_CAPACITY) {
    return { outcome: "refused", reason: "pending_full" };
  }
  return {
    outcome: "held",
    reasons,
    unlockAt: addI64(now, vault.delaySecs, "HoldVault.previewWithdrawal unlock"),
  };
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}

function u64Data(disc: Buffer, value: bigint): Buffer {
  const data = Buffer.alloc(16);
  disc.copy(data, 0);
  data.writeBigUInt64LE(value, 8);
  return data;
}

function discData(disc: Buffer): Buffer {
  return Buffer.from(disc);
}

type Derived = { vault: PublicKey; ledger: PublicKey; vaultToken: PublicKey };

function derived(programId: PublicKey, owner: PublicKey, vaultId: bigint): Derived {
  const vault = holdVaultPda(programId, owner, vaultId);
  return { vault, ledger: holdLedgerPda(programId, vault), vaultToken: holdTokenPda(programId, vault) };
}

function ix(programId: PublicKey, keys: AccountMeta[], data: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data });
}

async function sendInstruction(
  connection: Connection,
  feePayer: Keypair,
  instruction: TransactionInstruction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  let latest: { blockhash: string; lastValidBlockHeight: number };
  try {
    latest = await connection.getLatestBlockhash("confirmed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: ${message}`, { cause: err });
  }
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
  tx.add(instruction);
  const unique = new Map<string, Keypair>();
  unique.set(feePayer.publicKey.toBase58(), feePayer);
  for (const signer of signers) unique.set(signer.publicKey.toBase58(), signer);
  tx.sign(...unique.values());
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: ${message}`, { cause: err });
  }
  const confirmed = await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (confirmed.value.err) {
    throw new Error(`${label}: transaction ${signature} failed: ${JSON.stringify(confirmed.value.err)}`);
  }
  return signature;
}

async function ownedAccount(
  connection: Connection,
  address: PublicKey,
  programId: PublicKey,
  what: string,
): Promise<Buffer> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`${what}: account not found: ${address.toBase58()}`);
  if (!info.owner.equals(programId)) {
    throw new Error(`${what}: ${address.toBase58()} is not owned by the Veto program`);
  }
  return Buffer.from(info.data);
}

export class HoldVault {
  readonly connection: Connection;
  readonly programId: PublicKey;

  constructor(args: HoldVaultArgs) {
    this.connection = args.connection;
    this.programId = args.programId === undefined ? PROGRAM_ID : toPublicKey(args.programId, "HoldVault programId");
  }

  async initVault(args: {
    owner: Keypair;
    vaultId: bigint | number;
    guardian?: PublicKey | string;
    safeAddress: PublicKey | string;
    dailyLimit: bigint | number;
    delaySecs: bigint | number;
    bigShareBps: number;
    mint: PublicKey | string;
    tokenProgram?: PublicKey | string;
  }): Promise<SentHoldTx> {
    const label = "HoldVault.initVault";
    const vaultId = asU64(args.vaultId, `${label} vaultId`);
    const guardian = args.guardian === undefined ? NO_PUBKEY : toPublicKey(args.guardian, `${label} guardian`);
    const safeAddress = toPublicKey(args.safeAddress, `${label} safeAddress`);
    const dailyLimit = asU64(args.dailyLimit, `${label} dailyLimit`);
    const delaySecs = asI64(args.delaySecs, `${label} delaySecs`);
    const bigShareBps = asU16(args.bigShareBps, `${label} bigShareBps`);
    const mint = toPublicKey(args.mint, `${label} mint`);
    const tokenProgram = tokenProgramOf(args.tokenProgram, `${label} tokenProgram`);
    const where = derived(this.programId, args.owner.publicKey, vaultId);
    const data = Buffer.alloc(98);
    INIT_VAULT_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(vaultId, 8);
    guardian.toBuffer().copy(data, 16);
    safeAddress.toBuffer().copy(data, 48);
    data.writeBigUInt64LE(dailyLimit, 80);
    data.writeBigInt64LE(delaySecs, 88);
    data.writeUInt16LE(bigShareBps, 96);
    const instruction = ix(this.programId, [
      meta(args.owner.publicKey, true, true),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(where.vaultToken, false, true),
      meta(mint, false, false),
      meta(tokenProgram, false, false),
      meta(SystemProgram.programId, false, false),
    ], data);
    const signature = await sendInstruction(this.connection, args.owner, instruction, [args.owner], label);
    return { signature, ...where };
  }

  async migrateHoldVault(args: { owner: Keypair; vaultId: bigint | number }): Promise<SentHoldTx> {
    const where = derived(this.programId, args.owner.publicKey, asU64(args.vaultId, "vaultId"));
    const instruction = ix(this.programId, [
      meta(args.owner.publicKey, true, true), meta(where.vault, false, true),
      meta(SystemProgram.programId, false, false),
    ], discData(MIGRATE_HOLD_VAULT_DISCRIMINATOR));
    const signature = await sendInstruction(this.connection, args.owner, instruction, [args.owner], "HoldVault.migrateHoldVault");
    return { signature, ...where };
  }

  async closeHoldVault(args: {
    owner: Keypair; vaultId: bigint | number; destination: PublicKey | string;
    mint: PublicKey | string; tokenProgram?: PublicKey | string;
  }): Promise<SentHoldTx> {
    const where = derived(this.programId, args.owner.publicKey, asU64(args.vaultId, "vaultId"));
    const instruction = ix(this.programId, [
      meta(args.owner.publicKey, true, true), meta(where.vault, false, true),
      meta(where.ledger, false, true), meta(where.vaultToken, false, true),
      meta(toPublicKey(args.destination, "destination"), false, true),
      meta(toPublicKey(args.mint, "mint"), false, false),
      meta(tokenProgramOf(args.tokenProgram, "tokenProgram"), false, false),
    ], discData(CLOSE_HOLD_VAULT_DISCRIMINATOR));
    const signature = await sendInstruction(this.connection, args.owner, instruction, [args.owner], "HoldVault.closeHoldVault");
    return { signature, ...where };
  }

  async deposit(args: {
    owner: Keypair;
    vaultId: bigint | number;
    source: PublicKey | string;
    mint: PublicKey | string;
    amount: bigint | number;
    tokenProgram?: PublicKey | string;
  }): Promise<SentHoldTx> {
    const label = "HoldVault.deposit";
    const where = derived(this.programId, args.owner.publicKey, asU64(args.vaultId, `${label} vaultId`));
    const amount = asU64(args.amount, `${label} amount`);
    const instruction = ix(this.programId, [
      meta(args.owner.publicKey, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(toPublicKey(args.source, `${label} source`), false, true),
      meta(where.vaultToken, false, true),
      meta(toPublicKey(args.mint, `${label} mint`), false, false),
      meta(tokenProgramOf(args.tokenProgram, `${label} tokenProgram`), false, false),
    ], u64Data(DEPOSIT_DISCRIMINATOR, amount));
    const signature = await sendInstruction(this.connection, args.owner, instruction, [args.owner], label);
    return { signature, ...where };
  }

  async withdraw(args: {
    owner: Keypair;
    vaultId: bigint | number;
    destination: PublicKey | string;
    mint: PublicKey | string;
    amount: bigint | number;
    tokenProgram?: PublicKey | string;
  }): Promise<SentHoldTx> {
    const label = "HoldVault.withdraw";
    const where = derived(this.programId, args.owner.publicKey, asU64(args.vaultId, `${label} vaultId`));
    const amount = asU64(args.amount, `${label} amount`);
    const instruction = ix(this.programId, [
      meta(args.owner.publicKey, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(where.vaultToken, false, true),
      meta(toPublicKey(args.destination, `${label} destination`), false, true),
      meta(toPublicKey(args.mint, `${label} mint`), false, false),
      meta(tokenProgramOf(args.tokenProgram, `${label} tokenProgram`), false, false),
    ], u64Data(WITHDRAW_DISCRIMINATOR, amount));
    const signature = await sendInstruction(this.connection, args.owner, instruction, [args.owner], label);
    return { signature, ...where };
  }

  async execute(args: {
    payer: Keypair;
    owner: PublicKey | string;
    vaultId: bigint | number;
    destination: PublicKey | string;
    mint: PublicKey | string;
    id: bigint | number;
    tokenProgram?: PublicKey | string;
  }): Promise<SentHoldTx> {
    const label = "HoldVault.execute";
    const owner = toPublicKey(args.owner, `${label} owner`);
    const where = derived(this.programId, owner, asU64(args.vaultId, `${label} vaultId`));
    const instruction = ix(this.programId, [
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(where.vaultToken, false, true),
      meta(toPublicKey(args.destination, `${label} destination`), false, true),
      meta(toPublicKey(args.mint, `${label} mint`), false, false),
      meta(tokenProgramOf(args.tokenProgram, `${label} tokenProgram`), false, false),
    ], u64Data(EXECUTE_HOLD_DISCRIMINATOR, asU64(args.id, `${label} id`)));
    const signature = await sendInstruction(this.connection, args.payer, instruction, [args.payer], label);
    return { signature, ...where };
  }

  async stop(args: {
    authority: Keypair;
    owner: PublicKey | string;
    vaultId: bigint | number;
    id: bigint | number;
  }): Promise<SentHoldTx> {
    return this.authorityIx("HoldVault.stop", STOP_DISCRIMINATOR, args, asU64(args.id, "HoldVault.stop id"));
  }

  async freeze(args: {
    authority: Keypair;
    owner: PublicKey | string;
    vaultId: bigint | number;
  }): Promise<SentHoldTx> {
    return this.authorityIx("HoldVault.freeze", FREEZE_DISCRIMINATOR, args, null);
  }

  async unfreeze(args: {
    owner: Keypair;
    guardian?: Keypair;
    vaultId: bigint | number;
  }): Promise<SentHoldTx> {
    const label = "HoldVault.unfreeze";
    const where = derived(this.programId, args.owner.publicKey, asU64(args.vaultId, `${label} vaultId`));
    const guardian = args.guardian === undefined
      ? meta(this.programId, false, false)
      : meta(args.guardian.publicKey, true, false);
    const instruction = ix(this.programId, [
      meta(args.owner.publicKey, true, false),
      guardian,
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
    ], discData(UNFREEZE_DISCRIMINATOR));
    const signers = args.guardian === undefined ? [args.owner] : [args.owner, args.guardian];
    const signature = await sendInstruction(this.connection, args.owner, instruction, signers, label);
    return { signature, ...where };
  }

  async skip(args: {
    owner: Keypair;
    guardian: Keypair;
    vaultId: bigint | number;
    destination: PublicKey | string;
    mint: PublicKey | string;
    id: bigint | number;
    tokenProgram?: PublicKey | string;
  }): Promise<SentHoldTx> {
    const label = "HoldVault.skip";
    const where = derived(this.programId, args.owner.publicKey, asU64(args.vaultId, `${label} vaultId`));
    const instruction = ix(this.programId, [
      meta(args.owner.publicKey, true, false),
      meta(args.guardian.publicKey, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(where.vaultToken, false, true),
      meta(toPublicKey(args.destination, `${label} destination`), false, true),
      meta(toPublicKey(args.mint, `${label} mint`), false, false),
      meta(tokenProgramOf(args.tokenProgram, `${label} tokenProgram`), false, false),
    ], u64Data(SKIP_DISCRIMINATOR, asU64(args.id, `${label} id`)));
    const signature = await sendInstruction(
      this.connection,
      args.owner,
      instruction,
      [args.owner, args.guardian],
      label,
    );
    return { signature, ...where };
  }

  async recover(args: {
    authority: Keypair;
    owner: PublicKey | string;
    vaultId: bigint | number;
    destination: PublicKey | string;
    mint: PublicKey | string;
    tokenProgram?: PublicKey | string;
  }): Promise<SentHoldTx> {
    const label = "HoldVault.recover";
    const owner = toPublicKey(args.owner, `${label} owner`);
    const where = derived(this.programId, owner, asU64(args.vaultId, `${label} vaultId`));
    const instruction = ix(this.programId, [
      meta(args.authority.publicKey, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(where.vaultToken, false, true),
      meta(toPublicKey(args.destination, `${label} destination`), false, true),
      meta(toPublicKey(args.mint, `${label} mint`), false, false),
      meta(tokenProgramOf(args.tokenProgram, `${label} tokenProgram`), false, false),
    ], discData(RECOVER_DISCRIMINATOR));
    const signature = await sendInstruction(this.connection, args.authority, instruction, [args.authority], label);
    return { signature, ...where };
  }

  async proposeChange(args: {
    owner: Keypair;
    vaultId: bigint | number;
    dailyLimit: bigint | number;
    delaySecs: bigint | number;
    bigShareBps: number;
    guardian: PublicKey | string;
    safeAddress: PublicKey | string;
  }): Promise<SentHoldTx> {
    const label = "HoldVault.proposeChange";
    const where = derived(this.programId, args.owner.publicKey, asU64(args.vaultId, `${label} vaultId`));
    const dailyLimit = asU64(args.dailyLimit, `${label} dailyLimit`);
    const delaySecs = asI64(args.delaySecs, `${label} delaySecs`);
    const bigShareBps = asU16(args.bigShareBps, `${label} bigShareBps`);
    const guardian = toPublicKey(args.guardian, `${label} guardian`);
    const safeAddress = toPublicKey(args.safeAddress, `${label} safeAddress`);
    const data = Buffer.alloc(90);
    PROPOSE_CHANGE_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(dailyLimit, 8);
    data.writeBigInt64LE(delaySecs, 16);
    data.writeUInt16LE(bigShareBps, 24);
    guardian.toBuffer().copy(data, 26);
    safeAddress.toBuffer().copy(data, 58);
    const instruction = ix(this.programId, [
      meta(args.owner.publicKey, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
    ], data);
    const signature = await sendInstruction(this.connection, args.owner, instruction, [args.owner], label);
    return { signature, ...where };
  }

  async applyChange(args: {
    payer: Keypair;
    owner: PublicKey | string;
    vaultId: bigint | number;
  }): Promise<SentHoldTx> {
    const label = "HoldVault.applyChange";
    const owner = toPublicKey(args.owner, `${label} owner`);
    const where = derived(this.programId, owner, asU64(args.vaultId, `${label} vaultId`));
    const instruction = ix(this.programId, [
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
    ], discData(APPLY_CHANGE_DISCRIMINATOR));
    const signature = await sendInstruction(this.connection, args.payer, instruction, [args.payer], label);
    return { signature, ...where };
  }

  async cancelChange(args: {
    authority: Keypair;
    owner: PublicKey | string;
    vaultId: bigint | number;
  }): Promise<SentHoldTx> {
    return this.authorityIx("HoldVault.cancelChange", CANCEL_CHANGE_DISCRIMINATOR, args, null);
  }

  async fetchVault(address: PublicKey | string): Promise<HoldVaultAccount> {
    const key = toPublicKey(address, "HoldVault.fetchVault");
    try {
      return decodeHoldVault(await ownedAccount(this.connection, key, this.programId, "HoldVault.fetchVault"), key);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("HoldVault.fetchVault:")) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`HoldVault.fetchVault: ${message}`, { cause: err });
    }
  }

  async fetchLedger(address: PublicKey | string): Promise<HoldLedgerAccount> {
    const key = toPublicKey(address, "HoldVault.fetchLedger");
    try {
      return decodeHoldLedger(await ownedAccount(this.connection, key, this.programId, "HoldVault.fetchLedger"), key);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("HoldVault.fetchLedger:")) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`HoldVault.fetchLedger: ${message}`, { cause: err });
    }
  }

  /** The vault account, its live pending withdrawals, and its ledger. */
  async readVault(address: PublicKey | string): Promise<HoldVaultView> {
    const account = await this.fetchVault(address);
    const ledger = await this.fetchLedger(holdLedgerPda(this.programId, account.address));
    return { account, pending: account.pending, ledger };
  }

  /**
   * Reads the vault and its token balance, then says whether this withdrawal
   * would pay at once or be held.
   */
  async previewWithdrawal(args: {
    vault: PublicKey | string;
    amount: bigint | number;
    destination: PublicKey | string;
    now?: bigint | number;
  }): Promise<WithdrawalOutlook> {
    const account = await this.fetchVault(args.vault);
    const info = await this.connection.getAccountInfo(account.vaultToken, "confirmed");
    if (!info) {
      throw new Error(
        `HoldVault.previewWithdrawal: token account not found: ${account.vaultToken.toBase58()}`,
      );
    }
    const data = Buffer.from(info.data);
    if (data.length < 72) {
      throw new Error(
        `HoldVault.previewWithdrawal: token account ${account.vaultToken.toBase58()} is too short`,
      );
    }
    const now = args.now === undefined ? BigInt(Math.floor(Date.now() / 1000)) : args.now;
    return withdrawalOutlook(account, {
      amount: args.amount,
      destination: args.destination,
      balance: data.readBigUInt64LE(64),
      now,
    });
  }

  private async authorityIx(
    label: string,
    disc: Buffer,
    args: { authority: Keypair; owner: PublicKey | string; vaultId: bigint | number },
    id: bigint | null,
  ): Promise<SentHoldTx> {
    const owner = toPublicKey(args.owner, `${label} owner`);
    const where = derived(this.programId, owner, asU64(args.vaultId, `${label} vaultId`));
    const data = id === null ? discData(disc) : u64Data(disc, id);
    const instruction = ix(this.programId, [
      meta(args.authority.publicKey, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
    ], data);
    const signature = await sendInstruction(this.connection, args.authority, instruction, [args.authority], label);
    return { signature, ...where };
  }
}
