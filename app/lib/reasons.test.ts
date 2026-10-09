import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REASON_ACCOUNT_FROZEN,
  REASON_DELEGATE_MISSING,
  REASON_EXPIRED,
  REASON_INSUFFICIENT_FUNDS,
  REASON_MERCHANT_NOT_ALLOWED,
  REASON_NOT_ACTIVE,
  REASON_OVER_CAP,
  REASON_OVER_PER_TX_MAX,
  REASON_STALE_NONCE,
  REASON_TEXT,
  REASON_ZERO_AMOUNT,
  ownerReasonText as reasonLabel,
} from './constants';
import { formatBaseUnits } from './format';
import { notActiveHint, reasonText, refusalWhyLine, renderReason } from './reasons';

test('reason text matches the indexer table', () => {
  assert.equal(reasonText(0), 'ok');
  assert.equal(reasonText(1), 'mandate not active');
  assert.equal(reasonText(2), 'past expiry');
  assert.equal(reasonText(3), 'nonce already settled');
  assert.equal(reasonText(4), 'merchant not allowed');
  assert.equal(reasonText(5), 'over per-payment maximum');
  assert.equal(reasonText(6), 'over remaining cap');
  assert.equal(reasonText(7), 'delegation withdrawn');
  assert.equal(reasonText(8), 'insufficient funds');
  assert.equal(reasonText(9), 'zero amount');
  assert.equal(reasonText(10), 'account frozen');
  assert.equal(reasonText(12), 'pool account not allowed');
  assert.equal(reasonText(99), 'unknown');
  assert.equal(REASON_TEXT[REASON_OVER_PER_TX_MAX], 'over per-payment maximum');
});

test('a refusal shows the override that would have cleared it', () => {
  const view = renderReason(REASON_OVER_PER_TX_MAX, 519500n, 6);
  assert.equal(view.text, 'over per-payment maximum');
  assert.equal(view.overrideLine, 'A one-time allowance of 0.5195 would have cleared the per-payment limit. All other checks still apply.');
});

test('a 180-over-60 per-payment refusal still has an override that would have cleared it', () => {
  assert.equal(
    refusalWhyLine({
      reason: REASON_OVER_PER_TX_MAX,
      amount: 180_000_000n,
      suggestedOverride: 180_000_000n,
      decimals: 6,
      perTxMax: 60_000_000n,
    }),
    'Asked for 180, over the 60 per-payment maximum. A one-time allowance of 180 would have cleared the per-payment limit. All other checks still apply.',
  );
});

test('a 6232500-over-500000 per-payment refusal still has an override that would have cleared it', () => {
  const amount = 6_232_500n;
  const perTxMax = 500_000n;
  const suggestedOverride = 6_232_500n;
  const decimals = 6;
  assert.equal(formatBaseUnits(amount, decimals), '6.2325');
  assert.equal(formatBaseUnits(perTxMax, decimals), '0.5');
  assert.equal(formatBaseUnits(suggestedOverride, decimals), '6.2325');
  assert.equal(
    refusalWhyLine({
      reason: REASON_OVER_PER_TX_MAX,
      amount,
      suggestedOverride,
      decimals,
      perTxMax,
    }),
    `Asked for ${formatBaseUnits(amount, decimals)}, over the ${formatBaseUnits(perTxMax, decimals)} per-payment maximum. A one-time allowance of ${formatBaseUnits(suggestedOverride, decimals)} would have cleared the per-payment limit. All other checks still apply.`,
  );
});

test('a trade over the per-trade maximum names the trade, not a payment', () => {
  assert.equal(
    refusalWhyLine({
      reason: REASON_OVER_PER_TX_MAX,
      amount: 2_000_000n,
      suggestedOverride: 2_000_000n,
      decimals: 9,
      perTxMax: 1_000_000n,
      mint: 'So11111111111111111111111111111111111111112',
      unit: 'trade',
    }),
    'Asked for 0.002 wrapped SOL, over the 0.001 wrapped SOL per-trade maximum. A one-time allowance of 0.002 wrapped SOL would have cleared the per-payment limit. All other checks still apply.',
  );
});

test('a per-payment refusal with no override amount says so in plain language', () => {
  const overPer = renderReason(REASON_OVER_PER_TX_MAX, 0n, 6);
  assert.equal(overPer.overrideLine, 'No one-time allowance would have cleared this.');
});

test('an override line appears only for the per-payment reason', () => {
  const overCap = renderReason(REASON_OVER_CAP, 519500n, 6);
  assert.equal(overCap.text, 'over remaining cap');
  assert.equal(overCap.overrideLine, null);
  const notActive = renderReason(REASON_NOT_ACTIVE, 519500n, 6);
  assert.equal(notActive.overrideLine, null);
  const overPer = renderReason(REASON_OVER_PER_TX_MAX, 519500n, 6);
  assert.equal(overPer.overrideLine, 'A one-time allowance of 0.5195 would have cleared the per-payment limit. All other checks still apply.');
});

test('refusal copy follows the recorded reason even when a per-payment limit is in hand', () => {
  const codes = [
    REASON_NOT_ACTIVE,
    REASON_EXPIRED,
    REASON_STALE_NONCE,
    REASON_MERCHANT_NOT_ALLOWED,
    REASON_OVER_PER_TX_MAX,
    REASON_OVER_CAP,
    REASON_DELEGATE_MISSING,
    REASON_INSUFFICIENT_FUNDS,
    REASON_ZERO_AMOUNT,
    REASON_ACCOUNT_FROZEN,
  ];
  const lines = codes.map((reason) =>
    refusalWhyLine({
      reason,
      amount: 50n,
      suggestedOverride: 0n,
      decimals: 0,
      perTxMax: 60n,
    }),
  );
  assert.equal(new Set(lines).size, codes.length);
  for (let i = 0; i < codes.length; i++) {
    const reason = codes[i]!;
    const line = lines[i]!;
    if (reason === REASON_OVER_PER_TX_MAX) {
      assert.equal(
        line,
        'Asked for 50, over the 60 per-payment maximum. No one-time allowance would have cleared this.',
      );
    } else {
      assert.equal(line.includes('per-payment maximum'), false, `reason ${reason}: ${line}`);
      assert.equal(line.startsWith(`${reasonLabel(reason)}.`), true, line);
    }
  }
});

test('reason 1 is the post-revoke refusal', () => {
  const hint = notActiveHint();
  assert.ok(hint.includes(String(REASON_NOT_ACTIVE)));
  assert.ok(hint.includes('mandate not active'));
});
