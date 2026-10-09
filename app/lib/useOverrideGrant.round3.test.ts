import assert from 'node:assert/strict';
import test from 'node:test';

import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { KIND_REFUSED, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE } from './constants';
import type { MandateAccount } from './mandate';
import type { OverrideAssessment } from './override';
import type { LedgerRow } from './ring';
import { useOverrideGrant, type OverrideGrantView } from './useOverrideGrant';

// Critic round 3. Drives the failed probe path past a single retry and checks
// that no failure is held as a result anywhere in the hook.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Args = Parameters<typeof useOverrideGrant>[0];
type Out = { view: OverrideGrantView | null };

function Harness(props: { args: Args; out: Out }) {
  props.out.view = useOverrideGrant(props.args);
  return null;
}

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

function row(): LedgerRow {
  return {
    ts: 1_000n,
    amount: 180n,
    counterparty: 'Merchant1111111111111111111111111111111111',
    nonce: 7n,
    suggestedOverride: 180n,
    kind: KIND_REFUSED,
    kindName: 'refused',
    reason: REASON_OVER_PER_TX_MAX,
    reasonText: 'over per-payment maximum',
    signature: null,
  };
}

const READY: OverrideAssessment = {
  status: 'ready',
  amount: 180n,
  nonce: 7n,
  commit: { title: 'Allow this payment once', amount: '180', nonce: '7', paragraphs: [] },
};

type Step = 'reject' | 'hang' | OverrideAssessment;

function probeStub(results: Step[]) {
  let calls = 0;
  return {
    calls: () => calls,
    fn: (): Promise<OverrideAssessment> => {
      const result = results[Math.min(calls, results.length - 1)] ?? READY;
      calls += 1;
      if (result === 'reject') {
        return Promise.reject(new Error('rpc down'));
      }
      if (result === 'hang') {
        return new Promise(() => undefined);
      }
      return Promise.resolve(result);
    },
  };
}

function args(probe: Args['probeOverride'], over: Partial<Args> = {}): Args {
  return {
    row: row(),
    mandate: mandate(),
    nowSec: 1_500n,
    probeOverride: probe,
    grantOverride: async () => {
      throw new Error('not used here');
    },
    ...over,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(first: Args, out: Out): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(createElement(Harness, { args: first, out }));
    await flush();
  });
  assert.ok(root);
  return root;
}

async function pull(root: ReactTestRenderer, next: Args, out: Out): Promise<void> {
  await act(async () => {
    root.update(createElement(Harness, { args: next, out }));
    await flush();
  });
}

// A refresh that read the same chain state back: new objects, same fields.
function sameState(previous: Args): Args {
  return { ...previous, row: { ...previous.row } as LedgerRow, mandate: { ...previous.mandate } as MandateAccount };
}

function why(out: Out): string {
  return out.view?.assessment && 'why' in out.view.assessment ? out.view.assessment.why : '';
}

function assessmentStatus(out: Out): NonNullable<NonNullable<Out['view']>['assessment']>['status'] | undefined {
  return out.view?.assessment?.status;
}

test('CRITIC R3: two failed probes in a row each cost a read, and the third pull recovers', async () => {
  const probe = probeStub(['reject', 'reject', READY]);
  const out: Out = { view: null };
  const first = args(probe.fn);
  const root = await mount(first, out);
  assert.equal(out.view?.assessment?.status, 'blocked');
  assert.equal(probe.calls(), 1);

  await pull(root, sameState(first), out);
  assert.equal(probe.calls(), 2, 'second pull must read again');
  assert.equal(out.view?.assessment?.status, 'blocked', 'a second failure is still blocked');
  assert.match(why(out), /Pull to retry/, 'a second failure still tells the owner to pull');

  await pull(root, sameState(first), out);
  assert.equal(probe.calls(), 3, 'third pull must read again');
  assert.equal(out.view?.assessment?.status, 'ready');
});

test('CRITIC R3: a recovered probe is cached again, so the next same-state pull costs no read', async () => {
  const probe = probeStub(['reject', READY]);
  const out: Out = { view: null };
  const first = args(probe.fn);
  const root = await mount(first, out);
  await pull(root, sameState(first), out);
  assert.equal(probe.calls(), 2);
  assert.equal(out.view?.assessment?.status, 'ready');

  await pull(root, sameState(first), out);
  assert.equal(probe.calls(), 2, 'after recovery the success cache must hold again');
  assert.equal(out.view?.assessment?.status, 'ready');
});

test('CRITIC R3: a failure after the chain moved does not fall back to the stale success', async () => {
  const probe = probeStub([READY, 'reject', READY]);
  const out: Out = { view: null };
  const first = args(probe.fn);
  const root = await mount(first, out);
  assert.equal(assessmentStatus(out), 'ready');

  const moved: Args = { ...first, mandate: mandate({ lastNonce: 7n }) };
  await pull(root, moved, out);
  assert.equal(probe.calls(), 2);
  assert.equal(assessmentStatus(out), 'blocked', 'the old ready must not survive a failed re-read');
  assert.match(why(out), /Pull to retry/);

  await pull(root, sameState(moved), out);
  assert.equal(probe.calls(), 3, 'the pull after that failure must read again');
  assert.equal(assessmentStatus(out), 'ready');
});

test('CRITIC R3: while the retry after a failure is in flight the screen never offers', async () => {
  const probe = probeStub(['reject', 'hang']);
  const out: Out = { view: null };
  const first = args(probe.fn);
  const root = await mount(first, out);
  assert.equal(assessmentStatus(out), 'blocked');

  await pull(root, sameState(first), out);
  assert.equal(probe.calls(), 2);
  assert.notEqual(assessmentStatus(out), 'ready', 'no offer while the read is pending');
  assert.ok(
    assessmentStatus(out) === 'blocked' || assessmentStatus(out) === 'checking',
    `in flight after a failure shows blocked or checking, got ${String(assessmentStatus(out))}`,
  );

  const moved: Args = { ...first, mandate: mandate({ lastNonce: 7n }) };
  await pull(root, moved, out);
  assert.equal(probe.calls(), 3);
  assert.notEqual(out.view?.assessment?.status, 'ready', 'no offer while the moved-chain read is pending');
  // Document what the in-flight label is after a failure on a moved chain.
  console.log(`in-flight after failure, chain moved: status=${String(out.view?.assessment?.status)}`);
});

test('CRITIC R3: a grant failure is not a probe result and does not block a same-state re-probe decision', async () => {
  const probe = probeStub([READY]);
  const out: Out = { view: null };
  const first = args(probe.fn, {
    grantOverride: async () => {
      throw new Error('wallet rejected');
    },
  });
  const root = await mount(first, out);
  assert.equal(out.view?.assessment?.status, 'ready');

  await act(async () => {
    out.view?.onOffer();
  });
  assert.equal(out.view?.confirming, true);
  await act(async () => {
    out.view?.onSign();
    await flush();
  });
  assert.equal(out.view?.error, 'wallet rejected');
  assert.equal(out.view?.assessment?.status, 'ready', 'a sign failure does not change the probe assessment');

  await pull(root, sameState(first), out);
  assert.equal(probe.calls(), 1, 'a sign failure does not force or block a chain re-read');
  assert.equal(out.view?.error, 'wallet rejected', 'the sign error is held until the owner acts on the sheet');
  await act(async () => {
    out.view?.onCancel();
  });
  assert.equal(out.view?.error, null);
});
