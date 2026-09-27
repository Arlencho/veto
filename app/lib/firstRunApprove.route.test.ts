import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = '11111111111111111111111111111111';
let params: Record<string, string | string[] | undefined> = {};
mock.module('expo-router', { namedExports: { useLocalSearchParams: () => params } });
mock.module('../components/ApprovalScreen', { namedExports: { ApprovalScreen: 'ApprovalScreen' } });

async function initialAgent(next: typeof params) {
  params = next;
  const { default: ApproveRoute } = await import('../app/first-run/approve');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(ApproveRoute)); });
  try {
    return root.root.findByType('ApprovalScreen' as never).props.initialAgent;
  } finally {
    await act(async () => root.unmount());
  }
}

test('the approve step opens the template for the agent chosen on the name step (#362)', async () => {
  assert.equal(await initialAgent({ agent }), agent);
});

test('the approve step ignores a missing or malformed agent', async () => {
  assert.equal(await initialAgent({}), undefined);
  assert.equal(await initialAgent({ agent: 'not-an-address' }), undefined);
});
