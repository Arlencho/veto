import assert from 'node:assert/strict';
import test from 'node:test';

import { KIND_OPENED, KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, KIND_REVOKED, REASON_OVER_CAP, REASON_OVER_PER_TX_MAX } from './constants';
import { encodeDecisionId, parseDecisionId } from './exportRecord';
import {
  DECISION_NOTIFY_INTERVAL_MINUTES,
  decisionPathFromNoticeData,
  deliverDecisionNotices,
  paidDecisionBody,
  parseSeenIds,
  planDecisionNotices,
  seenStorageKey,
  serializeSeenIds,
  type DecisionNotice,
  type NotifyLedgerRow,
  type NotifyMandateLedger,
} from './notify';
import { refusalWhyLine } from './reasons';
import { VTEST_MINT } from './tokens';

const MERCHANT = '11111111111111111111111111111111';
const MANDATE_A = 'MandateAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MANDATE_B = 'MandateBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function row(args: Partial<NotifyLedgerRow> & Pick<NotifyLedgerRow, 'kind' | 'nonce' | 'ts'>): NotifyLedgerRow {
  return {
    amount: 0n,
    reason: 0,
    suggestedOverride: 0n,
    ...args,
  };
}

function ledger(
  mandate: string,
  rows: readonly NotifyLedgerRow[],
  perTxMax = 500_000n,
): NotifyMandateLedger {
  return {
    mandate,
    merchant: MERCHANT,
    perTxMax,
    decimals: 6,
    mint: VTEST_MINT,
    rows,
  };
}

const refusalArgs = {
  reason: REASON_OVER_PER_TX_MAX,
  amount: 6_232_500n,
  suggestedOverride: 6_232_500n,
  decimals: 6,
  perTxMax: 500_000n,
  mint: VTEST_MINT,
};

function refusalRow(): NotifyLedgerRow {
  return row({
    ts: 1_700_000_000n,
    kind: KIND_REFUSED,
    nonce: 4n,
    reason: refusalArgs.reason,
    amount: refusalArgs.amount,
    suggestedOverride: refusalArgs.suggestedOverride,
  });
}

test('a refusal notification repeats the decision screen reason line', () => {
  const line = refusalWhyLine(refusalArgs);
  assert.equal(
    line,
    'Asked for 6.2325 VTEST, over the 0.5 VTEST per-payment maximum. A one-time allowance of 6.2325 VTEST would have cleared it.',
  );
  const plan = planDecisionNotices([ledger(MANDATE_A, [refusalRow()])], new Map());
  assert.equal(plan.notices.length, 1);
  const notice = plan.notices[0];
  assert.ok(notice);
  assert.equal(notice.title, 'Refused');
  assert.equal(notice.body, line);
});

test('a refusal for another reason uses that reason line and not the per-payment sentence', () => {
  const args = {
    reason: REASON_OVER_CAP,
    amount: 50n,
    suggestedOverride: 9n,
    decimals: 0,
    perTxMax: 60n,
  };
  const line = refusalWhyLine(args);
  assert.equal(line, 'over remaining cap.');
  const plan = planDecisionNotices(
    [
      {
        mandate: MANDATE_A,
        merchant: MERCHANT,
        perTxMax: args.perTxMax,
        decimals: args.decimals,
        rows: [
          row({
            ts: 20n,
            kind: KIND_REFUSED,
            nonce: 2n,
            reason: args.reason,
            amount: args.amount,
            suggestedOverride: args.suggestedOverride,
          }),
        ],
      },
    ],
    new Map(),
  );
  assert.equal(plan.notices.length, 1);
  assert.equal(plan.notices[0]?.body, line);
  assert.equal(plan.notices[0]?.body.includes('per-payment'), false);
});

test('a paid notification repeats the decision screen paid line', () => {
  const body = paidDecisionBody({
    amount: 446_000n,
    decimals: 6,
    perTxMax: 500_000n,
    merchant: MERCHANT,
    mint: VTEST_MINT,
  });
  assert.equal(body, '0.446 VTEST, under 0.5 VTEST per payment. The payee for this rule is 1111...1111.');
  const plan = planDecisionNotices(
    [
      ledger(MANDATE_A, [
        row({ ts: 30n, kind: KIND_PAID, nonce: 8n, amount: 446_000n, reason: 0 }),
      ]),
    ],
    new Map(),
  );
  assert.equal(plan.notices.length, 1);
  assert.equal(plan.notices[0]?.title, 'Paid within rule');
  assert.equal(plan.notices[0]?.body, body);
});

test('opened, revoked, and override rows do not raise a notification', () => {
  const plan = planDecisionNotices(
    [
      ledger(MANDATE_A, [
        row({ ts: 1n, kind: KIND_OPENED, nonce: 0n }),
        row({ ts: 2n, kind: KIND_REVOKED, nonce: 0n }),
        row({
          ts: 3n,
          kind: KIND_OVERRIDE,
          nonce: 4n,
          amount: 6_232_500n,
          reason: REASON_OVER_PER_TX_MAX,
          suggestedOverride: 6_232_500n,
        }),
        row({ ts: 4n, kind: KIND_PAID, nonce: 9n, amount: 100_000n }),
      ]),
    ],
    new Map(),
  );
  assert.equal(plan.notices.length, 1);
  assert.equal(plan.notices[0]?.title, 'Paid within rule');
});

test('the same ledger row twice is announced once', () => {
  const paid = row({ ts: 4n, kind: KIND_PAID, nonce: 9n, amount: 100_000n });
  const plan = planDecisionNotices([ledger(MANDATE_A, [paid, { ...paid }])], new Map());
  assert.equal(plan.notices.length, 1);
  assert.deepEqual(plan.seenByMandate.get(MANDATE_A), [plan.notices[0]?.id]);
});

test('a decision the phone already announced stays quiet, including on a second rule', async () => {
  const refused = refusalRow();
  const paid = row({ ts: 40n, kind: KIND_PAID, nonce: 3n, amount: 100_000n });
  const firstLedgers = [ledger(MANDATE_A, [refused, paid])];
  const stored = new Map<string, string>();
  const shown: DecisionNotice[] = [];
  await deliverDecisionNotices({
    ledgers: firstLedgers,
    seenByMandate: new Map([[MANDATE_A, new Set()]]),
    present: async (notice) => {
      shown.push(notice);
    },
    saveSeen: async (mandate, ids) => {
      stored.set(seenStorageKey(mandate), serializeSeenIds(mandate, ids));
    },
  });
  assert.deepEqual(
    shown.map((notice) => notice.title),
    ['Refused', 'Paid within rule'],
  );
  assert.equal(shown[0]?.body, refusalWhyLine(refusalArgs));

  const remembered = parseSeenIds(MANDATE_A, stored.get(seenStorageKey(MANDATE_A)) ?? null);
  assert.ok(remembered);
  assert.equal(remembered.size, 2);

  const again: DecisionNotice[] = [];
  await deliverDecisionNotices({
    ledgers: [ledger(MANDATE_A, [refused, paid]), ledger(MANDATE_B, [refusalRow()])],
    seenByMandate: new Map([
      [MANDATE_A, remembered],
      [MANDATE_B, new Set()],
    ]),
    present: async (notice) => {
      again.push(notice);
    },
    saveSeen: async (mandate, ids) => {
      stored.set(seenStorageKey(mandate), serializeSeenIds(mandate, ids));
    },
  });
  assert.equal(again.length, 1);
  assert.equal(again[0]?.title, 'Refused');
  assert.equal(parseDecisionId(again[0]?.id ?? '')?.mandate, MANDATE_B);
  assert.equal(again[0]?.body, refusalWhyLine(refusalArgs));
});

test('a failed announcement does not mark that decision as announced', async () => {
  const paid = row({ ts: 40n, kind: KIND_PAID, nonce: 3n, amount: 100_000n });
  const refused = refusalRow();
  const stored = new Map<string, string>();
  const shown: DecisionNotice[] = [];
  await assert.rejects(
    deliverDecisionNotices({
      ledgers: [ledger(MANDATE_A, [paid, refused])],
      seenByMandate: new Map([[MANDATE_A, new Set()]]),
      present: async (notice) => {
        if (notice.title === 'Refused') {
          throw new Error('notification tray rejected the refusal');
        }
        shown.push(notice);
      },
      saveSeen: async (mandate, ids) => {
        stored.set(mandate, serializeSeenIds(mandate, ids));
      },
    }),
    /notification tray rejected the refusal/,
  );
  assert.deepEqual(
    shown.map((notice) => notice.title),
    ['Paid within rule'],
  );
  const remembered = parseSeenIds(MANDATE_A, stored.get(MANDATE_A) ?? null);
  assert.ok(remembered);
  assert.equal(remembered.has(encodeDecisionId(MANDATE_A, paid)), true);
  assert.equal(remembered.has(encodeDecisionId(MANDATE_A, refused)), false);

  const later: DecisionNotice[] = [];
  await deliverDecisionNotices({
    ledgers: [ledger(MANDATE_A, [paid, refused])],
    seenByMandate: new Map([[MANDATE_A, remembered]]),
    present: async (notice) => {
      later.push(notice);
    },
    saveSeen: async () => undefined,
  });
  assert.equal(later.length, 1);
  assert.equal(later[0]?.body, refusalWhyLine(refusalArgs));
});

test('a decision that has left the ledger is forgotten', () => {
  const gone = row({ ts: 1n, kind: KIND_PAID, nonce: 1n, amount: 1n });
  const fresh = row({ ts: 2n, kind: KIND_REFUSED, nonce: 2n, reason: REASON_OVER_CAP, amount: 5n });
  const goneId = encodeDecisionId(MANDATE_A, gone);
  const plan = planDecisionNotices([ledger(MANDATE_A, [fresh])], new Map([[MANDATE_A, new Set([goneId])]]));
  assert.equal(plan.notices.length, 1);
  assert.equal(plan.seenByMandate.get(MANDATE_A)?.includes(goneId), false);
  assert.equal(plan.notices[0]?.body, 'over remaining cap.');
});

test('tapping the notification opens that decision', () => {
  const plan = planDecisionNotices([ledger(MANDATE_A, [refusalRow()])], new Map());
  const notice = plan.notices[0];
  assert.ok(notice);
  const path = decisionPathFromNoticeData({ decisionId: notice.id });
  assert.equal(path, `/decision/${encodeURIComponent(notice.id)}`);
  assert.equal(path, notice.path);
  const id = decodeURIComponent((path ?? '').slice('/decision/'.length));
  const parsed = parseDecisionId(id);
  assert.equal(parsed?.mandate, MANDATE_A);
  assert.equal(parsed?.kind, KIND_REFUSED);
  assert.equal(parsed?.nonce, 4n);
  assert.equal(decisionPathFromNoticeData(null), null);
  assert.equal(decisionPathFromNoticeData({ decisionId: 'not-a-decision' }), null);
});

test('a full ring of remembered decisions fits in one secure-store value', () => {
  const rows = Array.from({ length: 32 }, (_, index) =>
    row({
      ts: 9_223_372_036_854_775_807n,
      kind: index % 2 === 0 ? KIND_PAID : KIND_REFUSED,
      nonce: 18_446_744_073_709_551_615n - BigInt(index),
      reason: index % 2 === 0 ? 0 : REASON_OVER_CAP,
      amount: 1n,
    }),
  );
  const mandate = '1'.repeat(44);
  const plan = planDecisionNotices([ledger(mandate, rows)], new Map());
  assert.equal(plan.notices.length, 32);
  const value = serializeSeenIds(mandate, plan.seenByMandate.get(mandate) ?? []);
  assert.equal(value.length <= 2048, true);
  const roundTrip = parseSeenIds(mandate, value);
  assert.ok(roundTrip);
  assert.equal(roundTrip.size, 32);
  assert.equal(parseSeenIds(mandate, '{'), null);
  assert.equal(parseSeenIds(mandate, '{}'), null);
  assert.match(seenStorageKey(mandate), /^[A-Za-z0-9._-]+$/);
});

test('the background read waits at least 15 minutes, the Android floor', () => {
  assert.equal(DECISION_NOTIFY_INTERVAL_MINUTES, 15);
});

test('the first read of a rule stores every decision already on it and announces none', async () => {
  const refused = refusalRow();
  const paid = row({ ts: 40n, kind: KIND_PAID, nonce: 3n, amount: 100_000n });
  const stored = new Map<string, string>();
  const shown: DecisionNotice[] = [];
  await deliverDecisionNotices({
    ledgers: [ledger(MANDATE_A, [refused, paid])],
    seenByMandate: new Map(),
    present: async (notice) => {
      shown.push(notice);
    },
    saveSeen: async (mandate, ids) => {
      stored.set(mandate, serializeSeenIds(mandate, ids));
    },
  });
  assert.equal(shown.length, 0);
  const remembered = parseSeenIds(MANDATE_A, stored.get(MANDATE_A) ?? null);
  assert.ok(remembered);
  assert.equal(remembered.has(encodeDecisionId(MANDATE_A, refused)), true);
  assert.equal(remembered.has(encodeDecisionId(MANDATE_A, paid)), true);
});

test('a rule added later stores the decisions already on it and announces none', async () => {
  const refused = refusalRow();
  const paid = row({ ts: 40n, kind: KIND_PAID, nonce: 3n, amount: 100_000n });
  const already = refusalRow();
  const stored = new Map<string, string>();
  const shown: DecisionNotice[] = [];
  await deliverDecisionNotices({
    ledgers: [ledger(MANDATE_A, [refused, paid]), ledger(MANDATE_B, [already])],
    seenByMandate: new Map([
      [
        MANDATE_A,
        new Set([encodeDecisionId(MANDATE_A, refused), encodeDecisionId(MANDATE_A, paid)]),
      ],
    ]),
    present: async (notice) => {
      shown.push(notice);
    },
    saveSeen: async (mandate, ids) => {
      stored.set(mandate, serializeSeenIds(mandate, ids));
    },
  });
  assert.equal(shown.length, 0);
  const rememberedB = parseSeenIds(MANDATE_B, stored.get(MANDATE_B) ?? null);
  assert.ok(rememberedB);
  assert.equal(rememberedB.has(encodeDecisionId(MANDATE_B, already)), true);
});

test('a rule that was empty on its first read announces a decision that arrives later', async () => {
  const stored = new Map<string, string>();
  const shown: DecisionNotice[] = [];
  await deliverDecisionNotices({
    ledgers: [ledger(MANDATE_A, [])],
    seenByMandate: new Map(),
    present: async (notice) => {
      shown.push(notice);
    },
    saveSeen: async (mandate, ids) => {
      stored.set(mandate, serializeSeenIds(mandate, ids));
    },
  });
  assert.equal(shown.length, 0);
  assert.equal(stored.has(MANDATE_A), true);
  const refused = refusalRow();
  const seeded = parseSeenIds(MANDATE_A, stored.get(MANDATE_A) ?? null);
  assert.ok(seeded);
  const later: DecisionNotice[] = [];
  await deliverDecisionNotices({
    ledgers: [ledger(MANDATE_A, [refused])],
    seenByMandate: new Map([[MANDATE_A, seeded]]),
    present: async (notice) => {
      later.push(notice);
    },
    saveSeen: async () => undefined,
  });
  assert.equal(later.length, 1);
  assert.equal(later[0]?.id, encodeDecisionId(MANDATE_A, refused));
  assert.equal(later[0]?.body, refusalWhyLine(refusalArgs));
});
