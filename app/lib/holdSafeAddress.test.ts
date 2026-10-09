import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { SAFE_WALLET_GUIDANCE, validateHoldAddresses } from './holdSafeAddress';

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
  assert.throws(() => validateHoldAddresses(owner, guardian, guardian, true), /Your safe address must be a different wallet from the guardian wallet\./);
});
test('the owner wallet is refused even with prior risk confirmation', () => {
  assert.throws(() => validateHoldAddresses(owner, guardian, owner), /Your safe address must be a different wallet from the one you sign with\./);
  assert.throws(() => validateHoldAddresses(owner, guardian, owner, true), /Your safe address must be a different wallet from the one you sign with\./);
});
test('an independently entered safe wallet is preserved', () => {
  assert.equal(validateHoldAddresses(owner, guardian, ` ${safe} `).safeAddress.toBase58(), safe);
});
test('the safe address guidance says it must be out of reach of the guardian and of anyone forcing you', () => {
  assert.equal(
    SAFE_WALLET_GUIDANCE,
    'The safe address must be a wallet the guardian does not control and that you could not be forced to hand over, for example a cold wallet kept elsewhere or an exchange deposit address you own.',
  );
});
