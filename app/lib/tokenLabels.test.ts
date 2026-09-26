import assert from 'node:assert/strict';
import test from 'node:test';
import { networkPillLabel, connectNetworkLine } from './onboarding';
import { DEVNET_USDC_MINT, VTEST_MINT, MAINNET_USDC_MINT } from './tokens';

test('first-run labels identify the configured token instead of guessing from devnet', () => {
  assert.equal(networkPillLabel('devnet', DEVNET_USDC_MINT), 'Devnet USDC');
  assert.equal(networkPillLabel('devnet', VTEST_MINT), 'Test tokens');
  assert.equal(networkPillLabel('devnet', null), 'Devnet');
  assert.equal(networkPillLabel('mainnet-beta', MAINNET_USDC_MINT), 'USDC');
  assert.match(connectNetworkLine('devnet', DEVNET_USDC_MINT) ?? '', /Devnet USDC/);
  assert.doesNotMatch(connectNetworkLine('devnet', DEVNET_USDC_MINT) ?? '', /test tokens/i);
});

test('test tokens uses sentence case in wallet connection copy', () => {
  assert.match(connectNetworkLine('devnet', VTEST_MINT) ?? '', /with test tokens\./);
});
