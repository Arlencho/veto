import { Buffer } from 'buffer';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';

import {
  MIGRATE_HOLD_VAULT_DISC,
  CLOSE_HOLD_VAULT_DISC,
  DEPOSIT_DISC,
  FREEZE_DISC,
  INIT_VAULT_DISC,
  RECOVER_DISC,
  SKIP_DISC,
  STOP_DISC,
  UNFREEZE_DISC,
  WITHDRAW_DISC,
} from './holdIdl';
import { holdLedgerPda, holdTokenPda, holdVaultPda, writeI64, writeU64 } from './holdRead';

export type HoldWhere = {
  vault: PublicKey;
  ledger: PublicKey;
  vaultToken: PublicKey;
};

export function holdWhere(programId: PublicKey, owner: PublicKey, vaultId: bigint): HoldWhere {
  const vault = holdVaultPda(programId, owner, vaultId);
  return {
    vault,
    ledger: holdLedgerPda(programId, vault),
    vaultToken: holdTokenPda(programId, vault),
  };
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}

function ix(programId: PublicKey, keys: AccountMeta[], data: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data });
}

function u64Data(disc: Buffer, value: bigint): Buffer {
  const data = Buffer.alloc(16);
  disc.copy(data, 0);
  writeU64(data, 8, value);
  return data;
}

export function initVaultInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
  guardian: PublicKey;
  safeAddress: PublicKey;
  dailyLimit: bigint;
  delaySecs: bigint;
  bigShareBps: number;
  mint: PublicKey;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  const data = Buffer.alloc(98);
  INIT_VAULT_DISC.copy(data, 0);
  writeU64(data, 8, args.vaultId);
  args.guardian.toBuffer().copy(data, 16);
  args.safeAddress.toBuffer().copy(data, 48);
  writeU64(data, 80, args.dailyLimit);
  writeI64(data, 88, args.delaySecs);
  data.writeUInt16LE(args.bigShareBps, 96);
  return ix(
    args.programId,
    [
      meta(args.owner, true, true),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(where.vaultToken, false, true),
      meta(args.mint, false, false),
      meta(args.tokenProgram ?? TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  );
}

export function depositInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
  source: PublicKey;
  mint: PublicKey;
  amount: bigint;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  return ix(
    args.programId,
    [
      meta(args.owner, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(args.source, false, true),
      meta(where.vaultToken, false, true),
      meta(args.mint, false, false),
      meta(args.tokenProgram ?? TOKEN_PROGRAM_ID, false, false),
    ],
    u64Data(DEPOSIT_DISC, args.amount),
  );
}

export function withdrawInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
  destination: PublicKey;
  mint: PublicKey;
  amount: bigint;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  return ix(
    args.programId,
    [
      meta(args.owner, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(where.vaultToken, false, true),
      meta(args.destination, false, true),
      meta(args.mint, false, false),
      meta(args.tokenProgram ?? TOKEN_PROGRAM_ID, false, false),
    ],
    u64Data(WITHDRAW_DISC, args.amount),
  );
}

export function stopInstruction(args: {
  programId: PublicKey;
  authority: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
  id: bigint;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  return ix(
    args.programId,
    [
      meta(args.authority, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
    ],
    u64Data(STOP_DISC, args.id),
  );
}

export function freezeInstruction(args: {
  programId: PublicKey;
  authority: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  return ix(
    args.programId,
    [
      meta(args.authority, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
    ],
    Buffer.from(FREEZE_DISC),
  );
}

export function recoverInstruction(args: {
  programId: PublicKey;
  authority: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
  destination: PublicKey;
  mint: PublicKey;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  return ix(
    args.programId,
    [
      meta(args.authority, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(where.vaultToken, false, true),
      meta(args.destination, false, true),
      meta(args.mint, false, false),
      meta(args.tokenProgram ?? TOKEN_PROGRAM_ID, false, false),
    ],
    Buffer.from(RECOVER_DISC),
  );
}

export function skipInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  guardian: PublicKey;
  vaultId: bigint;
  destination: PublicKey;
  mint: PublicKey;
  id: bigint;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  return ix(
    args.programId,
    [
      meta(args.owner, true, false),
      meta(args.guardian, true, false),
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
      meta(where.vaultToken, false, true),
      meta(args.destination, false, true),
      meta(args.mint, false, false),
      meta(args.tokenProgram ?? TOKEN_PROGRAM_ID, false, false),
    ],
    u64Data(SKIP_DISC, args.id),
  );
}

export function unfreezeInstruction(args: {
  programId: PublicKey;
  owner: PublicKey;
  guardian: PublicKey | null;
  vaultId: bigint;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  const guardian =
    args.guardian === null
      ? meta(args.programId, false, false)
      : meta(args.guardian, true, false);
  return ix(
    args.programId,
    [
      meta(args.owner, true, false),
      guardian,
      meta(where.vault, false, true),
      meta(where.ledger, false, true),
    ],
    Buffer.from(UNFREEZE_DISC),
  );
}

export function migrateHoldVaultInstruction(args: {
  programId: PublicKey; owner: PublicKey; vaultId: bigint;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  return ix(args.programId, [
    meta(args.owner, true, true), meta(where.vault, false, true),
    meta(SystemProgram.programId, false, false),
  ], Buffer.from(MIGRATE_HOLD_VAULT_DISC));
}

export function closeHoldVaultInstruction(args: {
  programId: PublicKey; owner: PublicKey; vaultId: bigint;
  destination: PublicKey; mint: PublicKey; tokenProgram?: PublicKey;
}): TransactionInstruction {
  const where = holdWhere(args.programId, args.owner, args.vaultId);
  return ix(args.programId, [
    meta(args.owner, true, true), meta(where.vault, false, true),
    meta(where.ledger, false, true), meta(where.vaultToken, false, true),
    meta(args.destination, false, true), meta(args.mint, false, false),
    meta(args.tokenProgram ?? TOKEN_PROGRAM_ID, false, false),
  ], Buffer.from(CLOSE_HOLD_VAULT_DISC));
}
