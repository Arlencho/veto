import assert from 'node:assert/strict';
import test from 'node:test';

import { paidTileCopy } from '../components/daily/facts';
import { KIND_OPENED, KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE } from './constants';
import { buildAgentRecords, gradeRules, requestTicks, snapshotRule, type GradeDecision, type RuleFacts } from './grade';
import { plaquesForRule } from './plaques';
import { DEVNET_USDC_MINT } from './tokens';
import { trackRecordFor, trackRecordLines } from './trackRecord';
import { weekFileText, weekReviewFor } from './weekReview';

const START = 1_700_000_000n;
const DAY = 86400n;
const LIMIT = 5_000_000n;

function row(over: Partial<GradeDecision>): GradeDecision {
  return {
    kind: KIND_PAID,
    ts: START + DAY,
    amount: 1_000_000n,
    nonce: 1n,
    reason: 0,
    counterparty: '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG',
    ...over,
  };
}

function facts(rows: GradeDecision[]): RuleFacts {
  return {
    address: 'RuleAddress11111111111111111111111111111111',
    agent: 'AgentAddress1111111111111111111111111111111',
    purpose: 'Charging top-ups',
    cap: 50_000_000n,
    spent: 13_900_000n,
    perTxMax: LIMIT,
    expiresAt: START + 30n * DAY,
    status: STATUS_ACTIVE,
    decimals: 6,
    mint: DEVNET_USDC_MINT,
    rows: [row({ kind: KIND_OPENED, ts: START, nonce: 0n, amount: 50_000_000n }), ...rows],
  };
}

// The Seeker case: 1.00 inside the limit, then 12.90 refused, allowed once, then paid.
const seekerRows = [
  row({ ts: START + DAY, nonce: 1n, amount: 1_000_000n }),
  row({ kind: KIND_REFUSED, ts: START + DAY + 60n, nonce: 2n, amount: 12_900_000n, reason: REASON_OVER_PER_TX_MAX }),
  row({ kind: KIND_OVERRIDE, ts: START + DAY + 120n, nonce: 2n, amount: 12_900_000n }),
  row({ ts: START + DAY + 180n, nonce: 2n, amount: 12_900_000n }),
];

test('the Overview paid tile says one was allowed once when a paid row is above the limit', () => {
  const copy = paidTileCopy(2, seekerRows, LIMIT);
  assert.equal(copy.hint, '1 allowed once by you');
  assert.equal(copy.accessibilityLabel, '2 payments paid by your agent, 1 allowed once by you');
  assert.doesNotMatch(copy.hint, /within the rule/);
});

test('the Overview paid tile keeps all within the rule only when every payment is at or under the limit', () => {
  const rows = [
    row({ nonce: 1n, amount: 1_000_000n }),
    row({ nonce: 2n, amount: LIMIT }),
  ];
  const copy = paidTileCopy(2, rows, LIMIT);
  assert.equal(copy.hint, 'all within the rule');
  assert.equal(copy.accessibilityLabel, '2 payments paid by your agent, all within the rule');
  assert.equal(paidTileCopy(1, [rows[0]!], LIMIT).accessibilityLabel, '1 payment paid by your agent, all within the rule');
});

test('the Overview paid tile counts every allowed-once payment and never says nonce or override', () => {
  const rows = [
    row({ nonce: 1n, amount: 6_000_000n }),
    row({ nonce: 2n, amount: 2_000_000n }),
    row({ nonce: 3n, amount: 12_900_000n }),
  ];
  const copy = paidTileCopy(3, rows, LIMIT);
  assert.equal(copy.hint, '2 allowed once by you');
  assert.doesNotMatch(`${copy.hint} ${copy.accessibilityLabel}`, /nonce|override/i);
});

test('the Overview paid tile does not claim all within the rule for payments older than the history shown', () => {
  const copy = paidTileCopy(6, [row({ nonce: 6n, amount: 1_000_000n })], LIMIT);
  assert.equal(copy.hint, 'each checked against the rule');
  assert.doesNotMatch(copy.accessibilityLabel, /all within the rule/);
});

test('week in review and the track record count only payments inside the limit as within the rule', () => {
  const now = START + 2n * DAY;
  const rule = snapshotRule(facts(seekerRows), now);
  const week = weekReviewFor(rule, 'Charging agent', now, 1);
  assert.equal(week.paidCount, 1);
  assert.match(weekFileText(week), /Paid: 1 payments, 1 USDC in total, all within the rule/);
  assert.match(weekFileText(week), /1 allowed after/);
  const track = trackRecordFor(rule, 'Charging agent', 'devnet', now, false);
  assert.equal(track.paid, 1);
  assert.ok(trackRecordLines(track).includes('1 payments paid, all within the rule'));
  assert.equal(track.allowances, 1);
});

test('a payment above the limit stays out of within the rule after its allowance row leaves the ledger window', () => {
  // The ledger keeps the newest 32 entries; the refusal and allowance rotate out before the payment.
  const now = START + 2n * DAY;
  const rows = [row({ nonce: 1n, amount: 1_000_000n }), row({ ts: START + DAY + 180n, nonce: 2n, amount: 12_900_000n })];
  const rule = snapshotRule(facts(rows), now);
  assert.equal(rule.classified.paidInside.length, 1);
  assert.equal(rule.classified.settlements.length, 1);
  assert.match(weekFileText(weekReviewFor(rule, 'Charging agent', now, 1)), /Paid: 1 payments/);
  assert.equal(trackRecordFor(rule, 'Charging agent', 'devnet', now, false).paid, 1);
  assert.equal(gradeRules([rule], now).paid, 1);
});

test('the first payment inside the rule plaque skips a payment the owner allowed once', () => {
  const now = START + 3n * DAY;
  const allowedFirst = [
    row({ kind: KIND_REFUSED, ts: START + DAY, nonce: 1n, amount: 12_900_000n, reason: REASON_OVER_PER_TX_MAX }),
    row({ kind: KIND_OVERRIDE, ts: START + DAY + 60n, nonce: 1n, amount: 12_900_000n }),
    row({ ts: START + DAY + 120n, nonce: 1n, amount: 12_900_000n }),
    row({ ts: START + 2n * DAY, nonce: 2n, amount: 2_000_000n }),
  ];
  const plaque = plaquesForRule(snapshotRule(facts(allowedFirst), now), now).find((item) => item.id === 'first-payment');
  assert.ok(plaque?.earned);
  assert.match(plaque.detail, /Paid 2 USDC/);
  assert.doesNotMatch(plaque.detail, /12\.9/);

  const onlyAllowed = allowedFirst.slice(0, 3);
  const pending = plaquesForRule(snapshotRule(facts(onlyAllowed), now), now).find((item) => item.id === 'first-payment');
  assert.equal(pending?.earned, false);
});

test('the Overview paid tile names an allowed-once count against the history shown when older payments are out of view', () => {
  const copy = paidTileCopy(6, [row({ nonce: 6n, amount: 12_900_000n })], LIMIT);
  assert.equal(copy.hint, '1 of the last 1 allowed once by you');
  assert.equal(copy.accessibilityLabel, '6 payments paid by your agent, 1 of the last 1 allowed once by you');
});

test('the Overview paid tile never says more were allowed once than were paid', () => {
  const rows = [row({ nonce: 1n, amount: 12_900_000n }), row({ nonce: 2n, amount: 6_000_000n })];
  assert.equal(paidTileCopy(1, rows, LIMIT).hint, '1 allowed once by you');
});

test('the grade counts a payment above the limit as outside the rule once, with or without its refusal and allowance in view', () => {
  const now = START + 2n * DAY;
  const inside = row({ nonce: 1n, amount: 1_000_000n });
  const above = row({ ts: START + DAY + 180n, nonce: 2n, amount: 12_900_000n });
  const refusal = row({ kind: KIND_REFUSED, ts: START + DAY + 60n, nonce: 2n, amount: 12_900_000n, reason: REASON_OVER_PER_TX_MAX });
  const allowance = row({ kind: KIND_OVERRIDE, ts: START + DAY + 120n, nonce: 2n, amount: 12_900_000n });
  const cases: [string, GradeDecision[]][] = [
    ['refusal, allowance and payment', [inside, refusal, allowance, above]],
    ['allowance and payment', [inside, allowance, above]],
    ['payment only', [inside, above]],
    ['the same request read twice', [inside, above, { ...above }]],
  ];
  for (const [name, rows] of cases) {
    const grade = gradeRules([snapshotRule(facts(rows), now)], now);
    assert.equal(grade.paid, 1, name);
    assert.equal(grade.outside, 1, name);
    assert.equal(grade.requests, 2, name);
  }
});

test('the request strip agrees with the grade for a payment above the limit with nothing else in view', () => {
  const now = START + 2n * DAY;
  const rows = [row({ nonce: 1n, amount: 1_000_000n }), row({ ts: START + DAY + 180n, nonce: 2n, amount: 12_900_000n })];
  const ticks = requestTicks(rows, LIMIT);
  assert.deepEqual(
    ticks.map((tick) => tick.kind),
    ['paid', 'refused'],
  );
  const [record] = buildAgentRecords([facts(rows)], {}, now);
  assert.equal(record?.tickLabel, '2 requests, oldest to newest: paid, refused.');
  assert.equal(record?.grade.paid, 1);
  assert.equal(record?.grade.outside, 1);
});
