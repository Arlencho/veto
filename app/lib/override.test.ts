import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KIND_OPENED,
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  KIND_REVOKED,
  REASON_ACCOUNT_FROZEN,
  REASON_DELEGATE_MISSING,
  REASON_EXPIRED,
  REASON_INSUFFICIENT_FUNDS,
  REASON_MERCHANT_NOT_ALLOWED,
  REASON_NOT_ACTIVE,
  REASON_OVER_CAP,
  REASON_OVER_PER_TX_MAX,
  REASON_STALE_NONCE,
  REASON_ZERO_AMOUNT,
  STATUS_ACTIVE,
  STATUS_EXHAUSTED,
  STATUS_EXPIRED,
  STATUS_REVOKED,
  ownerReasonText,
} from './constants';
import { decodeInstructionKind } from './events';
import { encodeGrantOverrideData } from './instructions';
import type { MandateAccount } from './mandate';
import {
  CAP_OVERRIDE_REFUSAL,
  assessOverride,
  nonceSequence,
  overrideCommitCopy,
  overrideGuard,
  overrideOfferForReason,
  overrideProbeIsCurrent,
  overrideProbeKey,
  overrideRowView,
  sequenceLine,
  type OverrideSource,
} from './override';

function mandate(over: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: 'Mandate1111111111111111111111111111111111111',
    owner: 'Owner111111111111111111111111111111111111111',
    agent: 'Agent111111111111111111111111111111111111111',
    mint: 'Mint1111111111111111111111111111111111111111',
    source: 'Source11111111111111111111111111111111111111',
    merchant: 'Merchant1111111111111111111111111111111111',
    mandateId: 1n,
    cap: 200n,
    spent: 20n,
    perTxMax: 60n,
    expiresAt: 2_000n,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 6n,
    purpose: 'SE3 home charging',
    status: STATUS_ACTIVE,
    spendCount: 3,
    refusalCount: 1,
    bump: 255,
    ...over,
  };
}

function row(over: Partial<OverrideSource> = {}): OverrideSource {
  return {
    kind: KIND_REFUSED,
    reason: REASON_OVER_PER_TX_MAX,
    nonce: 7n,
    amount: 180n,
    suggestedOverride: 180n,
    ...over,
  };
}

test('only a per-payment refusal with a suggested override offers a grant', () => {
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
  for (const reason of codes) {
    const withSuggestion = overrideOfferForReason(reason, 180n);
    const without = overrideOfferForReason(reason, 0n);
    if (reason === REASON_OVER_PER_TX_MAX) {
      assert.equal(withSuggestion.offer, true);
      if (withSuggestion.offer) {
        assert.equal(withSuggestion.amount, 180n);
      }
      assert.equal(without.offer, false);
      if (!without.offer) {
        assert.equal(without.why, CAP_OVERRIDE_REFUSAL);
      }
    } else {
      assert.equal(withSuggestion.offer, false, `reason ${reason} must not offer`);
      assert.equal(without.offer, false, `reason ${reason} must not offer`);
      if (!withSuggestion.offer) {
        if (reason === REASON_OVER_CAP) {
          assert.equal(withSuggestion.why, CAP_OVERRIDE_REFUSAL);
        } else {
          assert.equal(
            withSuggestion.why,
            `The program records no one-time allowance for this reason (${ownerReasonText(reason)}).`,
          );
        }
      }
    }
  }
});

test('an exhausted total cap does not offer an override and says the program will not raise the cap', () => {
  const overCap = overrideOfferForReason(REASON_OVER_CAP, 180n);
  assert.equal(overCap.offer, false);
  if (!overCap.offer) {
    assert.equal(overCap.why, CAP_OVERRIDE_REFUSAL);
    assert.ok(overCap.why.includes('cannot raise the total cap'));
    assert.ok(overCap.why.includes('program will not accept one'));
  }
  const overPerAndCap = overrideOfferForReason(REASON_OVER_PER_TX_MAX, 0n);
  assert.equal(overPerAndCap.offer, false);
  if (!overPerAndCap.offer) {
    assert.equal(overPerAndCap.why, CAP_OVERRIDE_REFUSAL);
  }
});

test('a revoked rule does not offer an override', () => {
  const guard = overrideGuard(mandate({ status: STATUS_REVOKED }), 7n, 180n);
  assert.equal(guard.ok, false);
  if (!guard.ok) {
    assert.equal(guard.why, 'This rule is revoked on chain. A one-time allowance cannot be granted.');
  }
  const assessment = assessOverride({
    row: row(),
    mandate: mandate({ status: STATUS_REVOKED }),
    decimals: 0,
  });
  assert.equal(assessment.status, 'blocked');
  if (assessment.status === 'blocked') {
    assert.equal(assessment.why, 'This rule is revoked on chain. A one-time allowance cannot be granted.');
  }
});

test('a settled nonce does not offer an override', () => {
  const atLast = overrideGuard(mandate({ lastNonce: 7n }), 7n, 180n);
  assert.equal(atLast.ok, false);
  if (!atLast.ok) {
    assert.equal(atLast.why, 'This request is already settled on chain. A one-time allowance cannot be granted.');
  }
  const beforeLast = overrideGuard(mandate({ lastNonce: 8n }), 7n, 180n);
  assert.equal(beforeLast.ok, false);
  const live = overrideGuard(mandate({ lastNonce: 6n }), 7n, 180n);
  assert.equal(live.ok, true);
});

test('an exhausted or expired status is blocked before a grant is offered', () => {
  const exhausted = overrideGuard(mandate({ status: STATUS_EXHAUSTED }), 7n, 180n);
  assert.equal(exhausted.ok, false);
  if (!exhausted.ok) {
    assert.ok(exhausted.why.includes(CAP_OVERRIDE_REFUSAL));
  }
  const expired = overrideGuard(mandate({ status: STATUS_EXPIRED }), 7n, 180n);
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(
      expired.why,
      'This rule is expired on chain. A one-time allowance cannot be granted.',
    );
  }
});

test('a remaining cap below the suggested amount is blocked because the program will not raise the cap', () => {
  const guard = overrideGuard(mandate({ cap: 100n, spent: 50n }), 7n, 180n);
  assert.equal(guard.ok, false);
  if (!guard.ok) {
    assert.ok(guard.why.includes(CAP_OVERRIDE_REFUSAL));
  }
});

test('an override row reads as a recorded waiver, not a settings change', () => {
  const view = overrideRowView(
    {
      kind: KIND_OVERRIDE,
      reason: 0,
      nonce: 7n,
      amount: 180n,
      suggestedOverride: 180n,
    },
    0,
  );
  assert.equal(view.say, 'Waived');
  assert.equal(view.italic, 'by the owner');
  assert.equal(view.amount, '180');
  assert.ok(view.why.includes('recorded decision'));
  assert.ok(view.why.includes('not a settings change'));
  assert.ok(view.why.startsWith('You allowed this one payment of 180.'));
  assert.doesNotMatch(view.why, /nonce/i);
  assert.equal(view.why.includes('setting'), true);
  assert.equal(/settings change/.test(view.why), true);
});

test('the record of one nonce reads asked, refused, waived, then paid', () => {
  const rows: OverrideSource[] = [
    row({ kind: KIND_REFUSED, nonce: 7n, amount: 180n, suggestedOverride: 180n }),
    {
      kind: KIND_OVERRIDE,
      reason: 0,
      nonce: 7n,
      amount: 180n,
      suggestedOverride: 180n,
    },
    {
      kind: KIND_PAID,
      reason: 0,
      nonce: 7n,
      amount: 180n,
      suggestedOverride: 0n,
    },
  ];
  const seq = nonceSequence(rows, 7n);
  assert.equal(seq.asked, 180n);
  assert.equal(seq.refused, true);
  assert.equal(seq.waived, true);
  assert.equal(seq.paid, true);
  assert.equal(
    sequenceLine(seq, 0),
    'Asked for 180. Refused (over per-payment maximum). Waived by the owner. Then paid.',
  );
});

test('a waived nonce that has not paid yet tells the owner the agent can retry', () => {
  const seq = nonceSequence(
    [
      row(),
      {
        kind: KIND_OVERRIDE,
        reason: 0,
        nonce: 7n,
        amount: 180n,
        suggestedOverride: 180n,
      },
    ],
    7n,
  );
  assert.equal(
    sequenceLine(seq, 0),
    'Asked for 180. Refused (over per-payment maximum). Waived by the owner. The agent can retry this request.',
  );
});

test('a lone refusal does not invent a sequence line', () => {
  assert.equal(sequenceLine(nonceSequence([row()], 7n), 0), null);
});

test('opened and revoked rows are not part of the nonce sequence', () => {
  const seq = nonceSequence(
    [
      { kind: KIND_OPENED, reason: 0, nonce: 0n, amount: 0n, suggestedOverride: 0n },
      { kind: KIND_REVOKED, reason: 0, nonce: 0n, amount: 0n, suggestedOverride: 0n },
      row(),
    ],
    7n,
  );
  assert.equal(seq.refused, true);
  assert.equal(seq.waived, false);
  assert.equal(seq.paid, false);
});

test('assessOverride is ready only when the reason offers and the live guards pass', () => {
  const ready = assessOverride({ row: row(), mandate: mandate(), decimals: 0 });
  assert.equal(ready.status, 'ready');
  if (ready.status === 'ready') {
    assert.equal(ready.amount, 180n);
    assert.equal(ready.nonce, 7n);
    assert.equal(ready.commit.title, 'Allow this payment once');
    assert.ok(ready.commit.paragraphs[0]?.includes('180'));
    assert.ok(ready.commit.paragraphs.some((p) => p.includes('not a settings change')));
  }

  const paid = assessOverride({
    row: row({ kind: KIND_PAID, reason: 0, suggestedOverride: 0n }),
    mandate: mandate(),
    decimals: 0,
  });
  assert.equal(paid.status, 'none');

  const already = assessOverride({
    row: row(),
    mandate: mandate({ overrideNonce: 7n, overrideAmount: 180n }),
    decimals: 0,
  });
  assert.equal(already.status, 'already');
  if (already.status === 'already') {
    assert.ok(already.why.includes('already has a one-time allowance of 180'));
  }
});

test('the commit copy names the amount, the nonce, and that the cap cannot rise', () => {
  const copy = overrideCommitCopy({
    amount: 180n,
    nonce: 7n,
    perTxMax: 60n,
    remaining: 180n,
    cap: 200n,
    decimals: 0,
    pendingOtherNonce: 9n,
  });
  const text = copy.paragraphs.join(' ');
  assert.ok(text.includes('allow this payment once, for 180'));
  assert.ok(text.includes('per-payment maximum on this rule is 60'));
  assert.ok(text.includes('covers this one payment of 180, used once, never above the remaining cap'));
  assert.equal(text.includes('raises it to'), false);
  assert.ok(text.includes('180 remaining of 200'));
  assert.ok(text.includes(CAP_OVERRIDE_REFUSAL));
  assert.ok(text.includes('recorded decision'));
  assert.ok(text.includes('not a settings change'));
  assert.ok(text.includes('replaces the pending one-time allowance for request 9'));
  assert.ok(text.includes('agent can then retry this request'));
  assert.doesNotMatch(text, /nonce/i);
});

test('grant_override instruction data is amount then nonce after the discriminator', () => {
  const data = encodeGrantOverrideData(180n, 7n);
  const decoded = decodeInstructionKind('sig', data);
  assert.ok(decoded);
  assert.equal(decoded?.kind, KIND_OVERRIDE);
  assert.equal(decoded?.amount, 180n);
  assert.equal(decoded?.nonce, 7n);
  assert.equal(decoded?.reason, 0);
});

// Critic round 1. Both tests go red on bfc78d3.

test('CRITIC: an already-granted override on a rule that is not active must not claim the agent can retry', () => {
  // programs/veto/src/lib.rs `charge` sets STATUS_EXPIRED without clearing
  // override_nonce, and a paid charge on another nonce can flip the rule to
  // STATUS_EXHAUSTED with an override still pending. `evaluate` then refuses
  // the retry with REASON_NOT_ACTIVE before it ever reads the override.
  for (const status of [STATUS_EXPIRED, STATUS_EXHAUSTED]) {
    const assessment = assessOverride({
      row: row(),
      mandate: mandate({ status, overrideNonce: 7n, overrideAmount: 180n }),
      decimals: 0,
    });
    assert.equal(assessment.status, 'blocked', `status ${status} must be blocked, got ${assessment.status}`);
    assert.equal(assessment.why.includes('can retry'), false, 'must not promise a retry that evaluate() will refuse');
  }
});

test('CRITIC: a rule past its expiry by the clock is not offered an override, because the retry cannot clear', () => {
  // programs/veto/src/lib.rs `evaluate` refuses with REASON_EXPIRED when
  // now >= expires_at, regardless of status. grant_override does not check
  // the clock, so the program would accept a waiver the agent can never use.
  // The guard needs the clock the way lib/mandate.ts `isActive` already does.
  const past = overrideGuard(mandate({ status: STATUS_ACTIVE, expiresAt: 1_000n }), 7n, 180n, 1_500n);
  assert.equal(past.ok, false, 'expired by the clock must be blocked');
  if (!past.ok) {
    assert.equal(
      past.why,
      'This rule has passed its expiry. This app will not offer a one-time allowance because it cannot make an expired payment valid.',
    );
  }
  const future = overrideGuard(mandate({ status: STATUS_ACTIVE, expiresAt: 2_000n }), 7n, 180n, 1_500n);
  assert.equal(future.ok, true);
});

test('an override probe key is unchanged for the same row and mandate under new object identities', () => {
  const source = { ...row(), ts: 99n };
  const live = mandate();
  const first = overrideProbeKey(source, live, 1_000n);
  const second = overrideProbeKey({ ...source }, { ...live }, 1_000n);
  assert.equal(first, second);
  assert.equal(overrideProbeIsCurrent(first, second), true);
});

test('an override probe key changes when the rule expires by the clock, so a later refresh can block', () => {
  const source = { ...row(), ts: 99n };
  const live = mandate({ expiresAt: 1_000n });
  const before = overrideProbeKey(source, live, 999n);
  const after = overrideProbeKey(source, live, 1_000n);
  assert.equal(overrideProbeIsCurrent(before, after), false);
});

test('owner-facing allow-once copy says allow once, never override, and keeps the other limits', () => {
  const copy = overrideCommitCopy({
    amount: 180n,
    nonce: 7n,
    perTxMax: 60n,
    remaining: 180n,
    cap: 200n,
    decimals: 0,
    pendingOtherNonce: 9n,
  });
  assert.equal(copy.title, 'Allow this payment once');
  const text = copy.paragraphs.join(' ');
  assert.ok(text.includes('The payee and expiry rules still apply.'));
  assert.ok(text.includes('cannot raise the total cap'));
  const whys: string[] = [CAP_OVERRIDE_REFUSAL, copy.title, text];
  for (const guard of [overrideGuard(mandate(), 0n, 180n), overrideGuard(mandate(), 7n, 0n)]) {
    assert.equal(guard.ok, false);
    if (!guard.ok) whys.push(guard.why);
  }
  const notOffered = overrideOfferForReason(REASON_STALE_NONCE, 180n);
  assert.equal(notOffered.offer, false);
  if (!notOffered.offer) whys.push(notOffered.why);
  for (const why of whys) {
    assert.doesNotMatch(why, /override/i, why);
    assert.doesNotMatch(why, /nonce/i, why);
  }
});
