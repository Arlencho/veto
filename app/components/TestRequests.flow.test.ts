import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { world } from '../../sdk/src/testkit';
import { decodeMandateAccount, type MandateAccount } from '../lib/mandate';
import { agentKeyForOpen } from '../lib/agentAddress';
import type { WalletState } from '../lib/useWallet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const owner = Keypair.generate().publicKey;
const memory = new Map<string, string>();
const extra = { vetoRpc: 'https://api.devnet.solana.com', vetoExplorerCluster: 'devnet', vetoProgramId: PublicKey.default.toBase58() };
mock.module('expo-constants', { defaultExport: { expoConfig: { extra } } });
mock.module('../lib/installedPackage', { namedExports: {
  isSolanaMobileWalletInstalled: async () => false,
  SOLANA_MOBILE_WALLET_BASE_URI: 'https://connect.solanamobile.com',
} });
mock.module('../lib/mwa', { namedExports: {
  secureStore: {
    getItem: async (key: string) => memory.get(key) ?? null,
    setItem: async (key: string, value: string) => { memory.set(key, value); },
    deleteItem: async (key: string) => { memory.delete(key); },
  },
  transact: async (callback: (wallet: unknown) => Promise<unknown>) => callback({
    authorize: async (params: { chain: string }) => {
      assert.equal(params.chain, 'solana:devnet');
      return { accounts: [{ address: Buffer.from(owner.toBytes()).toString('base64') }], auth_token: 'test' };
    },
  }),
} });
mock.module('react-native', { namedExports: {
  View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (styles: unknown) => styles },
  Linking: { openURL: async () => {} }, Alert: { alert: () => {} },
} });
// The chain boundary supplies configuration only; the mandate below comes from
// serialized account bytes and the real decoder. No wallet state is mocked.
mock.module('../lib/useChain', { namedExports: { useChain: () => ({
  config: { rpcUrl: extra.vetoRpc, explorerCluster: extra.vetoExplorerCluster, programId: extra.vetoProgramId }, tradeRules: [],
}) } });

test('decoded phone-agent rules show test requests after MWA connect, agent creation, blank-agent selection, and restore', async () => {
  const { WalletProvider, useWallet } = await import('../lib/useWallet');
  const { TestRequests } = await import('./TestRequests');
  let wallet!: WalletState;
  let mandate: MandateAccount | null = null;
  function Screen() {
    wallet = useWallet();
    return createElement(TestRequests, { mandate });
  }
  let root!: ReactTestRenderer;
  const tree = () => createElement(WalletProvider, null, createElement(Screen));
  const showRule = async (agent: PublicKey) => {
    const w = world({ agent, owner, cap: 1_000_000n, perTxMax: 100_000n, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400) });
    mandate = decodeMandateAccount(w.mandate.toBase58(), w.fake.accounts.get(w.mandate.toBase58())!.data);
    await act(async () => root.update(tree()));
    assert.equal(wallet.agentPublicKey, mandate.agent);
    assert.equal(wallet.cluster, 'devnet');
    assert.equal((await wallet.getAgentPublicKey())?.toBase58(), mandate.agent);
    assert.match(JSON.stringify(root.toJSON()), /Send two test requests/);
  };
  try {
    await act(async () => { root = create(tree()); });
    assert.equal(wallet.ready, true);
    assert.equal(wallet.error, null);
    await act(async () => { await wallet.connect(); });
    assert.equal(wallet.ownerPublicKey, owner.toBase58());
    let created!: PublicKey;
    await act(async () => { created = (await wallet.createAgentKeypair()).publicKey; });
    await showRule(created);
    // ChainProvider.open uses this helper when approval leaves the agent blank.
    await act(async () => { created = await agentKeyForOpen(undefined, wallet.createAgentKeypair); });
    await showRule(created);
    await act(async () => root.unmount());
    await act(async () => { root = create(tree()); });
    await showRule(created);
  } finally {
    await act(async () => root?.unmount());
  }
});
