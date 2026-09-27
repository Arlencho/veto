import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement } from 'react';
import { create } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('expo-router', {
  namedExports: {
    useFocusEffect(effect: () => void | (() => void)) {
      effect();
    },
  },
});

test('a screen focus asks to join a chain read already in flight', async () => {
  const { useRefreshOnFocus } = await import('./useRefreshOnFocus');
  const calls: unknown[] = [];
  function Screen() {
    useRefreshOnFocus(async (options) => {
      calls.push(options);
    });
    return null;
  }
  let root: ReturnType<typeof create> | null = null;
  await act(async () => {
    root = create(createElement(Screen));
  });
  assert.deepEqual(calls, [{ join: true }]);
  act(() => root?.unmount());
});
