import { Buffer } from 'buffer';
import { PublicKey, Transaction } from '@solana/web3.js';

import { holdWhere, skipInstruction, unfreezeInstruction } from './holdTx';

/**
 * What this phone expects a pasted "both keys" request to be, taken from the vault and the
 * withdrawal on screen (read from chain), never from the pasted bytes.
 */
export type HoldRequestExpectation = {
  purpose: 'skip' | 'unfreeze';
  programId: PublicKey;
  owner: PublicKey;
  guardian: PublicKey;
  vaultId: bigint;
  mint: PublicKey;
  tokenProgram: PublicKey;
  /** The withdrawal on screen. Required for skip. */
  withdrawal: { id: bigint; destination: PublicKey } | null;
  /** The key connected on this phone. */
  connected: PublicKey;
};

export type HoldRequestFacts = {
  action: 'skip' | 'unfreeze';
  vault: PublicKey;
  withdrawalId: bigint | null;
  destination: PublicKey | null;
};

export type HoldRequestCheck = { ok: true; facts: HoldRequestFacts } | { ok: false; reason: string };

const NOT_THIS_REQUEST =
  'This request is not the one on this screen. Nothing was signed. Ask the other phone to start again from this vault.';

function refuse(reason: string): HoldRequestCheck {
  return { ok: false, reason };
}

/**
 * Gate for a pasted request before this phone signs it. The request must be exactly the one
 * instruction this app would build for the vault and withdrawal on screen, signed by the other
 * key, and nothing else.
 */
export function verifyHoldRequest(tx: Transaction, expected: HoldRequestExpectation): HoldRequestCheck {
  const { owner, guardian, connected } = expected;
  if (guardian.equals(PublicKey.default) || guardian.equals(owner)) {
    return refuse('This vault has no second key, so there is no request to finish. Nothing was signed.');
  }
  const isOwner = connected.equals(owner);
  const isGuardian = connected.equals(guardian);
  if (!isOwner && !isGuardian) {
    return refuse('The key on this phone is neither the owner nor the guardian of this vault. Nothing was signed.');
  }
  if (expected.purpose === 'skip' && !expected.withdrawal) {
    return refuse('That withdrawal is no longer waiting. Nothing was signed.');
  }

  const instruction =
    expected.purpose === 'skip' && expected.withdrawal
      ? skipInstruction({
          programId: expected.programId,
          owner,
          guardian,
          vaultId: expected.vaultId,
          destination: expected.withdrawal.destination,
          mint: expected.mint,
          id: expected.withdrawal.id,
          tokenProgram: expected.tokenProgram,
        })
      : unfreezeInstruction({ programId: expected.programId, owner, guardian, vaultId: expected.vaultId });

  if (tx.instructions.length !== 1) return refuse(NOT_THIS_REQUEST);
  const got = tx.instructions[0]!;
  if (!got.programId.equals(instruction.programId)) return refuse(NOT_THIS_REQUEST);
  if (!Buffer.from(got.data).equals(Buffer.from(instruction.data))) return refuse(NOT_THIS_REQUEST);
  if (got.keys.length !== instruction.keys.length) return refuse(NOT_THIS_REQUEST);
  for (let i = 0; i < instruction.keys.length; i += 1) {
    const want = instruction.keys[i]!;
    const have = got.keys[i]!;
    if (!have.pubkey.equals(want.pubkey) || have.isSigner !== want.isSigner) return refuse(NOT_THIS_REQUEST);
  }

  const feePayer = tx.feePayer;
  if (!feePayer || !(feePayer.equals(owner) || feePayer.equals(guardian))) return refuse(NOT_THIS_REQUEST);
  if (!tx.recentBlockhash) return refuse(NOT_THIS_REQUEST);

  // The whole message, rebuilt here, must match byte for byte. This fixes the writable flags,
  // the signer header, the account order and the blockhash to what this app itself would sign.
  const rebuilt = new Transaction();
  rebuilt.feePayer = feePayer;
  rebuilt.recentBlockhash = tx.recentBlockhash;
  rebuilt.add(instruction);
  let message: Buffer;
  try {
    message = tx.serializeMessage();
  } catch {
    return refuse(NOT_THIS_REQUEST);
  }
  if (!rebuilt.serializeMessage().equals(message)) return refuse(NOT_THIS_REQUEST);

  const signers = tx.signatures.map((entry) => entry.publicKey);
  if (
    signers.length !== 2 ||
    !signers.some((key) => key.equals(owner)) ||
    !signers.some((key) => key.equals(guardian))
  ) {
    return refuse(NOT_THIS_REQUEST);
  }

  const counterparty = isOwner ? guardian : owner;
  const theirs = tx.signatures.find((entry) => entry.publicKey.equals(counterparty));
  if (!theirs?.signature) {
    const mine = tx.signatures.find((entry) => entry.publicKey.equals(connected));
    return refuse(
      mine?.signature
        ? 'This phone already signed this request. Paste it on the phone with the other key. Nothing was signed.'
        : 'The other key has not signed this request yet. Nothing was signed.',
    );
  }
  if (!tx.verifySignatures(false)) {
    return refuse("The other key's signature on this request is not valid. Nothing was signed.");
  }

  const where = holdWhere(expected.programId, owner, expected.vaultId);
  return {
    ok: true,
    facts: {
      action: expected.purpose,
      vault: where.vault,
      withdrawalId: expected.purpose === 'skip' ? (expected.withdrawal?.id ?? null) : null,
      destination: expected.purpose === 'skip' ? (expected.withdrawal?.destination ?? null) : null,
    },
  };
}

export type PastedHoldRequest = { ok: true; tx: Transaction; facts: HoldRequestFacts } | { ok: false; reason: string };

/** Decode a pasted request and run the gate. The screen signs only an `ok` result. */
export function readHoldRequest(payload: string, expected: HoldRequestExpectation): PastedHoldRequest {
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(payload.trim(), 'base64'));
  } catch {
    return { ok: false, reason: 'That request could not be read. Paste the whole request from the other phone.' };
  }
  const check = verifyHoldRequest(tx, expected);
  return check.ok ? { ok: true, tx, facts: check.facts } : check;
}
