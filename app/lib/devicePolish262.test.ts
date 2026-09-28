import assert from 'node:assert/strict';
import test from 'node:test';

import { Keypair } from '@solana/web3.js';

import { homeBlockCaption } from '../components/daily/facts';
import { decisionFace } from '../components/records/copy';
import { KIND_OPENED, KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE } from './constants';
import { formatBaseUnits } from './format';
import { buildAgentRecords, type GradeDecision, type RuleFacts } from './grade';
import { attachSignatures, type DecodedTxDecision, type RingEntry } from './ring';

const START = 1_700_000_000n;
const DAY = 86400n;
const AGENT = Keypair.generate().publicKey.toBase58();
const PAYEE = '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG';
const TOKEN_ACCOUNT = '2bt9bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbay7F';

function decision(over: Partial<GradeDecision> = {}): GradeDecision {
  return {
    kind: KIND_PAID,
    ts: START,
    amount: 8n,
    nonce: 1n,
    reason: 0,
    counterparty: PAYEE,
    ...over,
  };
}

function rule(over: Partial<RuleFacts> = {}): RuleFacts {
  return {
    address: 'Rule111111111111111111111111111111111111111',
    agent: AGENT,
    purpose: 'Charging top-ups',
    cap: 300n,
    spent: 0n,
    perTxMax: 10n,
    expiresAt: START + 90n * DAY - 1n,
    status: STATUS_ACTIVE,
    decimals: 0,
    rows: [decision({ kind: KIND_OPENED, ts: START, nonce: 0n, amount: 300n })],
    ...over,
  };
}

function paidEntry(over: Partial<RingEntry> = {}): RingEntry {
  return {
    ts: 5_000n,
    amount: 8n,
    counterparty: TOKEN_ACCOUNT,
    nonce: 3n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    kindName: 'paid',
    reason: 0,
    reasonText: 'ok',
    ...over,
  };
}

test('an agent with no saved name is titled Unnamed agent, not its address', () => {
  const record = buildAgentRecords([rule()], {}, START + 1n)[0];
  assert.ok(record);
  assert.equal(record.name, 'Unnamed agent');
  assert.notEqual(record.name, record.shortAddress);
  assert.equal(record.named, false);
});

test('day 1 of a 90 day rule uses 90 as the length, not the 89 whole days left in the span', () => {
  const record = buildAgentRecords([rule()], { [AGENT]: 'Charging agent' }, START + 1n)[0];
  assert.ok(record);
  assert.equal(record.daysValue, '1 of 90');
});

test('a paid row on screen shows two decimals and the exact amount stays available', () => {
  assert.equal(formatBaseUnits(15_152_750n, 6), '15.15275');
  assert.equal(formatBaseUnits(16_939_875n, 6), '16.939875');
  const face = decisionFace(
    {
      ...paidEntry(),
      amount: 15_152_750n,
      signature: 'sig-paid',
    },
    6,
    20_000_000n,
    undefined,
  );
  assert.match(face.title, /Paid 15\.15 /);
  assert.equal(face.figure, '-15.15');
  assert.doesNotMatch(`${face.title} ${face.figure}`, /15\.15275/);
  const other = decisionFace(
    {
      ...paidEntry(),
      amount: 16_939_875n,
      signature: 'sig-other',
    },
    6,
    20_000_000n,
    undefined,
  );
  assert.match(other.title, /Paid 16\.94 /);
});

test('a decision with no signature says it is saved on the blockchain and does not talk about the RPC', () => {
  const face = decisionFace(
    {
      ...paidEntry(),
      signature: null,
    },
    0,
    10n,
    undefined,
  );
  assert.match(face.detail, /Saved on the blockchain/);
  assert.doesNotMatch(face.detail, /RPC|signature|invented/i);
});

test('a ledger row whose chain time is a couple of seconds off still gets its signature', () => {
  const rows = attachSignatures([paidEntry({ ts: 5_000n })], [
    {
      signature: 'sig-live',
      kind: KIND_PAID,
      amount: 8n,
      nonce: 3n,
      reason: 0,
      blockTime: 5_002,
    } as DecodedTxDecision,
  ]);
  assert.equal(rows[0]?.signature, 'sig-live');
});

test('an evicted signature from a much earlier block does not attach to the live row', () => {
  const rows = attachSignatures([paidEntry({ ts: 5_000n })], [
    {
      signature: 'sig-evicted',
      kind: KIND_PAID,
      amount: 8n,
      nonce: 3n,
      reason: 0,
      blockTime: 1_000,
    } as DecodedTxDecision,
  ]);
  assert.equal(rows[0]?.signature, null);
});

test('a paid row names the rule payee, not the token account the chain stored', () => {
  const face = decisionFace(
    {
      ...paidEntry(),
      signature: 'sig-paid',
    },
    0,
    10n,
    undefined,
    { payee: PAYEE },
  );
  assert.match(face.title, /Paid 8 to 6i99\.\.\.PdCG/);
  assert.doesNotMatch(face.title, /2bt9/);
});

test('the home block line says one payment when the cap is 30 payments, and plain words otherwise', () => {
  assert.equal(
    homeBlockCaption('1 block is one share of 300', 'Most per payment: 10'),
    '1 block = 1 payment of 10',
  );
  assert.equal(
    homeBlockCaption('1 block is one share of 300 VTEST', 'Most per payment: 10 VTEST'),
    '1 block = 1 payment of 10 VTEST',
  );
  assert.equal(
    homeBlockCaption('1 block is one share of 300', 'Most per payment: 15'),
    '1 block is 10 of your 300',
  );
  assert.equal(
    homeBlockCaption('1 block is one share of 100', 'Most per payment: 10'),
    '1 block is one thirtieth of your 100',
  );
});

test('a refusal that has a signature offers the blockchain in plain words', () => {
  const face = decisionFace(
    {
      ts: 5_000n,
      amount: 14n,
      counterparty: TOKEN_ACCOUNT,
      nonce: 4n,
      suggestedOverride: 14n,
      kind: KIND_REFUSED,
      kindName: 'refused',
      reason: REASON_OVER_PER_TX_MAX,
      reasonText: 'over per-payment maximum',
      signature: 'sig-refused',
    },
    0,
    10n,
    undefined,
  );
  assert.equal(face.chainLink, 'See it on the blockchain');
  assert.doesNotMatch(face.detail, /RPC/);
});
