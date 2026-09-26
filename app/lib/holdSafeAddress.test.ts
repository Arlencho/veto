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
  assert.throws(() => validateHoldAddresses(owner, guardian, guardian, true), /safe address must differ from the guardian/);
});
test('the owner wallet is refused even with prior risk confirmation', () => {
  assert.throws(() => validateHoldAddresses(owner, guardian, owner), /safe address must differ from the owner/);
  assert.throws(() => validateHoldAddresses(owner, guardian, owner, true), /safe address must differ from the owner/);
});
test('an independently entered safe wallet is preserved', () => {
  assert.equal(validateHoldAddresses(owner, guardian, ` ${safe} `).safeAddress.toBase58(), safe);
});
