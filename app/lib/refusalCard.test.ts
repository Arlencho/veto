import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { KIND_OVERRIDE, KIND_REFUSED, REASON_OVER_CAP, REASON_OVER_PER_TX_MAX } from './constants';
import type { LedgerRow } from './ring';

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

mock.module('react-native', {
  namedExports: {
    Pressable: Host('Pressable'),
    RefreshControl: Host('RefreshControl'),
    ScrollView: Host('ScrollView'),
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

mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  },
});

mock.module('expo-router', {
  namedExports: {
    usePathname: () => '/help',
    useRouter: () => ({
      push: () => undefined,
      replace: () => undefined,
      back: () => undefined,
    }),
  },
});

const ALLOWS_ONE =
  'allows one payment, used once, never above the remaining cap';

const RAISES_THE_MAXIMUM =
  /raise per-payment max|raises it to|per-payment ceiling is raised|per-payment ceiling rises|waiver of the per-payment ceiling/;

function visibleText(root: ReactTestRenderer): string {
  const bits: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === 'string' || typeof child === 'number') {
      bits.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        walk(item);
      }
    }
  };
  for (const node of root.root.findAll((candidate) => (candidate.type as unknown) === 'Text')) {
    walk(node.props.children);
  }
  return bits.join('\n');
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  assert.ok(root);
  return root;
}

function refusal(reason: number, suggestedOverride: bigint): LedgerRow {
  return {
    ts: 1n,
    amount: 14n,
    counterparty: 'payee',
    nonce: 2n,
    suggestedOverride,
    kind: KIND_REFUSED,
    kindName: 'refused',
    reason,
    reasonText: 'refused',
    signature: null,
  };
}

test('a refusal over the per-payment maximum says the override allows this one payment of the amount', async () => {
  const { RefusalCard } = await import('../components/RefusalCard');
  const text = visibleText(
    await mount(
      createElement(RefusalCard, {
        row: refusal(REASON_OVER_PER_TX_MAX, 14n),
        decimals: 0,
        perTxMax: 10n,
      }),
    ),
  );
  assert.match(text, /allow this one payment of\n14/);
  assert.doesNotMatch(text, RAISES_THE_MAXIMUM);
});

test('a refusal the program cannot clear does not offer to allow one payment', async () => {
  const { RefusalCard } = await import('../components/RefusalCard');
  const overCap = visibleText(
    await mount(
      createElement(RefusalCard, {
        row: refusal(REASON_OVER_CAP, 14n),
        decimals: 0,
        perTxMax: 10n,
      }),
    ),
  );
  const noAmount = visibleText(
    await mount(
      createElement(RefusalCard, {
        row: refusal(REASON_OVER_PER_TX_MAX, 0n),
        decimals: 0,
        perTxMax: 10n,
      }),
    ),
  );
  assert.equal(overCap.includes('allow this one payment of'), false);
  assert.equal(noAmount.includes('allow this one payment of'), false);
});

test('the grant copy says this override allows this one payment, used once, never above the remaining cap', async () => {
  const { overrideCommitCopy } = await import('./override');
  const copy = overrideCommitCopy({
    amount: 14n,
    nonce: 2n,
    perTxMax: 10n,
    remaining: 80n,
    cap: 100n,
    decimals: 0,
  });
  const text = copy.paragraphs.join(' ');
  assert.match(
    text,
    /covers this one payment of 14, used once, never above the remaining cap/,
  );
  assert.match(text, /per-payment maximum on this rule is 10/);
  assert.match(text, /does not change/);
  assert.doesNotMatch(text, RAISES_THE_MAXIMUM);
});

test('an override on the record says it allows this one payment, used once, never above the remaining cap', async () => {
  const { overrideRowView } = await import('./override');
  const view = overrideRowView(
    {
      kind: KIND_OVERRIDE,
      reason: 0,
      nonce: 2n,
      amount: 14n,
      suggestedOverride: 14n,
    },
    0,
  );
  assert.match(view.why, /allows this one payment, used once, never above the remaining cap/);
  assert.match(view.why, /per-payment maximum does not change/);
  assert.doesNotMatch(view.why, RAISES_THE_MAXIMUM);
});

test('help says an override allows one payment, used once, never above the remaining cap', async () => {
  const [rule, refusalScreen] = await Promise.all([
    import('../app/help/index'),
    import('../app/help/refusal'),
  ]);
  const ruleText = visibleText(await mount(createElement(rule.default)));
  const refusalText = visibleText(await mount(createElement(refusalScreen.default)));
  assert.match(ruleText, new RegExp(ALLOWS_ONE));
  assert.match(refusalText, new RegExp(ALLOWS_ONE));
  assert.doesNotMatch(ruleText, RAISES_THE_MAXIMUM);
  assert.doesNotMatch(refusalText, RAISES_THE_MAXIMUM);
});
