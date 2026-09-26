import assert from 'node:assert/strict';
import test from 'node:test';

import { Keypair } from '@solana/web3.js';

import { KIND_ADVISORY_DECLINE } from './advisory';
import { KIND_OPENED, KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, REASON_OUTPUT_ACCOUNT_NOT_ALLOWED, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE } from './constants';
import { DEVNET_USDC_MINT, VTEST_MINT } from './tokens';
import {
  GRADE_LABEL,
  GRADE_RULE,
  agentName,
  agentsHeading,
  buildAgentRecords,
  gradeCardLine,
  gradeRecordLine,
  gradeRules,
  liveRulesLabel,
  networkBadge,
  type GradeDecision,
  type RuleFacts,
} from './grade';

const START = 1_700_000_000n;
const DAY = 86400n;
const NOW = START + 10n * DAY;

function decision(over: Partial<GradeDecision> = {}): GradeDecision {
  return {
    kind: KIND_PAID,
    ts: START + 1n,
    amount: 8n,
    nonce: 1n,
    reason: 0,
    counterparty: 'Payee111111111111111111111111111111111111',
    ...over,
  };
}

function opened(): GradeDecision {
  return decision({ kind: KIND_OPENED, ts: START, nonce: 0n, amount: 300n });
}

function paid(count: number, nonceStart = 1): GradeDecision[] {
  return Array.from({ length: count }, (_, index) =>
    decision({ kind: KIND_PAID, nonce: BigInt(nonceStart + index), ts: START + BigInt(index + 1) }),
  );
}

function refused(count: number, nonceStart = 100): GradeDecision[] {
  return Array.from({ length: count }, (_, index) =>
    decision({
      kind: KIND_REFUSED,
      nonce: BigInt(nonceStart + index),
      ts: START + BigInt(index + 1),
      reason: REASON_OVER_PER_TX_MAX,
      amount: 14n,
    }),
  );
}

function rule(rows: GradeDecision[], agent = 'agent'): RuleFacts {
  return {
    address: `rule-${agent}`,
    agent,
    purpose: 'Charging top-ups',
    cap: 300n,
    spent: 42n,
    perTxMax: 10n,
    expiresAt: START + 90n * DAY,
    status: STATUS_ACTIVE,
    decimals: 0,
    rows,
  };
}

test('a refused trade is outside the rule and a traded one is inside, on the same agent as a payment rule', () => {
  const agent = 'same-agent';
  const payment = rule([opened(), ...paid(1), ...refused(1)], agent);
  payment.mint = VTEST_MINT;
  payment.cap = 111n;
  payment.decimals = 0;
  const trade = rule(
    [
      decision({ kind: KIND_PAID, nonce: 1n, ts: START + 2n, amount: 2n }),
      decision({
        kind: KIND_REFUSED,
        nonce: 2n,
        ts: START + 3n,
        amount: 3n,
        reason: REASON_OUTPUT_ACCOUNT_NOT_ALLOWED,
      }),
    ],
    agent,
  );
  trade.mint = DEVNET_USDC_MINT;
  trade.cap = 222n;
  trade.decimals = 0;
  trade.purpose = 'trading bot';
  const records = buildAgentRecords([payment, trade], {}, NOW);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.grade.paid, 2);
  assert.equal(records[0]?.grade.outside, 2);
  assert.equal(records[0]?.grade.requests, 4);
  assert.equal(records[0]?.spend, null);
  const labels = records[0]?.rules.map((row) => row.capLabel) ?? [];
  assert.ok(labels.some((label) => label.includes('111') && label.includes('VTEST')));
  assert.ok(labels.some((label) => label.includes('222') && label.includes('USDC')));
  assert.equal(labels.some((label) => label.includes('333')), false);
});

test('fewer than 1 request in 20 is stayed inside its rule', () => {
  const grade = gradeRules([rule([opened(), ...paid(20)])], NOW);
  assert.equal(grade.id, 'stayed');
  assert.equal(grade.label, GRADE_LABEL.stayed);
  assert.equal(grade.requests, 20);
  assert.equal(grade.outside, 0);
  assert.equal(gradeCardLine(grade), '0 of its 20 requests outside its rule.');
});

test('exactly 1 request in 20 is tested its limit now and then', () => {
  const grade = gradeRules([rule([opened(), ...paid(19), ...refused(1)])], NOW);
  assert.equal(grade.id, 'tested');
  assert.equal(grade.label, GRADE_LABEL.tested);
  assert.equal(grade.outside, 1);
  assert.equal(grade.requests, 20);
});

test('exactly 4 requests in 20 stay in tested its limit', () => {
  const grade = gradeRules([rule([opened(), ...paid(16), ...refused(4)])], NOW);
  assert.equal(grade.id, 'tested');
  assert.equal(grade.requests, 20);
  assert.equal(grade.outside, 4);
});

test('more than 4 requests in 20 is pushed its limit often', () => {
  const grade = gradeRules([rule([opened(), ...paid(6), ...refused(12)])], NOW);
  assert.equal(grade.id, 'pushed');
  assert.equal(grade.label, GRADE_LABEL.pushed);
  assert.equal(gradeRecordLine(grade), 'Its rule: more than 4 requests in 20 outside the rule. This agent: 12 of 18, all 12 refused.');
});

test('fewer than 10 requests is too new to grade and the facts still show', () => {
  const grade = gradeRules([rule([opened(), ...paid(3)])], NOW);
  assert.equal(grade.id, 'too-new');
  assert.equal(grade.label, GRADE_LABEL['too-new']);
  assert.equal(grade.paid, 3);
  assert.equal(grade.requests, 3);
  assert.match(gradeCardLine(grade), /3 of the 10 requests needed/);
});

test('fewer than 3 days running is too new even with 10 requests', () => {
  const grade = gradeRules([rule([opened(), ...paid(10)])], START + DAY);
  assert.equal(grade.daysRunning, 2);
  assert.equal(grade.id, 'too-new');
  assert.match(gradeCardLine(grade), /day 2 of the 3 needed/);
});

test('day 3 with 10 inside requests is stayed inside its rule', () => {
  const grade = gradeRules([rule([opened(), ...paid(10)])], START + 2n * DAY);
  assert.equal(grade.daysRunning, 3);
  assert.equal(grade.id, 'stayed');
});

test('an allowed payment still counts as outside and is not paid inside', () => {
  const rows = [
    opened(),
    ...paid(9, 2),
    decision({ kind: KIND_REFUSED, nonce: 1n, reason: REASON_OVER_PER_TX_MAX, amount: 14n }),
    decision({ kind: KIND_OVERRIDE, nonce: 1n, amount: 14n, ts: START + 2n }),
    decision({ kind: KIND_PAID, nonce: 1n, amount: 14n, ts: START + 3n }),
  ];
  const grade = gradeRules([rule(rows)], NOW);
  assert.equal(grade.paid, 9);
  assert.equal(grade.outside, 1);
  assert.equal(grade.allowances, 1);
  assert.equal(grade.requests, 10);
  assert.match(gradeCardLine(grade), /Allowed once/);
});

test('an allowance whose refusal is off the ring still counts as outside', () => {
  const rows = [opened(), ...paid(10, 2), decision({ kind: KIND_OVERRIDE, nonce: 1n, amount: 14n })];
  const grade = gradeRules([rule(rows)], NOW);
  assert.equal(grade.paid, 10);
  assert.equal(grade.outside, 1);
  assert.equal(grade.requests, 11);
});

test('two or more allowances move the grade one step lower', () => {
  const refusals = refused(2, 1);
  const rows = [
    opened(),
    ...paid(39, 10),
    ...refusals,
    decision({ kind: KIND_OVERRIDE, nonce: 1n, amount: 14n }),
    decision({ kind: KIND_OVERRIDE, nonce: 2n, amount: 14n }),
  ];
  const grade = gradeRules([rule(rows)], NOW);
  assert.equal(grade.band, 'stayed');
  assert.equal(grade.id, 'tested');
  assert.equal(grade.steppedDown, true);
  assert.match(gradeRecordLine(grade), /one step lower/);
});

test('the agent own declines and an unknown money row are never counted', () => {
  const rows = [
    opened(),
    ...paid(10),
    decision({ kind: KIND_ADVISORY_DECLINE, nonce: 80n, amount: 4n }),
    decision({ kind: 77, nonce: 81n, amount: 999n }),
  ];
  const grade = gradeRules([rule(rows)], NOW);
  assert.equal(grade.requests, 10);
  assert.equal(grade.declines, 1);
  assert.equal(grade.outside, 0);
  assert.equal(grade.movedOutside, 0);
  assert.equal(grade.id, 'stayed');
});

test('decisions from every rule of one agent are one grade, and a second agent is separate', () => {
  const agent = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();
  const first = rule([opened(), ...paid(6), ...refused(4)], agent);
  const second = rule([opened(), ...paid(4), ...refused(6)], agent);
  second.address = 'rule-b';
  const foreign = rule([opened(), ...paid(20)], other);
  const records = buildAgentRecords(
    [first, second, foreign],
    { [agent]: 'Charging agent' },
    NOW,
  );
  assert.equal(records.length, 2);
  const charging = records.find((record) => record.agent === agent);
  assert.ok(charging);
  assert.equal(charging.name, 'Charging agent');
  assert.equal(charging.grade.requests, 20);
  assert.equal(charging.grade.outside, 10);
  assert.equal(charging.grade.id, 'pushed');
  assert.equal(records.find((record) => record.agent === other)?.grade.id, 'stayed');
  assert.equal(agentsHeading(records), '2 running, across 3 rules');
  assert.equal(liveRulesLabel(2), '2 rules live');
  assert.equal(agentName(other, {}), records.find((record) => record.agent === other)?.name);
});

test('the grade sentences are the four rules on the how grades work screen', () => {
  assert.equal(GRADE_RULE.stayed, 'Fewer than 1 request in 20 outside its rule.');
  assert.equal(GRADE_RULE.tested, '1 to 4 requests in 20 outside its rule.');
  assert.equal(GRADE_RULE.pushed, 'More than 4 requests in 20 outside its rule.');
  assert.match(GRADE_RULE['too-new'], /Fewer than 10 requests/);
  assert.match(GRADE_RULE['too-new'], /fewer than 3 days/);
  assert.equal(networkBadge('devnet', 'card'), 'Devnet');
  assert.equal(networkBadge('devnet', 'name'), 'Devnet');
  assert.equal(networkBadge('devnet', 'tokens'), 'Devnet');
  assert.equal(networkBadge('mainnet-beta', 'card'), 'Mainnet');
});
