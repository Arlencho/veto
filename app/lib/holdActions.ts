import { PublicKey, type Transaction } from '@solana/web3.js';

import type { ChainClient, SignAndSend } from './chain';
import {
  compileHoldTransaction,
  createTokenAccountIx,
  ownerTokenAccount,
  readTokenAmount,
  resolveHoldDestination,
} from './holdChain';
import { SAFE_WALLET_GUIDANCE } from './holdSafeAddress';
import { HOLD_SHARE_BPS } from './hold';
import { holdVaultPda } from './holdRead';
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

async function send(
  client: ChainClient,
  signAndSend: SignAndSend,
  feePayer: PublicKey,
  instructions: Parameters<typeof compileHoldTransaction>[2],
): Promise<string> {
  const tx = await compileHoldTransaction(client.connection, feePayer, instructions);
  const [signature] = await signAndSend([tx]);
  if (!signature) throw new Error('The wallet returned no signature.');
  return signature;
}

export async function openHoldVault(args: {
  client: ChainClient;
  signAndSend: SignAndSend;
  owner: PublicKey;
  vaultId: bigint;
  guardian: PublicKey;
  safeAddress: PublicKey;
  dailyLimit: bigint;
  delaySecs: bigint;
  amount: bigint;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): Promise<{ signature: string; vault: PublicKey }> {
  if (args.safeAddress.equals(args.guardian)) throw new Error(SAFE_WALLET_GUIDANCE);
  const vault = holdVaultPda(args.client.programId, args.owner, args.vaultId);
  if (args.safeAddress.equals(vault)) {
    throw new Error('The safe address cannot be the vault itself.');
  }
  if (args.guardian.equals(args.owner)) {
    throw new Error('The guardian key has to be a different key from yours.');
  }
  if (args.guardian.equals(PublicKey.default) || args.safeAddress.equals(PublicKey.default)) {
    throw new Error('Choose a guardian key and a safe address.');
  }
  const source = ownerTokenAccount(args.mint, args.owner, args.tokenProgram);
  const balance = await readTokenAmount(args.client.connection, source);
  if (balance === null || balance < args.amount) {
    throw new Error('Your wallet does not hold that much of this token.');
  }
  const signature = await send(args.client, args.signAndSend, args.owner, [
    initVaultInstruction({
      programId: args.client.programId,
      owner: args.owner,
      vaultId: args.vaultId,
      guardian: args.guardian,
      safeAddress: args.safeAddress,
      dailyLimit: args.dailyLimit,
      delaySecs: args.delaySecs,
      bigShareBps: HOLD_SHARE_BPS,
      mint: args.mint,
      tokenProgram: args.tokenProgram,
    }),
    depositInstruction({
      programId: args.client.programId,
      owner: args.owner,
      vaultId: args.vaultId,
      source,
      mint: args.mint,
      amount: args.amount,
      tokenProgram: args.tokenProgram,
    }),
  ]);
  return { signature, vault };
}

export async function sendHoldWithdrawal(args: {
  client: ChainClient;
  signAndSend: SignAndSend;
  owner: PublicKey;
  vaultId: bigint;
  amount: bigint;
  destinationText: string;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): Promise<string> {
  const resolved = await resolveHoldDestination(
    args.client.connection,
    args.mint,
    args.tokenProgram,
    args.destinationText,
  );
  const instructions = [];
  if (resolved.create) {
    instructions.push(
      createTokenAccountIx({
        payer: args.owner,
        owner: resolved.owner,
        mint: args.mint,
        tokenAccount: resolved.tokenAccount,
        tokenProgram: args.tokenProgram,
      }),
    );
  }
  instructions.push(
    withdrawInstruction({
      programId: args.client.programId,
      owner: args.owner,
      vaultId: args.vaultId,
      destination: resolved.tokenAccount,
      mint: args.mint,
      amount: args.amount,
      tokenProgram: args.tokenProgram,
    }),
  );
  return send(args.client, args.signAndSend, args.owner, instructions);
}

export async function stopHoldWithdrawal(args: {
  client: ChainClient;
  signAndSend: SignAndSend;
  authority: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
  id: bigint;
}): Promise<string> {
  return send(args.client, args.signAndSend, args.authority, [
    stopInstruction({
      programId: args.client.programId,
      authority: args.authority,
      owner: args.owner,
      vaultId: args.vaultId,
      id: args.id,
    }),
  ]);
}

export async function freezeHoldVault(args: {
  client: ChainClient;
  signAndSend: SignAndSend;
  authority: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
}): Promise<string> {
  return send(args.client, args.signAndSend, args.authority, [
    freezeInstruction({
      programId: args.client.programId,
      authority: args.authority,
      owner: args.owner,
      vaultId: args.vaultId,
    }),
  ]);
}

export async function recoverHoldVault(args: {
  client: ChainClient;
  signAndSend: SignAndSend;
  authority: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
  safeAddress: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): Promise<string> {
  const destination = ownerTokenAccount(args.mint, args.safeAddress, args.tokenProgram);
  return send(args.client, args.signAndSend, args.authority, [
    createTokenAccountIx({
      payer: args.authority,
      owner: args.safeAddress,
      mint: args.mint,
      tokenAccount: destination,
      tokenProgram: args.tokenProgram,
    }),
    recoverInstruction({
      programId: args.client.programId,
      authority: args.authority,
      owner: args.owner,
      vaultId: args.vaultId,
      destination,
      mint: args.mint,
      tokenProgram: args.tokenProgram,
    }),
  ]);
}

export async function compileSkip(args: {
  client: ChainClient;
  owner: PublicKey;
  guardian: PublicKey;
  vaultId: bigint;
  destination: PublicKey;
  mint: PublicKey;
  id: bigint;
  tokenProgram: PublicKey;
  feePayer: PublicKey;
}): Promise<Transaction> {
  return compileHoldTransaction(args.client.connection, args.feePayer, [
    skipInstruction({
      programId: args.client.programId,
      owner: args.owner,
      guardian: args.guardian,
      vaultId: args.vaultId,
      destination: args.destination,
      mint: args.mint,
      id: args.id,
      tokenProgram: args.tokenProgram,
    }),
  ]);
}

export async function compileUnfreeze(args: {
  client: ChainClient;
  owner: PublicKey;
  guardian: PublicKey | null;
  vaultId: bigint;
  feePayer: PublicKey;
}): Promise<Transaction> {
  return compileHoldTransaction(args.client.connection, args.feePayer, [
    unfreezeInstruction({
      programId: args.client.programId,
      owner: args.owner,
      guardian: args.guardian,
      vaultId: args.vaultId,
    }),
  ]);
}

export async function migrateHoldVault(args: {
  client: ChainClient; signAndSend: SignAndSend; owner: PublicKey; vaultId: bigint;
}): Promise<string> {
  return send(args.client, args.signAndSend, args.owner, [
    migrateHoldVaultInstruction({ programId: args.client.programId, owner: args.owner, vaultId: args.vaultId }),
  ]);
}

export async function closeHoldVault(args: {
  client: ChainClient; signAndSend: SignAndSend; owner: PublicKey; vaultId: bigint;
  safeAddress: PublicKey; mint: PublicKey; tokenProgram: PublicKey;
}): Promise<string> {
  const destination = ownerTokenAccount(args.mint, args.safeAddress, args.tokenProgram);
  return send(args.client, args.signAndSend, args.owner, [
    createTokenAccountIx({ payer: args.owner, owner: args.safeAddress, mint: args.mint,
      tokenAccount: destination, tokenProgram: args.tokenProgram }),
    closeHoldVaultInstruction({ programId: args.client.programId, owner: args.owner,
      vaultId: args.vaultId, destination, mint: args.mint, tokenProgram: args.tokenProgram }),
  ]);
}
