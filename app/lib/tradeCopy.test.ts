import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_MINT } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';

import { KIND_PAID, KIND_REFUSED, REASON_OUTPUT_ACCOUNT_NOT_ALLOWED, REASON_POOL_NOT_ALLOWED, REASON_OVER_PER_TX_MAX } from './constants';
import { DEVNET_USDC_MINT } from './tokens';
import { tradeDecisionDetail, tradeDecisionTitle } from './tradeCopy';
import { truncateAddress } from './wallet';

const SOL = NATIVE_MINT.toBase58();

test('a trade row names both tokens', () => {
  const title = tradeDecisionTitle({
    kind: KIND_PAID,
    amountIn: 2_000_000n,
    amountOut: 390_000n,
    inDecimals: 9,
    outDecimals: 6,
    inMint: SOL,
    outMint: DEVNET_USDC_MINT,
    reason: 0,
    counterparty: Keypair.generate().publicKey.toBase58(),
  });
  assert.equal(title, 'Traded 0.002 wrapped SOL for 0.39 USDC');
  assert.equal(
    tradeDecisionDetail({
      amountIn: 2_000_000n,
      amountOut: 390_000n,
      inDecimals: 9,
      outDecimals: 6,
      inMint: SOL,
      outMint: DEVNET_USDC_MINT,
      perTradeMax: 10_000_000n,
    }),
    'Traded 0.002 wrapped SOL for 0.39 USDC, under 0.01 wrapped SOL per trade.',
  );
});

test('a refused output account names the account that was tried', () => {
  const tried = Keypair.generate().publicKey.toBase58();
  const title = tradeDecisionTitle({
    kind: KIND_REFUSED,
    amountIn: 1n,
    amountOut: 0n,
    inDecimals: 9,
    outDecimals: 6,
    inMint: SOL,
    outMint: DEVNET_USDC_MINT,
    reason: REASON_OUTPUT_ACCOUNT_NOT_ALLOWED,
    counterparty: tried,
  });
  assert.equal(title, `Refused: output account not allowed (tried ${truncateAddress(tried)})`);
});

test('a refused pool account names the account that was tried', () => {
  const tried = Keypair.generate().publicKey.toBase58();
  const title = tradeDecisionTitle({
    kind: KIND_REFUSED,
    amountIn: 1n,
    amountOut: 0n,
    inDecimals: 9,
    outDecimals: 6,
    inMint: SOL,
    outMint: DEVNET_USDC_MINT,
    reason: REASON_POOL_NOT_ALLOWED,
    counterparty: tried,
  });
  assert.equal(title, `Refused: pool account not allowed (tried ${truncateAddress(tried)})`);
});

test('trade titles default to exact amounts and lists explicitly round', () => {
  const args = {
    kind: KIND_PAID, amountIn: 999994n, amountOut: 10992000n,
    inDecimals: 9, outDecimals: 6, inMint: SOL, outMint: DEVNET_USDC_MINT,
    reason: 0, counterparty: 'pool',
  };
  assert.equal(tradeDecisionTitle({ ...args, amounts: 'display' }), 'Traded 0.001 wrapped SOL for 10.99 USDC');
  assert.equal(tradeDecisionTitle(args), 'Traded 0.000999994 wrapped SOL for 10.992 USDC');
});

test('a trade refusal defaults to the exact requested amount and per-trade limit', () => {
  assert.equal(tradeDecisionTitle({
    kind: KIND_REFUSED, amountIn: 1_996_000n, amountOut: 0n,
    inDecimals: 6, outDecimals: 6, inMint: DEVNET_USDC_MINT, outMint: DEVNET_USDC_MINT,
    reason: REASON_OVER_PER_TX_MAX, counterparty: 'pool', perTradeMax: 996_000n,
  }), 'Refused: your agent asked 1.996 USDC, your limit is 0.996 USDC per trade');
});
