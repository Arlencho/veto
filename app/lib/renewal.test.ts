import assert from 'node:assert/strict';
import test from 'node:test';

import { Keypair } from '@solana/web3.js';

import { KIND_OPENED, KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, STATUS_ACTIVE, STATUS_REVOKED } from './constants';
import type { MandateAccount } from './mandate';
import { VTEST_MINT } from './tokens';
import {
  LET_END_KEY,
  LET_END_NOTE,
  baselineDraft,
  becauseLine,
  buildRenewalView,
  endsInPhrase,
  highestAskedText,
  inRenewalWindow,
  parseLetEnd,
  rememberLetEnd,
  renewalBanner,
  renewalDraftError,
  renewalSearchParams,
  ruleLengthDays,
  type NextRuleDraft,
  type RenewalRow,
} from './renewal';
import type { WalletStore } from './wallet';

const DAY = 86400n;
const EXPIRES = 1_800_000_000n;
const NOW = EXPIRES - 7n * DAY;
const MERCHANT = Keypair.generate().publicKey.toBase58();
const AGENT = Keypair.generate().publicKey.toBase58();

function mandate(partial: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: 'RuleAddress11111111111111111111111111111111',
    owner: 'owner',
    agent: AGENT,
    mint: VTEST_MINT,
    source: 'source',
    merchant: MERCHANT,
    mandateId: 1n,
    cap: 80n,
    spent: 17n,
    perTxMax: 6n,
    expiresAt: EXPIRES,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 3n,
    purpose: 'depot top ups',
    status: STATUS_ACTIVE,
    spendCount: 4,
    refusalCount: 2,
    bump: 1,
    ...partial,
  };
}

function rows(): RenewalRow[] {
  return [
    { ts: EXPIRES - 90n * DAY, kind: KIND_OPENED, amount: 80n },
    { ts: EXPIRES - 40n * DAY, kind: KIND_PAID, amount: 6n },
    { ts: EXPIRES - 20n * DAY, kind: KIND_PAID, amount: 4n },
    { ts: EXPIRES - 10n * DAY, kind: KIND_REFUSED, amount: 19n },
    { ts: EXPIRES - 9n * DAY, kind: KIND_REFUSED, amount: 6n },
    { ts: EXPIRES - 8n * DAY, kind: KIND_OVERRIDE, amount: 19n },
  ];
}

function memoryStore(): WalletStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    deleteItem: async (key) => {
      map.delete(key);
    },
  };
}

test('the renewal window opens at seven days and stays until the rule ends', () => {
  const rule = mandate();
  assert.equal(inRenewalWindow(rule, EXPIRES - 7n * DAY), true);
  assert.equal(inRenewalWindow(rule, EXPIRES - 7n * DAY - 1n), false);
  assert.equal(inRenewalWindow(rule, EXPIRES - 1n), true);
  assert.equal(inRenewalWindow(rule, EXPIRES), false);
  assert.equal(inRenewalWindow(mandate({ status: STATUS_REVOKED }), NOW), false);
  assert.equal(endsInPhrase(EXPIRES, NOW), '7 days');
  assert.equal(endsInPhrase(EXPIRES, EXPIRES - DAY), '1 day');
});

test('the next rule keeps the length of this rule, and a tie on the highest ask prefers the refusal', () => {
  const opened = EXPIRES - 90n * DAY;
  assert.equal(ruleLengthDays(opened, EXPIRES), 90);
  assert.equal(ruleLengthDays(null, EXPIRES), null);
  assert.equal(highestAskedText(rows(), 0), '19, refused');
  const tied: RenewalRow[] = [
    { ts: 1n, kind: KIND_PAID, amount: 6n },
    { ts: 2n, kind: KIND_REFUSED, amount: 6n },
  ];
  assert.equal(highestAskedText(tied, 0), '6, refused');
});

test('the banner and the prefilled rule use the chain amounts, not the sample card', () => {
  const rule = mandate();
  const banner = renewalBanner(rule, 0, NOW);
  assert.ok(banner);
  assert.equal(banner.title, 'Your rule ends in 7 days.');
  assert.match(banner.body, /63 VTEST left goes back to your wallet/);
  assert.equal(renewalBanner(rule, 0, EXPIRES - 8n * DAY), null);

  const view = buildRenewalView({
    mandate: rule,
    rows: rows(),
    decimals: 0,
    nowSec: NOW,
    agentName: 'Depot agent',
    ledgerTotal: rows().length,
  });
  assert.ok(view);
  assert.equal(view.paidCount, 4);
  assert.equal(view.refusedCount, 2);
  assert.equal(view.spentText, '17 VTEST');
  assert.equal(view.capText, '80 VTEST');
  assert.equal(view.leftText, '63 VTEST');
  assert.equal(view.highestAskedText, '19 VTEST, refused');
  assert.equal(view.highestPaidText, '6 VTEST, the limit');
  assert.equal(view.allowedText, '1 time');
  assert.equal(view.baseline.expiryDays, '90');
  assert.equal(view.baseline.purpose, 'depot top ups');
  assert.match(view.headline, /7 days/);
  assert.match(
    becauseLine({
      baseline: view.baseline,
      draft: view.baseline,
      highestPaidText: view.highestPaidText,
      leftText: view.leftText,
      leftUnused: view.leftUnused,
      paidAtLimit: view.paidAtLimit,
    }),
    /the highest payment was 6 VTEST and 63 VTEST was never needed/,
  );
  assert.doesNotMatch(view.ifNothing, /39/);
  assert.equal(view.recordNote, null);
});

test('a changed draft says the owner changed it, and a bad payee cannot be signed', () => {
  const view = buildRenewalView({
    mandate: mandate(),
    rows: rows(),
    decimals: 0,
    nowSec: NOW,
    agentName: 'Depot agent',
    ledgerTotal: rows().length,
  });
  assert.ok(view);
  const changed: NextRuleDraft = { ...view.baseline, perTxMax: '12' };
  assert.match(
    becauseLine({
      baseline: view.baseline,
      draft: changed,
      highestPaidText: view.highestPaidText,
      leftText: view.leftText,
      leftUnused: true,
      paidAtLimit: true,
    }),
    /You changed the next rule/,
  );
  assert.equal(renewalDraftError({ ...view.baseline, merchant: 'not-a-wallet' }, 0), 'The payee has to be the wallet this rule may pay.');
  assert.equal(renewalDraftError({ ...view.baseline, expiryDays: '' }, 0), 'Enter how many days the next rule runs.');
  assert.equal(renewalDraftError(view.baseline, 0), null);
  const params = renewalSearchParams(view.address, view.baseline);
  assert.equal(params.renew, '1');
  assert.equal(params.days, '90');
  assert.equal(params.per, '6');
  assert.equal(params.cap, '80');
  assert.equal(params.payee, MERCHANT);
  assert.equal('agent' in params, false);
});

test('letting the rule end remembers the choice and signs nothing', async () => {
  const store = memoryStore();
  await rememberLetEnd(store, 'rule-a');
  await rememberLetEnd(store, 'rule-a');
  await rememberLetEnd(store, 'rule-b');
  assert.deepEqual(parseLetEnd(store.map.get(LET_END_KEY) ?? null), ['rule-a', 'rule-b']);
  assert.equal(store.map.size, 1);
  assert.equal(LET_END_NOTE, 'Nothing was signed. This choice costs nothing.');
  assert.deepEqual(parseLetEnd('not-json'), []);
  assert.equal(baselineDraft(mandate({ purpose: '  depot top ups  ' }), rows(), 0).purpose, 'depot top ups');
});

test('a wrapped ledger does not pretend the highest amount is the whole history', () => {
  const view = buildRenewalView({
    mandate: mandate(),
    rows: rows(),
    decimals: 0,
    nowSec: NOW,
    agentName: 'Depot agent',
    ledgerTotal: rows().length + 4,
  });
  assert.ok(view);
  assert.match(view.recordNote ?? '', /decisions still stored/);
  assert.equal(view.paidCount, 4);
});
