import assert from 'node:assert/strict';
import test from 'node:test';

import { PNG } from 'pngjs';
import jsQR from 'jsqr';

import { KIND_ADVISORY_DECLINE } from './advisory';
import { KIND_OPENED, KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE, STATUS_EXPIRED } from './constants';
import { snapshotRule, type GradeDecision, type RuleFacts } from './grade';
import { VTEST_MINT } from './tokens';
import {
  glyphOn,
  pngComment,
  ruleCheckUrl,
  trackRecordFor,
  trackRecordLines,
  trackRecordPng,
  trackRecordText,
} from './trackRecord';

const START = 1_700_000_000n;
const DAY = 86400n;
const ADDRESS = '6YwqYUxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxGSV5w';

function decision(over: Partial<GradeDecision> = {}): GradeDecision {
  return {
    kind: KIND_PAID,
    ts: START + DAY,
    amount: 8n,
    nonce: 1n,
    reason: 0,
    counterparty: 'payee',
    ...over,
  };
}

function facts(rows: GradeDecision[], over: Partial<RuleFacts> = {}): RuleFacts {
  return {
    address: ADDRESS,
    agent: 'AgentTrack11111111111111111111111111111111',
    purpose: 'Charging top-ups',
    cap: 300n,
    spent: 268n,
    perTxMax: 10n,
    expiresAt: START + 90n * DAY,
    status: STATUS_EXPIRED,
    decimals: 0,
    mint: VTEST_MINT,
    rows: [decision({ kind: KIND_OPENED, ts: START, nonce: 0n, amount: 300n }), ...rows],
    ...over,
  };
}

test('a finished rule card states the outside count, the return, and Devnet', () => {
  const rows = [
    ...Array.from({ length: 61 }, (_, index) => decision({ nonce: BigInt(index + 1), amount: 4n })),
    ...Array.from({ length: 11 }, (_, index) =>
      decision({
        kind: KIND_REFUSED,
        nonce: BigInt(100 + index),
        amount: 14n,
        reason: REASON_OVER_PER_TX_MAX,
      }),
    ),
    decision({ kind: KIND_ADVISORY_DECLINE, nonce: 9n, amount: 3n }),
  ];
  const now = START + 90n * DAY;
  const record = trackRecordFor(snapshotRule(facts(rows), now), 'Charging agent', 'devnet', now, true);
  assert.equal(record.badge, 'Devnet');
  assert.equal(record.paid, 61);
  assert.equal(record.refused, 11);
  assert.equal(record.allowances, 0);
  assert.equal(record.qrText, ADDRESS);
  assert.match(record.lead, /Asked outside its rule 11 times in 90 days/);
  assert.equal(record.follow, 'Refused every time.');
  const lines = trackRecordLines(record).join('\n');
  assert.match(lines, /Devnet/);
  assert.match(lines, /32 VTEST returned to the owner/);
  assert.doesNotMatch(lines, /decline/i);
  const text = trackRecordText(record, ruleCheckUrl(ADDRESS, 'devnet', 'https://api.devnet.solana.com'));
  assert.match(text, /explorer\.solana\.com\/address\/.+cluster=devnet/);
});

test('the shared image is a PNG of the rule address as a QR, and it says Devnet', () => {
  const now = START + 90n * DAY;
  const record = trackRecordFor(
    snapshotRule(facts([decision()], { spent: 8n, status: STATUS_ACTIVE }), now),
    'Charging agent',
    'devnet',
    now,
    false,
  );
  const bytes = trackRecordPng(record);
  assert.equal(bytes[0], 137);
  assert.equal(bytes[1], 80);
  const comment = pngComment(bytes);
  assert.match(comment ?? '', /Devnet/);
  assert.match(comment ?? '', new RegExp(ADDRESS));
  const png = PNG.sync.read(Buffer.from(bytes));
  const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.equal(code?.data, ADDRESS);
  assert.equal(glyphOn('D', 0, 0), true);
  assert.equal(glyphOn('D', 0, 4), false);
});

test('a mainnet card does not call itself Devnet', () => {
  const now = START + 2n * DAY;
  const record = trackRecordFor(
    snapshotRule(facts([decision()], { status: STATUS_ACTIVE, spent: 8n }), now),
    'Charging agent',
    'mainnet-beta',
    now,
    false,
  );
  assert.equal(record.badge, 'Mainnet');
  assert.doesNotMatch(trackRecordLines(record).join('\n'), /Devnet/);
});
