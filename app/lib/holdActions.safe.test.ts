import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Keypair } from '@solana/web3.js';
import type { ChainClient } from './chain';

mock.module('./holdChain', { namedExports: {
  compileHoldTransaction() { throw new Error('Unexpected transaction'); },
  createTokenAccountIx() {},
  ownerTokenAccount() {},
  readTokenAmount() { throw new Error('Unexpected balance read'); },
  resolveHoldDestination() {},
} });

test('opening a vault refuses recovery to the guardian before reading balances or signing', async () => {
  const { openHoldVault } = await import('./holdActions');
  const owner = Keypair.generate().publicKey;
  const guardian = Keypair.generate().publicKey;
  await assert.rejects(openHoldVault({
    client: { programId: Keypair.generate().publicKey } as ChainClient,
    signAndSend: async () => { throw new Error('Unexpected signature'); },
    owner, vaultId: 0n, guardian, safeAddress: guardian,
    dailyLimit: 1n, delaySecs: 86400n, amount: 10n,
    mint: Keypair.generate().publicKey, tokenProgram: Keypair.generate().publicKey,
  }), /safe address must differ from the guardian/);
});

test('opening a vault refuses recovery to the owner before reading balances or signing', async () => {
  const { openHoldVault } = await import('./holdActions');
  const owner = Keypair.generate().publicKey;
  await assert.rejects(openHoldVault({
    client: { programId: Keypair.generate().publicKey } as ChainClient,
    signAndSend: async () => { throw new Error('Unexpected signature'); },
    owner, vaultId: 0n, guardian: Keypair.generate().publicKey, safeAddress: owner,
    dailyLimit: 1n, delaySecs: 86400n, amount: 10n,
    mint: Keypair.generate().publicKey, tokenProgram: Keypair.generate().publicKey,
  }), /safe address must differ from the owner/);
});
