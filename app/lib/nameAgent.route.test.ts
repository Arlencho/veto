import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { FIRST_RUN_ROUTES } from './onboarding';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = '11111111111111111111111111111111';
const request = `veto://rule-request?v=1&agent=${agent}&payee=${agent}&mint=${agent}&cap=100&max=10&days=7&purpose=Test`;
const destinations: string[] = [];
let existingAgent: string | null = null;
mock.module('expo-router', { namedExports: {
  useRouter: () => ({ push: (path: string) => destinations.push(path), back() {} }),
} });
mock.module('./useWallet', { namedExports: {
  useWallet: () => ({ cluster: 'devnet', agentPublicKey: existingAgent }),
} });
const savedBooks: Record<string, string>[] = [];
mock.module('./mwa', { namedExports: { secureStore: {} } });
mock.module('./addressBook', { namedExports: {
  loadAddressBook: async () => ({}),
  saveAddressBook: async (_store: unknown, book: Record<string, string>) => { savedBooks.push(book); },
  withSavedName: (book: Record<string, string>, address: string, name: string) => ({ ...book, [address]: name.trim() }),
} });
mock.module('../components/Screen', { namedExports: { Screen: 'Screen' } });
mock.module('react-native', { namedExports: {
  ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text',
  TextInput: 'TextInput', View: 'View', StyleSheet: { create: (value: unknown) => value },
} });

async function mount() {
  destinations.length = 0;
  savedBooks.length = 0;
  const { default: NameRoute } = await import('../app/first-run/name');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(NameRoute)); });
  return root;
}

function review(root: ReactTestRenderer) {
  return root.root.findByProps({ accessibilityLabel: 'Review the rule', accessibilityRole: 'button' });
}

async function paste(root: ReactTestRenderer, text: string) {
  await act(async () => {
    root.root.findByProps({ accessibilityLabel: "Paste your agent's address" }).props.onChangeText(text);
  });
}

for (const [label, input, destination] of [
  ['agent address', ` ${agent} `, `${FIRST_RUN_ROUTES.approve}?agent=${agent}`],
  ['rule request', request, `${FIRST_RUN_ROUTES.approve}?url=${encodeURIComponent(request)}`],
] as const) {
  test(`pasting a valid ${label} enables review and opens the approve step without an existing agent`, async () => {
    const root = await mount();
    try {
      assert.equal(review(root).props.disabled, true);
      await paste(root, input);
      assert.equal(review(root).props.disabled, false);
      assert.equal(review(root).props.accessibilityState.disabled, false);
      await act(async () => { review(root).props.onPress(); });
      assert.deepEqual(destinations, [destination]);
    } finally {
      await act(async () => root.unmount());
    }
  });
}

test('invalid pasted text shows an inline error and can be corrected to enable review', async () => {
  const root = await mount();
  try {
    await paste(root, 'not-an-address');
    const text = () => root.root.findAllByType('Text' as never)
      .map((node) => node.children.join('')).join('\n');
    assert.match(text(), /That is not an agent address or a rule request\./);
    assert.equal(review(root).props.disabled, true);
    assert.deepEqual(destinations, []);
    await paste(root, agent);
    assert.doesNotMatch(text(), /That is not an agent address or a rule request\./);
    assert.equal(review(root).props.disabled, false);
  } finally {
    await act(async () => root.unmount());
  }
});

test('an existing test agent can still be reviewed with an empty paste field', async () => {
  existingAgent = agent;
  const root = await mount();
  try {
    assert.equal(review(root).props.disabled, false);
    await act(async () => { review(root).props.onPress(); });
    assert.deepEqual(destinations, [`${FIRST_RUN_ROUTES.approve}?agent=${agent}`]);
  } finally {
    existingAgent = null;
    await act(async () => root.unmount());
  }
});

test('the phone test agent and its name reach the approve step, so opening does not create another key (#362)', async () => {
  existingAgent = agent;
  const root = await mount();
  try {
    await act(async () => {
      root.root.findByProps({ accessibilityLabel: 'Name your agent' }).props.onChangeText(' Phone test ');
    });
    await act(async () => { await review(root).props.onPress(); });
    assert.deepEqual(savedBooks, [{ [agent]: 'Phone test' }]);
    assert.deepEqual(destinations, [`${FIRST_RUN_ROUTES.approve}?agent=${agent}`]);
  } finally {
    existingAgent = null;
    await act(async () => root.unmount());
  }
});
