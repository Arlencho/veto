import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Host(type: string) {
  return function MockHost(
    props: { children?: ReactNode; style?: unknown } & Record<string, unknown>,
  ) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

class AnimatedValue {
  constructor(public value: number) {}
  setValue(value: number) {
    this.value = value;
  }
  interpolate() {
    return 0;
  }
  addListener() {
    return 0;
  }
  removeListener() {}
}

const still = {
  start(cb?: (result: { finished: boolean }) => void) {
    cb?.({ finished: true });
  },
  stop() {},
};

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
      timing: () => still,
      delay: () => still,
      sequence: () => still,
      loop: () => still,
      createAnimatedComponent: (Component: unknown) => Component,
    },
    Easing: {
      linear: (amount: number) => amount,
      cubic: (amount: number) => amount,
      out: (easing: (amount: number) => number) => easing,
      inOut: (easing: (amount: number) => number) => easing,
      bezier: () => (amount: number) => amount,
    },
    Image: Host('Image'),
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
    TextInput: Host('TextInput'),
    View: Host('View'),
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Path: Host('Path'),
    Circle: Host('Circle'),
    Rect: Host('Rect'),
    G: Host('G'),
    Text: Host('SvgText'),
    Defs: Host('Defs'),
    LinearGradient: Host('LinearGradient'),
    Stop: Host('Stop'),
  },
});

function visibleText(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) =>
      node.children.filter((child): child is string => typeof child === 'string').join(''),
    )
    .join('\n');
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  assert.ok(root);
  return root;
}

const params = {
  onboarding: '1',
  guardian: 'So11111111111111111111111111111111111111112',
  mode: 'seeker',
};
let current: ReactElement | null = null;
let destination = '';
mock.module('expo-router', {
  namedExports: {
    Stack: () => current,
    useLocalSearchParams: () => params,
    useRouter: () => ({
      push: (route: string) => {
        destination = route;
      },
      replace: (route: string) => {
        destination = route;
      },
      back() {},
    }),
  },
});
const Wrapper = ({ children }: { children: ReactNode }) => children;
mock.module('../components/Screen', { namedExports: { Screen: Wrapper } });
mock.module('../components/ConnectGate', { namedExports: { ConnectGate: Wrapper } });
let protectionLive = false;
const owner = new PublicKey('11111111111111111111111111111111');
mock.module('./holdSession', {
  namedExports: {
    useHoldSession: () => ({
      wallet: { ready: true, busy: false, signAndSend: async () => [] },
      owner,
      chain: {
        mandates: protectionLive ? [{ status: 0, expiresAt: 9999999999n }] : [],
        loading: false,
        error: null,
      },
      config: { mint: params.guardian },
      client: {},
      network: 'Devnet',
      tokenName: 'USDC',
    }),
  },
});
mock.module('./holdSign', { namedExports: { exposedWalletAccounts: async () => [] } });
mock.module('./chain', {
  namedExports: { fetchMintDecimals: async () => 6, tokenProgramOfMint: async () => owner },
});
mock.module('./holdChain', {
  namedExports: {
    listHoldVaults: async () => (protectionLive ? [{ owner }] : []),
    nextVaultId: () => 0n,
  },
});
mock.module('./holdActions', {
  namedExports: { openHoldVault: async () => ({ vault: owner, signature: 'confirmed' }) },
});

test('second Seeker address reaches the existing guardian screen and confirmed setup returns to onboarding', async () => {
  const { default: Layout } = await import('../app/hold/_layout');
  const { default: Rules } = await import('../app/hold/rules');
  const { default: Guardian } = await import('../app/hold/guardian');
  const { GuardianScreen } = await import('../components/hold/GuardianScreen');
  const { RulesScreen } = await import('../components/hold/RulesScreen');
  const { default: Live } = await import('../app/hold/live');
  const { LiveScreen } = await import('../components/hold/LiveScreen');
  current = createElement(Rules);
  const root = await mount(createElement(Layout));
  assert.match(visibleText(root), /1 USDC/);
  await act(async () => root.root.findByType(RulesScreen).props.onNext());
  assert.equal(destination, '/hold/guardian');
  current = createElement(Guardian);
  await act(async () => root.update(createElement(Layout)));
  const guardian = root.root.findByType(GuardianScreen);
  assert.equal(guardian.props.guardianText, params.guardian);
  assert.equal(guardian.props.safeText, params.guardian);
  assert.equal(guardian.props.mode, 'seeker');
  await act(async () => guardian.props.onSign());
  assert.equal(destination, '/hold/live');
  current = createElement(Live);
  await act(async () => root.update(createElement(Layout)));
  assert.match(visibleText(root), /Your vault is live/);
  await act(async () => root.root.findByType(LiveScreen).props.onDone());
  assert.equal(destination, '/first-run/finish');
  await act(async () => root.unmount());
});

const saved = new Map<string, string>();
mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async (key: string) => saved.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        saved.set(key, value);
      },
    },
  },
});
mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({ ready: true, ownerPublicKey: owner.toBase58(), cluster: 'devnet' }),
  },
});

test('skipping the rendered Hold step shows the finish and never offers the step on reopening', async () => {
  const { default: Protect } = await import('../app/first-run/protect');
  const { ProtectScreen } = await import('../components/firstrun/ProtectScreen');
  const root = await mount(createElement(Protect));
  assert.match(visibleText(root), /Protect the rest of your money/);
  await act(async () => root.root.findByType(ProtectScreen).props.onLater());
  assert.equal(destination, '/first-run/finish');
  await act(async () => root.unmount());
  destination = '';
  const reopened = await mount(createElement(Protect));
  assert.doesNotMatch(visibleText(reopened), /Protect the rest of your money/);
  assert.equal(destination, '/first-run/finish');
  await act(async () => reopened.unmount());
});

test('finish names live protections and says when Hold is not set up yet', async () => {
  const { default: Finish } = await import('../app/first-run/finish');
  protectionLive = false;
  const empty = await mount(createElement(Finish));
  assert.match(visibleText(empty), /Agent rule not live yet/);
  assert.match(visibleText(empty), /Hold vault not set up yet/);
  await act(async () => empty.unmount());
  protectionLive = true;
  const live = await mount(createElement(Finish));
  assert.match(visibleText(live), /Agent rule live/);
  assert.match(visibleText(live), /Hold vault live/);
  await act(async () => live.unmount());
});
