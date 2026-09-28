import assert from 'node:assert/strict';
import test from 'node:test';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';

import { holdWhere, skipInstruction, unfreezeInstruction } from './holdTx';
import { verifyHoldRequest, type HoldRequestExpectation } from './holdVerify';

const programId = Keypair.generate().publicKey;
const owner = Keypair.generate();
const guardian = Keypair.generate();
const destination = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();
const vaultId = 4n;
const id = 7n;

function skipIx(overrides: Partial<{ vaultId: bigint; id: bigint; destination: PublicKey }> = {}): TransactionInstruction {
  return skipInstruction({
    programId,
    owner: owner.publicKey,
    guardian: guardian.publicKey,
    vaultId: overrides.vaultId ?? vaultId,
    destination: overrides.destination ?? destination,
    mint,
    id: overrides.id ?? id,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
}

/** What the first phone (the owner) produces: its partial, passed through the paste payload. */
function pasted(instructions: TransactionInstruction[], signers: Keypair[] = [owner], feePayer = owner.publicKey): Transaction {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.add(...instructions);
  if (signers.length > 0) tx.partialSign(...signers);
  // The same bytes the paste field carries (holdSign.holdRequestPayload / holdRequestFromPayload).
  return Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

function expectation(overrides: Partial<HoldRequestExpectation> = {}): HoldRequestExpectation {
  return {
    purpose: 'skip',
    programId,
    owner: owner.publicKey,
    guardian: guardian.publicKey,
    vaultId,
    mint,
    tokenProgram: TOKEN_PROGRAM_ID,
    withdrawal: { id, destination },
    connected: guardian.publicKey,
    ...overrides,
  };
}

test('the legitimate skip request from the other key is accepted with its facts', () => {
  const check = verifyHoldRequest(pasted([skipIx()]), expectation());
  assert.equal(check.ok, true);
  if (!check.ok) return;
  assert.equal(check.facts.action, 'skip');
  assert.ok(check.facts.vault.equals(holdWhere(programId, owner.publicKey, vaultId).vault));
  assert.equal(check.facts.withdrawalId, id);
  assert.ok(check.facts.destination?.equals(destination));
});

test('the legitimate request started by the guardian is accepted on the owner phone', () => {
  const tx = pasted([skipIx()], [guardian], guardian.publicKey);
  assert.equal(verifyHoldRequest(tx, expectation({ connected: owner.publicKey })).ok, true);
});

test('the legitimate unfreeze request is accepted', () => {
  const ix = unfreezeInstruction({ programId, owner: owner.publicKey, guardian: guardian.publicKey, vaultId });
  const check = verifyHoldRequest(pasted([ix]), expectation({ purpose: 'unfreeze', withdrawal: null }));
  assert.equal(check.ok, true);
  if (check.ok) assert.equal(check.facts.action, 'unfreeze');
});

test('a forged SystemProgram transfer is refused', () => {
  const forged = SystemProgram.transfer({
    fromPubkey: guardian.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 5_000_000_000,
  });
  const check = verifyHoldRequest(pasted([forged], [], guardian.publicKey), expectation());
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.reason, /Nothing was signed/);
});

test('the real skip plus an extra instruction is refused', () => {
  const extra = SystemProgram.transfer({
    fromPubkey: guardian.publicKey,
    toPubkey: owner.publicKey,
    lamports: 1_000_000_000,
  });
  assert.equal(verifyHoldRequest(pasted([skipIx(), extra]), expectation()).ok, false);
});

test('a skip for a different vault, withdrawal id or destination is refused', () => {
  assert.equal(verifyHoldRequest(pasted([skipIx({ vaultId: vaultId + 1n })]), expectation()).ok, false);
  assert.equal(verifyHoldRequest(pasted([skipIx({ id: id + 1n })]), expectation()).ok, false);
  assert.equal(
    verifyHoldRequest(pasted([skipIx({ destination: Keypair.generate().publicKey })]), expectation()).ok,
    false,
  );
  const unfreeze = unfreezeInstruction({ programId, owner: owner.publicKey, guardian: guardian.publicKey, vaultId });
  assert.equal(verifyHoldRequest(pasted([unfreeze]), expectation()).ok, false);
});

test('a request with no signature from the other key is refused', () => {
  const check = verifyHoldRequest(pasted([skipIx()], []), expectation());
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.reason, /has not signed/);
});

test('a request carrying a forged signature for the other key is refused', () => {
  const tx = pasted([skipIx()]);
  const entry = tx.signatures.find((item) => item.publicKey.equals(owner.publicKey));
  assert.ok(entry?.signature);
  entry.signature = Buffer.alloc(64, 1);
  const check = verifyHoldRequest(tx, expectation());
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.reason, /not valid/);
});

test('this phone does not finish its own partial', () => {
  const check = verifyHoldRequest(pasted([skipIx()]), expectation({ connected: owner.publicKey }));
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.reason, /already signed/);
});

test('a key that is neither owner nor guardian cannot sign', () => {
  const check = verifyHoldRequest(pasted([skipIx()]), expectation({ connected: Keypair.generate().publicKey }));
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.reason, /neither the owner nor the guardian/);
});

test('a fee payer outside the two keys is refused', () => {
  const stranger = Keypair.generate();
  const tx = pasted([skipIx()], [owner, stranger], stranger.publicKey);
  assert.equal(verifyHoldRequest(tx, expectation()).ok, false);
});
