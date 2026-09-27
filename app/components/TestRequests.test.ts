import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Keypair } from '@solana/web3.js';
import type { MandateAccount } from '../lib/mandate';
import { testRequestsVisible } from '../lib/testRequests';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const key = Keypair.generate().publicKey.toBase58();
const mandate = { address: key, agent: key, merchant: key, mint: key, status: 0, expiresAt: 9_000_000_000n } as MandateAccount;
let confirmation = '';
let actions: { text: string; onPress: () => void }[] = [];
let refreshes = 0;
let sends = 0;
let prepared = 0;
let prepareError: Error | null = null;
let cluster = 'devnet';
mock.module('react-native', { namedExports: {
  View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (styles: unknown) => styles },
  Linking: { openURL: async () => {} },
  Alert: { alert: (_title: string, text: string, buttons: typeof actions) => { confirmation = text; actions = buttons; } },
} });
mock.module('../lib/useWallet', { namedExports: { useWallet: () => ({ agentPublicKey: key, ownerPublicKey: key, cluster, getAgentPublicKey: async () => null, signWithAgent: async () => null, signAndSend: async () => [] }) } });
mock.module('../lib/useChain', { namedExports: { useChain: () => ({ config: { rpcUrl: 'https://api.devnet.solana.com', programId: key, explorerCluster: cluster }, tradeRules: [], refresh: async () => { refreshes++; } }) } });
mock.module('../lib/testRequests', { namedExports: {
  testRequestsVisible,
  testRequestFailure: (error: Error) => error.message,
  prepareTestRequests: async () => { prepared++; if (prepareError) throw prepareError; return { rule: mandate, paid: 10n, refused: 21n }; },
  runTestRequests: async (options: { report: (row: { text: string; signature?: string }) => void }) => {
    sends++;
    options.report({ text: 'Paid 10 base units to the payee.', signature: 'payment' });
    options.report({ text: 'Refused 21 base units: over per-payment maximum.', signature: 'refusal' });
  },
} });

test('button confirms exact payments and fees, ignores a duplicate tap, then renders both outcomes and refreshes Decisions', async () => {
  const { TestRequests } = await import('./TestRequests');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(TestRequests, { mandate })); });
  const button = root.root.findByType('Pressable' as never);
  assert.match(JSON.stringify(root.toJSON()), /Send two test requests/);
  await act(async () => { button.props.onPress(); button.props.onPress(); });
  assert.equal(prepared, 1);
  assert.equal(sends, 0);
  assert.match(confirmation, /One payment of 10 base units within the per-payment limit goes to payee/);
  assert.match(confirmation, /One request of 21 base units above the per-payment limit will be refused/);
  assert.match(confirmation, /less than 0.005 SOL.*0.01 devnet SOL/);
  await act(async () => { actions.find(action => action.text === 'Send requests')!.onPress(); });
  assert.equal(sends, 1);
  assert.equal(refreshes, 1);
  assert.match(JSON.stringify(root.toJSON()), /Paid 10 base units/);
  assert.match(JSON.stringify(root.toJSON()), /Refused 21 base units/);
  assert.equal(root.root.findAll(node => node.type === ('Text' as never) && node.props.accessibilityRole === 'link').length, 2);
  await act(async () => root.unmount());
});
test('the component hides on a non-devnet build', async () => {
  cluster = 'mainnet-beta';
  const { TestRequests } = await import('./TestRequests');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(TestRequests, { mandate })); });
  assert.equal(root.toJSON(), null);
  await act(async () => root.unmount());
});


test('a waiting approval is explained inline without opening confirmation', async () => {
  cluster = 'devnet';
  confirmation = '';
  const beforeSends = sends;
  prepareError = new Error('This rule has a waiting one-time approval. The test would cancel it.');
  const { TestRequests } = await import('./TestRequests');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(TestRequests, { mandate })); });
  await act(async () => { root.root.findByType('Pressable' as never).props.onPress(); });
  assert.equal(confirmation, '');
  assert.equal(sends, beforeSends);
  assert.match(JSON.stringify(root.toJSON()), /waiting one-time approval.*test would cancel it/);
  await act(async () => root.unmount());
  prepareError = null;
});
