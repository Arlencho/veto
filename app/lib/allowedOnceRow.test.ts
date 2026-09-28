import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionFace } from '../components/records/copy';
import {
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  REASON_OVER_PER_TX_MAX,
  REASON_STALE_NONCE,
  ownerReasonText,
  reasonText,
} from './constants';
import { PAID_ALLOWED_ONCE_NOTICE_TITLE, PAID_NOTICE_TITLE, paidDecisionBody, planDecisionNotices } from './notify';
import { nonceSequence, overrideRowView, sequenceLine } from './override';
import type { LedgerRow } from './ring';
import { DEVNET_USDC_MINT } from './tokens';
import { tradeDecisionDetail } from './tradeCopy';

const PAYEE = '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG';
const MERCHANT = '11111111111111111111111111111111';
const PER_TX_MAX = 500_000n;

function ledgerRow(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: 5_000n,
    amount: 900_000n,
    counterparty: PAYEE,
    nonce: 2n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    kindName: 'paid',
    reason: 0,
    reasonText: 'ok',
    signature: 'sig-paid',
    ...over,
  };
}

test('a paid row above the per-payment max says the owner allowed it once', () => {
  const face = decisionFace(ledgerRow(), 6, PER_TX_MAX, undefined, { payee: PAYEE, mint: DEVNET_USDC_MINT });
  assert.equal(face.title, 'Paid 0.9 USDC to 6i99...PdCG');
  assert.equal(face.detail, 'Allowed once by you: above your 0.5 USDC per-payment limit.');
  assert.doesNotMatch(face.detail, /Inside your limit/);
});

test('a paid row at or under the per-payment max keeps the inside-the-limit line', () => {
  for (const amount of [PER_TX_MAX, 446_000n]) {
    const face = decisionFace(ledgerRow({ amount }), 6, PER_TX_MAX, undefined, {
      payee: PAYEE,
      mint: DEVNET_USDC_MINT,
    });
    assert.equal(face.detail, 'Inside your limit of 0.5 USDC per payment.');
  }
});

test('a paid amount just above the limit never rounds down to the limit on screen', () => {
  const options = { payee: PAYEE, mint: DEVNET_USDC_MINT };
  const face = decisionFace(ledgerRow({ amount: 504_000n }), 6, PER_TX_MAX, undefined, options);
  assert.equal(face.title, 'Paid 0.51 USDC to 6i99...PdCG');
  assert.equal(face.figure, '-0.51 USDC');
  assert.equal(face.detail, 'Allowed once by you: above your 0.5 USDC per-payment limit.');
  const exact = decisionFace(ledgerRow({ amount: 504_000n }), 6, PER_TX_MAX, undefined, {
    ...options,
    amounts: 'exact',
  });
  assert.equal(exact.title, 'Paid 0.504 USDC to 6i99...PdCG');
  const under = decisionFace(ledgerRow({ amount: 494_000n }), 6, PER_TX_MAX, undefined, options);
  assert.equal(under.title, 'Paid 0.49 USDC to 6i99...PdCG');
});

test('above the limit, the limit shows exactly and is never rounded down', () => {
  const face = decisionFace(ledgerRow({ amount: 508_000n }), 6, 505_000n, undefined, {
    payee: PAYEE,
    mint: DEVNET_USDC_MINT,
  });
  assert.equal(face.title, 'Paid 0.51 USDC to 6i99...PdCG');
  assert.equal(face.detail, 'Allowed once by you: above your 0.505 USDC per-payment limit.');
});

test('a traded amount just above the limit rounds up on screen', () => {
  const trade = ledgerRow({
    family: 'trade',
    amount: 504_000n,
    amountOut: 2_000_000n,
    outMint: DEVNET_USDC_MINT,
    outDecimals: 6,
  });
  const face = decisionFace(trade, 6, PER_TX_MAX, undefined, { mint: DEVNET_USDC_MINT });
  assert.equal(face.title, 'Traded 0.51 USDC for 2 USDC');
  assert.equal(face.detail, 'Allowed once by you: above your 0.5 USDC per-trade limit.');
  const under = decisionFace({ ...trade, amount: 494_000n }, 6, PER_TX_MAX, undefined, { mint: DEVNET_USDC_MINT });
  assert.equal(under.title, 'Traded 0.49 USDC for 2 USDC');
});

test('the stale request reason reads in plain words on screen and stays canonical in exports', () => {
  assert.equal(ownerReasonText(REASON_STALE_NONCE), 'request already settled');
  assert.equal(reasonText(REASON_STALE_NONCE), 'nonce already settled');
  assert.equal(ownerReasonText(REASON_OVER_PER_TX_MAX), reasonText(REASON_OVER_PER_TX_MAX));
  const seq = nonceSequence(
    [ledgerRow({ kind: KIND_REFUSED, kindName: 'refused', reason: REASON_STALE_NONCE }), ledgerRow()],
    2n,
  );
  assert.equal(sequenceLine(seq, 6, DEVNET_USDC_MINT), 'Asked for 0.9 USDC. Refused (request already settled). Then paid.');
});

test('a paid row with no known per-payment max stays with the plain rule line', () => {
  const face = decisionFace(ledgerRow(), 6, undefined, undefined, { payee: PAYEE, mint: DEVNET_USDC_MINT });
  assert.equal(face.detail, 'Inside the rule.');
});

test('a traded row above the per-trade max says the owner allowed it once', () => {
  const trade = ledgerRow({ family: 'trade', amountOut: 1_000n, outMint: DEVNET_USDC_MINT, outDecimals: 6 });
  const face = decisionFace(trade, 6, PER_TX_MAX, undefined, { mint: DEVNET_USDC_MINT });
  assert.equal(face.detail, 'Allowed once by you: above your 0.5 USDC per-trade limit.');
  const under = decisionFace({ ...trade, amount: 400_000n }, 6, PER_TX_MAX, undefined, { mint: DEVNET_USDC_MINT });
  assert.equal(under.detail, 'Inside your limit of 0.5 USDC per trade.');
  assert.equal(
    tradeDecisionDetail({
      amountIn: 900_000n,
      inDecimals: 6,
      outDecimals: 6,
      inMint: DEVNET_USDC_MINT,
      perTradeMax: PER_TX_MAX,
    }),
    '0.9 USDC, allowed once by you above your 0.5 USDC per-trade limit.',
  );
});

test('the decision detail and the notification do not call an allowed-once payment under the limit', () => {
  const body = paidDecisionBody({
    amount: 900_000n,
    decimals: 6,
    perTxMax: PER_TX_MAX,
    merchant: MERCHANT,
    mint: DEVNET_USDC_MINT,
  });
  assert.equal(body, '0.9 USDC, allowed once by you above your 0.5 USDC per-payment limit. The payee for this rule is 1111...1111.');
  const plan = planDecisionNotices(
    [
      {
        mandate: 'Rule111111111111111111111111111111111111111',
        merchant: MERCHANT,
        perTxMax: PER_TX_MAX,
        decimals: 6,
        mint: DEVNET_USDC_MINT,
        rows: [
          { ts: 30n, kind: KIND_PAID, nonce: 2n, amount: 900_000n, reason: 0, suggestedOverride: 0n },
          { ts: 31n, kind: KIND_PAID, nonce: 3n, amount: 400_000n, reason: 0, suggestedOverride: 0n },
        ],
      },
    ],
    new Map(),
  );
  const titles = plan.notices.map((notice) => notice.title).sort();
  assert.deepEqual(titles, [PAID_ALLOWED_ONCE_NOTICE_TITLE, PAID_NOTICE_TITLE].sort());
});

test('the allowed-once row and its record use plain words, not nonce', () => {
  const override = ledgerRow({ kind: KIND_OVERRIDE, kindName: 'override', suggestedOverride: 900_000n });
  const face = decisionFace(override, 6, PER_TX_MAX, undefined, { mint: DEVNET_USDC_MINT });
  assert.equal(face.title, 'Allowed once: this payment of 0.9 USDC');
  assert.match(face.detail, /^You allowed this one payment of 0\.9 USDC\./);
  assert.doesNotMatch(face.detail, /nonce/i);
  assert.doesNotMatch(overrideRowView(override, 6, DEVNET_USDC_MINT).why, /nonce/i);
  const line = sequenceLine(nonceSequence([override], 2n), 6, DEVNET_USDC_MINT);
  assert.equal(line, null);
  const pending = sequenceLine(
    nonceSequence([ledgerRow({ kind: KIND_REFUSED, kindName: 'refused', reason: REASON_OVER_PER_TX_MAX }), override], 2n),
    6,
    DEVNET_USDC_MINT,
  );
  assert.ok(pending);
  assert.doesNotMatch(pending, /nonce/i);
});
