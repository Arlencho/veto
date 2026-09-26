import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DEVNET_USDC_MINT } from './tokens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const key = Keypair.generate().publicKey;
const account = {
  address: key, owner: key, mint: new PublicKey(DEVNET_USDC_MINT), vaultToken: key,
  guardian: key, safeAddress: key, vaultId: 1n, dailyLimit: 1_000_000n,
  dailyBuckets: [], windowStart: 0n, windowSpent: 0n, delaySecs: 86400n,
  unfreezeAt: 0n, nextWithdrawalId: 2n, bigShareBps: 1000, known: [], frozen: false,
  pending: [{ id: 1n, amount: 2_000_000n, destination: key, unlockAt: 1800000000n, status: 1 }],
  change: {
    active: false, fields: 0, bigShareBps: 0, dailyLimit: 0n, delaySecs: 0n,
    guardian: PublicKey.default, safeAddress: PublicKey.default, effectiveAt: 0n,
  },
  bump: 0, tokenBump: 0, ledgerBump: 0,
};
const session = {
  client: {}, config: { mint: DEVNET_USDC_MINT }, owner: key, chain: { configError: null },
  wallet: { ready: true, busy: false }, network: 'Devnet', tokenName: 'USDC',
};
mock.module('expo-router', { namedExports: {
  useRouter: () => ({ back() {}, push() {} }), useLocalSearchParams: () => ({ vault: key.toBase58() }),
} });
mock.module('react-native', { namedExports: {
  Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (value: unknown) => value },
} });
for (const name of ['Screen', 'ConnectGate']) {
  mock.module(`../components/${name}`, { namedExports: { [name]: name } });
}
mock.module('../components/hold/PromiseScreen', { namedExports: { PromiseScreen: 'PromiseScreen' } });
mock.module('../components/backglass/Lamp', { namedExports: { Lamp: 'Lamp' } });
mock.module('../components/hold/chrome', { namedExports: {
  HoldTop: 'HoldTop', ReelValue: 'ReelValue',
  StatusBlock: ({ children }: { children: ReactNode }) => children,
  HoldSign: ({ hint }: { hint: string }) => createElement('Text', null, hint),
} });
mock.module('./holdSession', { namedExports: {
  useHoldSession: () => session,
  useHoldBundle: () => ({ ...session, bundle: { account, decimals: 6, balance: 10_000_000n, ledger: { entries: [] } }, nowSec: 1700000000n, status: 'ready', reload() {} }),
} });
mock.module('./holdChain', { namedExports: {
  holdClient: () => ({}), listHoldVaults: async () => [account], readTokenAmount: async () => 10_000_000n,
} });
mock.module('./holdActions', { namedExports: { freezeHoldVault() {}, stopHoldWithdrawal() {} } });
mock.module('./holdGuard', { namedExports: { discoverGuardedVaults: async () => [], guardState() {}, guardStateLabel() {} } });
mock.module('./mwa', { namedExports: { secureStore: {} } });
mock.module('./holdNotify', { namedExports: { raiseHoldAlertsOnScan: async () => {} } });
mock.module('./chain', { namedExports: { fetchMintDecimals: async () => 6 } });

for (const [route, expected] of [
  ['index', 'Everyday door: 1 USDC a day'],
  ['held', 'not even the everyday 1 USDC a day'],
] as const) {
  test(`the Hold ${route} route includes the token unit in the everyday door text`, async () => {
    const { default: Route } = await import(`../app/hold/${route}`);
    let root!: ReactTestRenderer;
    await act(async () => { root = create(createElement(Route)); });
    try {
      const text = root.root.findAllByType('Text' as never)
        .map((node) => node.children.filter((child) => typeof child === 'string').join('')).join('\n');
      assert.ok(text.includes(expected), text);
    } finally {
      await act(async () => root.unmount());
    }
  });
}

test('the Hold held route includes the token unit in the over-limit reason', async () => {
  const { default: Route } = await import('../app/hold/held');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(Route)); });
  try {
    const text = root.root.findAllByType('Text' as never)
      .map((node) => node.children.filter((child) => typeof child === 'string').join('')).join('\n');
    assert.ok(text.includes('2 USDC is over your 1 USDC a day'), text);
  } finally {
    await act(async () => root.unmount());
  }
});
