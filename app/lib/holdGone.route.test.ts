import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DEVNET_USDC_MINT } from './tokens';
import { HOLD_KIND_PAID, HOLD_KIND_STOPPED } from './hold';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const key = Keypair.generate().publicKey;
const account = {
  address: key, owner: key, mint: new PublicKey(DEVNET_USDC_MINT), vaultToken: key,
  guardian: key, safeAddress: key, vaultId: 1n, dailyLimit: 1_000_000n,
  dailyBuckets: [], windowStart: 0n, windowSpent: 0n, delaySecs: 86400n,
  unfreezeAt: 0n, nextWithdrawalId: 2n, bigShareBps: 1000, known: [], frozen: false,
  pending: [],
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
const state: {
  id?: string;
  entries: { ts: bigint; amount: bigint; destination: PublicKey; withdrawalId: bigint; kind: number; reason: number }[];
} = {
  id: '7',
  entries: [
    { ts: 1_700_000_000n, amount: 2_000_000n, destination: key, withdrawalId: 7n, kind: HOLD_KIND_STOPPED, reason: 0 },
  ],
};
mock.module('expo-router', { namedExports: {
  useRouter: () => ({ back() {}, push() {} }),
  useLocalSearchParams: () => ({ vault: key.toBase58(), id: state.id }),
} });
mock.module('react-native', { namedExports: {
  Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (value: unknown) => value },
} });
for (const name of ['Screen', 'ConnectGate']) {
  mock.module(`../components/${name}`, { namedExports: { [name]: name } });
}
mock.module('../components/backglass/Lamp', { namedExports: { Lamp: 'Lamp' } });
mock.module('../components/hold/chrome', { namedExports: {
  HoldTop: 'HoldTop', ReelValue: 'ReelValue',
  StatusBlock: ({ children, status, empty }: { children: ReactNode; status?: string; empty?: string }) =>
    status === 'empty' ? createElement('Text', null, empty) : children,
  HoldSign: ({ hint }: { hint: string }) => createElement('Text', null, hint),
} });
mock.module('./holdSession', { namedExports: {
  useHoldSession: () => session,
  useHoldBundle: () => ({
    ...session,
    bundle: { account, decimals: 6, balance: 10_000_000n, ledger: { entries: state.entries } },
    nowSec: 1_700_000_000n,
    status: 'ready',
    reload() {},
  }),
} });
mock.module('./holdActions', { namedExports: { freezeHoldVault() {}, stopHoldWithdrawal() {} } });

async function renderHeld(): Promise<string> {
  const { default: Route } = await import('../app/hold/held');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(Route)); });
  try {
    return root.root.findAllByType('Text' as never)
      .map((node) => node.children.filter((child) => typeof child === 'string').join('')).join('\n');
  } finally {
    await act(async () => root.unmount());
  }
}

test('a held withdrawal stopped on chain says so plainly', async () => {
  const text = await renderHeld();
  assert.ok(text.includes('Stopped. Nothing left the vault.'), text);
});

test('a gone withdrawal that was not stopped keeps the neutral line', async () => {
  state.entries = [
    { ts: 1_700_000_000n, amount: 2_000_000n, destination: key, withdrawalId: 7n, kind: HOLD_KIND_PAID, reason: 0 },
  ];
  try {
    const text = await renderHeld();
    assert.ok(
      text.includes('This withdrawal is no longer waiting. Nothing moves unless another request is held.'),
      text,
    );
  } finally {
    state.entries = [
      { ts: 1_700_000_000n, amount: 2_000_000n, destination: key, withdrawalId: 7n, kind: HOLD_KIND_STOPPED, reason: 0 },
    ];
  }
});
