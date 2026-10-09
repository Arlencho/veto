import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { KIND_PAID } from '../lib/constants';
import type { LedgerRow } from '../lib/ring';
import { DEVNET_USDC_MINT } from '../lib/tokens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
mock.module('react-native', {
  namedExports: {
    Linking: { openURL: async () => undefined },
    Pressable: Host('Pressable'),
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
      hairlineWidth: 1,
      absoluteFill: {},
    },
    Text: Host('Text'),
    View: Host('View'),
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove() {} }),
    },
    Animated: {
      Value: class {
        setValue() {}
        interpolate() {
          return 0;
        }
      },
      View: Host('Animated.View'),
      Text: Host('Animated.Text'),
      timing: () => ({ start() {}, stop() {} }),
      delay: () => ({ start() {}, stop() {} }),
      sequence: () => ({ start() {}, stop() {} }),
      loop: () => ({ start() {}, stop() {} }),
      createAnimatedComponent: (Component: unknown) => Component,
    },
    Easing: {
      linear: (value: number) => value,
      cubic: (value: number) => value,
      out: (ease: (value: number) => number) => ease,
      inOut: (ease: (value: number) => number) => ease,
      bezier: () => (value: number) => value,
    },
  },
});
mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Path: Host('Path'),
    Circle: Host('Circle'),
    Rect: Host('Rect'),
    G: Host('G'),
    Defs: Host('Defs'),
    LinearGradient: Host('LinearGradient'),
    Stop: Host('Stop'),
  },
});
mock.module('expo-router', {
  namedExports: {
    useRouter: () => ({ push: () => undefined }),
  },
});

const PER_TX_MAX = 500_000n;

function paidRow(amount: bigint): LedgerRow {
  return {
    ts: 5_000n,
    amount,
    counterparty: '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG',
    nonce: 2n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    kindName: 'paid',
    reason: 0,
    reasonText: 'ok',
    signature: 'sig-paid',
  };
}

async function labelFor(amount: bigint): Promise<string> {
  const { DecisionRow } = await import('./DecisionRow');
  let root: ReactTestRenderer | undefined;
  await act(async () => {
    root = create(
      createElement(DecisionRow, {
        row: paidRow(amount),
        decimals: 6,
        cluster: 'devnet',
        rpcUrl: 'http://127.0.0.1:8899',
        mandateAddress: '11111111111111111111111111111111',
        perTxMax: PER_TX_MAX,
        mint: DEVNET_USDC_MINT,
      }),
    );
  });
  assert.ok(root);
  const label = root.root.findByType('Pressable' as never).props.accessibilityLabel as string;
  act(() => root?.unmount());
  return label;
}

test('a screen reader never hears an above-limit payment rounded down to the limit', async () => {
  assert.equal(await labelFor(500_400n), 'Paid, allowed once by you 0.51 USDC');
  assert.equal(await labelFor(504_000n), 'Paid, allowed once by you 0.51 USDC');
});

test('a payment inside the limit still reads rounded to nearest', async () => {
  assert.equal(await labelFor(494_000n), 'Paid within rule 0.49 USDC');
  assert.equal(await labelFor(500_000n), 'Paid within rule 0.5 USDC');
});
