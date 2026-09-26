import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { validateHoldAddresses } from './holdSafeAddress';

const owner = Keypair.generate().publicKey.toBase58();
const guardian = Keypair.generate().publicKey.toBase58();
const safe = Keypair.generate().publicKey.toBase58();

test('an empty safe address cannot open a vault', () => {
  assert.throws(() => validateHoldAddresses(owner, guardian, '  '), /Enter a safe address/);
});
test('an invalid safe address cannot open a vault', () => {
  assert.throws(() => validateHoldAddresses(owner, guardian, 'invalid'), /valid Solana/);
});
test('the guardian cannot receive recovery even with owner confirmation', () => {
  assert.throws(() => validateHoldAddresses(owner, guardian, guardian, true), /guardian does not control/);
});
test('the owner wallet requires explicit risk confirmation', () => {
  assert.throws(() => validateHoldAddresses(owner, guardian, owner), /stolen owner key/);
  assert.equal(validateHoldAddresses(owner, guardian, owner, true).safeAddress.toBase58(), owner);
});
test('an independently entered safe wallet is preserved', () => {
  assert.equal(validateHoldAddresses(owner, guardian, ` ${safe} `).safeAddress.toBase58(), safe);
});
