import assert from 'node:assert/strict';
import test from 'node:test';

import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { KIND_REFUSED, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE } from './constants';
import type { MandateAccount } from './mandate';
import type { OverrideAssessment } from './override';
import type { LedgerRow } from './ring';
import { useOverrideGrant, type OverrideGrantView } from './useOverrideGrant';

// Critic round 2. Renders the hook that F3 and F4 introduced and counts the
// chain reads it issues across a refresh that rebuilds the same accounts.

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

function probeStub(results: Array<'reject' | OverrideAssessment>) {
  let calls = 0;
  return {
    calls: () => calls,
    fn: async (): Promise<OverrideAssessment> => {
      const result = results[Math.min(calls, results.length - 1)] ?? READY;
      calls += 1;
      if (result === 'reject') {
        throw new Error('rpc down');
      }
      return result;
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

// A refresh that read the same chain state back: new objects, same fields.
function sameStateRefresh(previous: Args): Args {
  return { ...previous, row: { ...previous.row } as LedgerRow, mandate: { ...previous.mandate } as MandateAccount };
}

test('CRITIC F3: after a failed probe, a refresh that reads the same state back must re-probe, because the copy says "Pull to retry"', async () => {
  const probe = probeStub(['reject', READY]);
  const out: Out = { view: null };
  const first = args(probe.fn);
  const root = await mount(first, out);

  assert.equal(out.view?.assessment?.status, 'blocked');
  const why = out.view?.assessment && 'why' in out.view.assessment ? out.view.assessment.why : '';
  assert.match(why, /Pull to retry/);
  assert.equal(probe.calls(), 1);

  await act(async () => {
    root.update(createElement(Harness, { args: sameStateRefresh(first), out }));
    await flush();
  });
  assert.equal(probe.calls(), 2, 'the pull the owner was told to do must issue the read it promised');
  assert.equal(out.view?.assessment?.status, 'ready');
});

test('regression F3: after a successful probe, a refresh that reads the same state back does not re-probe', async () => {
  const probe = probeStub([READY]);
  const out: Out = { view: null };
  const first = args(probe.fn);
  const root = await mount(first, out);
  assert.equal(out.view?.assessment?.status, 'ready');
  assert.equal(probe.calls(), 1);

  await act(async () => {
    root.update(createElement(Harness, { args: sameStateRefresh(first), out }));
    await flush();
  });
  assert.equal(probe.calls(), 1, 'same row and mandate fields must not cost a second chain read');
  assert.equal(out.view?.assessment?.status, 'ready');
});

test('regression F3: a refresh that shows the chain moved on does re-probe', async () => {
  const probe = probeStub([READY]);
  const out: Out = { view: null };
  const first = args(probe.fn);
  const root = await mount(first, out);
  assert.equal(probe.calls(), 1);

  await act(async () => {
    root.update(
      createElement(Harness, { args: { ...first, mandate: mandate({ lastNonce: 7n }) }, out }),
    );
    await flush();
  });
  assert.equal(probe.calls(), 2, 'a moved last_nonce is a new question for the chain');
});
