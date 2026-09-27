import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NETWORK_LINE = 'This app uses devnet. The wallet must be on devnet.';

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode } & Record<string, unknown>) {
    return createElement(type, props, props.children);
  };
}

class AnimatedValue {
  setValue(_value: number) {}
  interpolate() {
    return 0;
  }
}

const animation = { start() {}, stop() {} };

mock.module('react-native', {
  namedExports: {
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove() {} }),
    },
    ActivityIndicator: Host('ActivityIndicator'),
    Animated: {
      Value: AnimatedValue,
      View: Host('Animated.View'),
      timing: () => animation,
      sequence: () => animation,
      loop: () => animation,
    },
    Easing: {
      bezier: () => () => 0,
      linear: (value: number) => value,
      out: (fn: unknown) => fn,
      in: (fn: unknown) => fn,
      inOut: (fn: unknown) => fn,
    },
    Pressable: Host('Pressable'),
    RefreshControl: Host('RefreshControl'),
    ScrollView: Host('ScrollView'),
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
      hairlineWidth: 1,
    },
    Text: Host('Text'),
    View: Host('View'),
  },
});

// A Seeker in edge to edge mode: the status bar covers the top 48 points.
mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 48, right: 0, bottom: 0, left: 0 }),
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Circle: Host('Circle'),
    Path: Host('Path'),
    Svg: Host('Svg'),
  },
});

let walletOwner: string | null = 'owner';

mock.module('../lib/useWallet', {
  namedExports: {
    useWallet: () => ({ ready: true, ownerPublicKey: walletOwner, cluster: 'devnet', busy: false, error: null, solanaMobileInstalled: false, connect: async () => undefined }),
  },
});

mock.module('../lib/useOnboarding', {
  namedExports: {
    useOnboarding: () => ({ ready: true, seen: true, markSeen: async () => undefined }),
  },
});

type Shape = 'bare' | 'tab' | 'stack';

async function mount(shape: Shape): Promise<ReactTestRenderer> {
  const [{ ConnectGate }, { Screen }, { Cabinet }, { Text }] = await Promise.all([
    import('./ConnectGate'),
    import('./Screen'),
    import('./agents/chrome'),
    import('react-native'),
  ]);
  const home = createElement(Text, null, 'home');
  // tab: the gate inside a Screen, as on the tab routes. stack: the gate wrapping an agents
  // Cabinet, as on /week/<agent>, /agents/<agent> and /agents/plaques/<agent>.
  const node =
    shape === 'tab'
      ? createElement(Screen, { scroll: false, children: createElement(ConnectGate, { children: home }) })
      : shape === 'stack'
        ? createElement(ConnectGate, { children: createElement(Cabinet, { showReading: false, children: home }) })
        : createElement(ConnectGate, { children: home });
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node as ReactElement);
  });
  assert.ok(root);
  return root;
}

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
}

function insetsTop(node: ReactTestInstance): boolean {
  return isHost(node, 'SafeAreaView') && Array.isArray(node.props.edges) && node.props.edges.includes('top');
}

function notice(root: ReactTestRenderer): ReactTestInstance {
  const found = root.root
    .findAll((node) => isHost(node, 'Text'))
    .find((node) => node.props.children === NETWORK_LINE);
  assert.ok(found, 'the devnet line is not shown');
  return found;
}

function insideTopInset(node: ReactTestInstance): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (insetsTop(parent)) {
      return true;
    }
  }
  return false;
}

for (const shape of ['bare', 'tab', 'stack'] as const) {
  test(`the devnet line sits below the status bar with exactly one top inset (${shape})`, async () => {
    const root = await mount(shape);
    assert.equal(insideTopInset(notice(root)), true);
    assert.equal(root.root.findAll(insetsTop).length, 1);
  });
}

test('on a stack route the gate holds the top inset and the Cabinet inside drops it', async () => {
  const root = await mount('stack');
  const areas = root.root.findAll((node) => isHost(node, 'SafeAreaView'));
  assert.equal(areas.length, 2);
  assert.deepEqual(areas[0]?.props.edges, ['top']);
  assert.deepEqual(areas[1]?.props.edges, []);
  assert.equal(areas[0]?.findAll((node) => node === notice(root)).length, 1);
});

test('on a tab route the gate adds no safe area of its own inside the Screen', async () => {
  const root = await mount('tab');
  const areas = root.root.findAll((node) => isHost(node, 'SafeAreaView'));
  assert.equal(areas.length, 1);
  assert.deepEqual(areas[0]?.props.edges, ['top']);
});

test('before the wallet connects, a stack route still keeps the Connect screen below the status bar', async () => {
  walletOwner = null;
  try {
    const root = await mount('stack');
    const areas = root.root.findAll(insetsTop);
    assert.equal(areas.length, 1, 'exactly one top inset');
    const texts = root.root.findAll((node) => isHost(node, 'Text'));
    assert.ok(texts.length > 0);
    assert.ok(texts.every((node) => insideTopInset(node)), 'every text of the Connect screen is inside the inset');
  } finally {
    walletOwner = 'owner';
  }
});
