import assert from 'node:assert/strict';
import test from 'node:test';

import { STATUS_ACTIVE } from './constants';
import { buildAgentRecords } from './grade';
import { truncateAddress } from './wallet';
import {
  DEVNET_USDC_MINT,
  MAINNET_USDC_MINT,
  SECOND_DEVNET_MINT,
  SKR_MINT,
  USDC_DEVNET_NOTE,
  VTEST_DEVNET_NOTE,
  VTEST_MINT,
  devnetTestTokenNote,
  mainnetPreviewNote,
  formatTokenAmount,
  formatTokenDisplay,
  WSOL_MINT,
  knownToken,
  rulesTokenSummary,
  tokenName,
  tokenSymbol,
  withToken,
} from './tokens';

test('known mints use their symbol and name, and nothing else is invented', () => {
  assert.equal(tokenSymbol(VTEST_MINT), 'VTEST');
  assert.equal(tokenName(VTEST_MINT), 'Veto test token');
  assert.equal(knownToken(VTEST_MINT)?.name, 'Veto test token');
  assert.equal(tokenSymbol(DEVNET_USDC_MINT), 'USDC');
  assert.equal(tokenSymbol(MAINNET_USDC_MINT), 'USDC');
  assert.equal(tokenSymbol(SKR_MINT), 'SKR');
  assert.equal(tokenName(SKR_MINT), 'SKR');
});

test('the second devnet mint has no symbol in this repo, so the name is the shortened address', () => {
  assert.equal(knownToken(SECOND_DEVNET_MINT), null);
  assert.equal(tokenName(SECOND_DEVNET_MINT), null);
  assert.equal(tokenSymbol(SECOND_DEVNET_MINT), truncateAddress(SECOND_DEVNET_MINT));
  assert.equal(tokenSymbol(SECOND_DEVNET_MINT), 'Dcbb...K3Kq');
  assert.notEqual(tokenSymbol(SECOND_DEVNET_MINT), 'VTEST');
  assert.notEqual(tokenSymbol(SECOND_DEVNET_MINT), 'SKR');
  assert.notEqual(tokenSymbol(SECOND_DEVNET_MINT), 'USDC');
});

test('an unknown mint is the shortened address, and a missing mint is not a guessed ticker', () => {
  const mint = 'Mint1111111111111111111111111111111111111111';
  assert.equal(tokenSymbol(mint), 'Mint...1111');
  assert.equal(tokenName(mint), null);
  assert.equal(tokenSymbol(''), '');
  assert.equal(tokenSymbol(null), '');
  assert.equal(withToken('16.66', null), '16.66');
  assert.equal(withToken('16.66', VTEST_MINT), '16.66 VTEST');
  assert.equal(withToken('16.66 VTEST', VTEST_MINT), '16.66 VTEST');
  assert.equal(formatTokenAmount(16_660_000n, 6, VTEST_MINT), '16.66 VTEST');
});

test('the devnet test line follows the rule mint', () => {
  assert.equal(devnetTestTokenNote(VTEST_MINT, 'devnet'), VTEST_DEVNET_NOTE);
  assert.equal(VTEST_DEVNET_NOTE, 'VTEST is a devnet test token with no value.');
  assert.equal(devnetTestTokenNote(DEVNET_USDC_MINT, 'devnet'), USDC_DEVNET_NOTE);
  assert.equal(USDC_DEVNET_NOTE, "USDC on devnet is Circle's test token. It has no value.");
  assert.equal(devnetTestTokenNote(VTEST_MINT, 'mainnet-beta'), null);
  assert.equal(devnetTestTokenNote(DEVNET_USDC_MINT, 'mainnet-beta'), null);
  assert.equal(devnetTestTokenNote(DEVNET_USDC_MINT, 'testnet'), null);
  assert.equal(devnetTestTokenNote(VTEST_MINT, 'testnet'), null);
  assert.equal(devnetTestTokenNote(SECOND_DEVNET_MINT, 'devnet'), null);
  assert.equal(devnetTestTokenNote(MAINNET_USDC_MINT, 'devnet'), null);
  assert.equal(devnetTestTokenNote(null, 'devnet'), null);
});

test('a rules header groups by token and does not add different tokens together', () => {
  assert.equal(rulesTokenSummary([]), null);
  assert.equal(rulesTokenSummary([VTEST_MINT]), 'This rule uses VTEST.');
  assert.equal(rulesTokenSummary([VTEST_MINT, VTEST_MINT, VTEST_MINT]), 'All 3 rules use VTEST.');
  assert.equal(
    rulesTokenSummary([VTEST_MINT, VTEST_MINT, DEVNET_USDC_MINT]),
    '2 rules in VTEST. 1 rule in USDC.',
  );
  assert.equal(rulesTokenSummary([SECOND_DEVNET_MINT, SKR_MINT]), '1 rule in Dcbb...K3Kq. 1 rule in SKR.');
});

test('no screen adds amounts across rules with different mints', () => {
  const now = 1_700_000_000n;
  const agent = 'agent';
  const records = buildAgentRecords(
    [
      {
        address: 'rule-vtest',
        agent,
        purpose: 'old rule',
        cap: 111n,
        spent: 0n,
        perTxMax: 1n,
        expiresAt: now + 86_400n,
        status: STATUS_ACTIVE,
        decimals: 0,
        mint: VTEST_MINT,
        rows: [],
      },
      {
        address: 'rule-usdc',
        agent,
        purpose: 'new rule',
        cap: 222n,
        spent: 0n,
        perTxMax: 1n,
        expiresAt: now + 86_400n,
        status: STATUS_ACTIVE,
        decimals: 0,
        mint: DEVNET_USDC_MINT,
        rows: [],
      },
    ],
    {},
    now,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]?.spend, null);
  assert.deepEqual(
    records[0]?.rules.map((rule) => rule.capLabel).sort(),
    ['111 VTEST', '222 USDC'],
  );
  const named = records[0]?.rules.map((rule) => `${rule.remainingLabel} ${rule.spentLabel}`).join(' ');
  assert.equal(named?.includes('333'), false);
  assert.equal(
    rulesTokenSummary([VTEST_MINT, DEVNET_USDC_MINT]),
    '1 rule in VTEST. 1 rule in USDC.',
  );
});


test('mainnet preview warns about real SKR only for SKR on mainnet', () => {
  assert.equal(mainnetPreviewNote(SKR_MINT, 'mainnet-beta'), 'Mainnet preview. Real SKR. Small caps on purpose.');
  assert.equal(mainnetPreviewNote(` ${SKR_MINT} `, ' mainnet-beta '), 'Mainnet preview. Real SKR. Small caps on purpose.');
  for (const cluster of ['devnet', 'testnet', '', null, undefined]) {
    assert.equal(mainnetPreviewNote(SKR_MINT, cluster), null);
  }
  for (const mint of [VTEST_MINT, MAINNET_USDC_MINT, '', null, undefined]) {
    assert.equal(mainnetPreviewNote(mint, 'mainnet-beta'), null);
  }
});

test('display amounts round token precision while signing amounts remain exact', () => {
  assert.equal(formatTokenDisplay(999994n, 9, WSOL_MINT), '0.001 wrapped SOL');
  assert.equal(formatTokenDisplay(10_992_000n, 6, DEVNET_USDC_MINT), '10.99 USDC');
  assert.equal(formatTokenDisplay(10_999_999n, 6, MAINNET_USDC_MINT), '11 USDC');
  assert.equal(formatTokenDisplay(1n, 9, WSOL_MINT), '<0.0001 wrapped SOL');
  assert.equal(formatTokenDisplay(-1n, 6, DEVNET_USDC_MINT), '>-0.01 USDC');
  assert.equal(formatTokenDisplay(0n, 6, DEVNET_USDC_MINT), '0 USDC');
  assert.equal(formatTokenDisplay(1234567890123456789000n, 6, DEVNET_USDC_MINT), '1234567890123456.79 USDC');
  assert.equal(formatTokenAmount(999994n, 9, WSOL_MINT), '0.000999994 wrapped SOL');
  assert.equal(formatTokenAmount(10_992_000n, 6, DEVNET_USDC_MINT), '10.992 USDC');
});
