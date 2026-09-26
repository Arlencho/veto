import assert from 'node:assert/strict';
import test from 'node:test';

import { KIND_OPENED, KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, KIND_REVOKED } from './constants';
import {
  formatBaseUnits,
  roundShownAmounts,
  formatDayHeading,
  formatTimeLeft,
  groupByLocalDay,
  isListedDecision,
  isLocalDay,
  parseBaseUnits,
  remainingCap,
  todaysAgentDecisions,
} from './format';
import type { RingEntry } from './ring';

test('parse and format base units without floats', () => {
  assert.equal(parseBaseUnits('100', 6), 100_000_000n);
  assert.equal(parseBaseUnits('0.5', 6), 500_000n);
  assert.equal(formatBaseUnits(500_000n, 6), '0.5');
  assert.equal(formatBaseUnits(100_000_000n, 6), '100');
  assert.equal(remainingCap(100n, 40n), 60n);
  assert.equal(remainingCap(10n, 40n), 0n);
});

test('formatTimeLeft names remaining time or expired', () => {
  assert.equal(formatTimeLeft(100n, 100n), 'expired');
  assert.equal(formatTimeLeft(100n + 86400n * 2n + 3600n, 100n), '2d 1h left');
  assert.equal(formatTimeLeft(100n + 3600n + 60n, 100n), '1h 1m left');
});

test('today lists paid, refused and override newest first and skips opened and revoked', () => {
  const noon = new Date(2026, 8, 20, 12, 0, 0);
  const prior = new Date(2026, 8, 19, 12, 0, 0);
  const ts = BigInt(Math.floor(noon.getTime() / 1000));
  const yesterday = BigInt(Math.floor(prior.getTime() / 1000));
  const peer = '11111111111111111111111111111111';
  const entry = (kind: number, nonce: bigint, time: bigint): RingEntry => ({
    ts: time,
    amount: 1n,
    counterparty: peer,
    nonce,
    suggestedOverride: 0n,
    kind,
    kindName: String(kind),
    reason: 0,
    reasonText: 'ok',
  });
  const rows = todaysAgentDecisions(
    [
      entry(KIND_OPENED, 0n, ts),
      entry(KIND_PAID, 1n, ts),
      entry(KIND_REFUSED, 2n, ts),
      entry(KIND_OVERRIDE, 2n, ts),
      entry(KIND_REVOKED, 0n, ts),
      entry(KIND_PAID, 3n, yesterday),
    ],
    noon.getTime(),
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.kind, KIND_OVERRIDE);
  assert.equal(rows[1]?.nonce, 2n);
  assert.equal(rows[2]?.nonce, 1n);
  assert.equal(isLocalDay(yesterday, noon.getTime()), false);
  assert.equal(isListedDecision(KIND_PAID), true);
  assert.equal(isListedDecision(KIND_REFUSED), true);
  assert.equal(isListedDecision(KIND_OVERRIDE), true);
  assert.equal(isListedDecision(KIND_OPENED), false);
  assert.equal(isListedDecision(KIND_REVOKED), false);
});

test('decision rows from several days sit under the heading for their own day', () => {
  const eighteenth = BigInt(Math.floor(new Date(2026, 8, 18, 15, 0, 0).getTime() / 1000));
  const twentieth = BigInt(Math.floor(new Date(2026, 8, 20, 9, 0, 0).getTime() / 1000));
  const groups = groupByLocalDay([{ ts: twentieth, nonce: 2n }, { ts: eighteenth, nonce: 1n }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.heading, formatDayHeading(twentieth));
  assert.equal(groups[0]?.rows.map((row) => row.nonce).join(','), '2');
  assert.equal(groups[1]?.heading, formatDayHeading(eighteenth));
  assert.equal(groups[1]?.rows.map((row) => row.nonce).join(','), '1');
  assert.notEqual(groups[0]?.heading, groups[1]?.heading);
});

test('today keeps signatures already on the rows', () => {
  const noon = new Date(2026, 8, 20, 12, 0, 0);
  const ts = BigInt(Math.floor(noon.getTime() / 1000));
  const peer = '11111111111111111111111111111111';
  const row = (nonce: bigint, signature: string) => ({
    ts,
    amount: 1n,
    counterparty: peer,
    nonce,
    suggestedOverride: 0n,
    kind: KIND_REFUSED,
    kindName: 'refused',
    reason: 1,
    reasonText: 'mandate not active',
    signature,
  });
  const rows = todaysAgentDecisions([row(1n, 'sig-one'), row(1n, 'sig-two')], noon.getTime());
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.signature, 'sig-two');
  assert.equal(rows[1]?.signature, 'sig-one');
});

test('display copy keeps four SOL decimals and two USDC decimals without rounding twice', () => {
  const shown = roundShownAmounts('0.123456789 wrapped SOL for 10.992 USDC');
  assert.equal(shown, '0.1235 wrapped SOL for 10.99 USDC');
  assert.equal(roundShownAmounts(shown), shown);
});
