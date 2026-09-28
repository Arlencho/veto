import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

mock.module('react-native', {
  namedExports: {
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
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Circle: Host('Circle'),
    Path: Host('Path'),
  },
});

mock.module('expo-router', {
  namedExports: {
    useRouter: () => ({ push() {}, replace() {}, back() {} }),
  },
});

const PAYEE = '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG';

async function latestText(amount: bigint): Promise<string> {
  const { KIND_PAID } = await import('./constants');
  const { DEVNET_USDC_MINT } = await import('./tokens');
  const { LatestDecision } = await import('../components/daily/LatestDecision');
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(
      createElement(LatestDecision, {
        row: {
          ts: 5_000n,
          amount,
          counterparty: PAYEE,
          nonce: 2n,
          suggestedOverride: 0n,
          kind: KIND_PAID,
          kindName: 'paid',
          reason: 0,
          reasonText: 'ok',
          signature: 'sig-paid',
        },
        decimals: 6,
        perTxMax: 500_000n,
        mandateAddress: 'Rule111111111111111111111111111111111111111',
        payee: PAYEE,
        mint: DEVNET_USDC_MINT,
        remainingText: '4.10 USDC',
        fresh: false,
        last: true,
      }),
    );
  });
  const mounted = root as ReactTestRenderer | null;
  assert.ok(mounted);
  return mounted.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''))
    .join('\n');
}

test('the latest decision on Today says an above-limit payment was allowed once by the owner', async () => {
  const text = await latestText(900_000n);
  assert.match(text, /Allowed once by you: above your limit of 0\.5 USDC\. 4\.10 USDC left\./);
  assert.doesNotMatch(text, /Within the limit/);
});

test('the latest decision on Today keeps the within-the-limit line at or under the limit', async () => {
  const text = await latestText(500_000n);
  assert.match(text, /Within the limit of 0\.5 USDC\. 4\.10 USDC left\./);
  assert.doesNotMatch(text, /Allowed once/);
});

test('the latest decision on Today never shows an above-limit payment equal to the limit', async () => {
  const text = await latestText(504_000n);
  assert.match(text, /Paid 0\.51 USDC to 6i99\.\.\.PdCG/);
  assert.match(text, /Allowed once by you: above your limit of 0\.5 USDC\./);
  assert.match(text, /0\.51 USDC paid/);
});
