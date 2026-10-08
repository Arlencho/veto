import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Keypair, PublicKey } from '@solana/web3.js';
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { act, createElement } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { barUnits, networkLabel, refusalStreak, ruleDay } from '../components/daily/facts';
import { space } from '../components/theme';
import { KIND_PAID, KIND_REFUSED, STATUS_REVOKED } from './constants';
import type { MandateAccount } from './mandate';
import { DEVNET_USDC_MINT, USDC_DEVNET_NOTE, VTEST_DEVNET_NOTE, VTEST_MINT } from './tokens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

const owner = Keypair.generate().publicKey.toBase58();
const route: { current: Record<string, string | undefined> } = { current: {} };
const camera: { permission: { granted: boolean; canAskAgain: boolean } | null } = { permission: null };
const rulesetReady = { current: true };
let openCalls = 0;
let closeCalls = 0;
let sharedWalletError: string | null = null;
let focused = true;
let laterWalletTransact: import('./wallet').TransactFn | null = null;
const openedUrls: string[] = [];
const copiedText: string[] = [];
const navigation: string[] = [];

function key(): string {
  return Keypair.generate().publicKey.toBase58();
}

function mandate(partial: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: key(),
    owner,
    agent: key(),
    mint: key(),
    source: key(),
    merchant: key(),
    mandateId: 1n,
    cap: 300n,
    spent: 42n,
    perTxMax: 10n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 84 * 86400),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'garage charger',
    status: 0,
    spendCount: 6,
    refusalCount: 2,
    bump: 1,
    ...partial,
  };
}

const chain = {
  ready: true,
  loading: false,
  error: null as string | null,
  rateLimited: false,
  checkedOwner: owner,
  mandateStatus: 'empty' as 'empty' | 'present' | 'not-read' | 'failed' | 'rate-limited',
  config: {
    rpcUrl: 'http://127.0.0.1',
    programId: key(),
    mint: key(),
    explorerCluster: 'devnet',
    mintDecimals: 0,
  },
  configError: null as string | null,
  mandate: null as MandateAccount | null,
  mandates: [] as MandateAccount[],
  snapshot: null,
  rows: [] as { kind: number; ts: bigint; amount: bigint; counterparty: string; nonce: bigint; suggestedOverride: bigint; kindName: string; reason: number; reasonText: string; signature: string | null }[],
  decimals: 0,
  nowMs: Date.now(),
  genesisHash: null,
  submitHeld: false,
  refresh: async () => undefined,
  selectMandate: async () => undefined,
  open: async () => {
    openCalls += 1;
    throw new Error('The wallet cancelled the request');
  },
  revoke: async () => {
    throw new Error('not used');
  },
  close: async () => {
    closeCalls += 1;
    throw new Error('The wallet cancelled the request');
  },
  probeOverride: async () => {
    throw new Error('not used');
  },
  grantOverride: async () => {
    throw new Error('not used');
  },
};

mock.module('react-native', {
  namedExports: {
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove() {} }),
    },
    ActivityIndicator: Host('ActivityIndicator'),
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
    Image: Host('Image'),
    Keyboard: { addListener: () => ({ remove() {} }) },
    KeyboardAvoidingView: Host('KeyboardAvoidingView'),
    Linking: {
      openURL: async (url: string) => {
        openedUrls.push(url);
      },
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Platform: { OS: 'ios', select: (spec: { ios?: unknown }) => spec.ios },
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
    TextInput: Host('TextInput'),
    UIManager: {
      measureLayout: (_node: number, _relative: number, _fail: () => void, ok: (x: number, y: number) => void) => ok(0, 0),
    },
    View: Host('View'),
    findNodeHandle: () => 1,
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
    useRouter: () => ({ push(path: string) { navigation.push(path); }, replace(path: string) { navigation.push(path); }, back() { navigation.push('back'); } }),
    usePathname: () => '/',
    useLocalSearchParams: () => route.current,
    useFocusEffect(effect: () => void | (() => void)) {
      useEffect(() => focused ? effect() : undefined, [effect, focused]);
    },
  },
});

mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async () => null,
      setItem: async () => undefined,
      deleteItem: async () => undefined,
    },
    transact: ((callback, config) => {
      if (!laterWalletTransact) throw new Error('no wallet');
      return laterWalletTransact(callback, config);
    }) as import('./wallet').TransactFn,
  },
});

mock.module('expo-clipboard', {
  namedExports: {
    getStringAsync: async () => '',
    setStringAsync: async (value: string) => {
      copiedText.push(value);
    },
  },
});

mock.module('expo-camera', {
  namedExports: {
    CameraView: Host('CameraView'),
    useCameraPermissions: () => [camera.permission, async () => undefined],
  },
});

mock.module('./useChain', {
  namedExports: {
    useChain: () => chain,
    ChainProvider: ({ children }: { children: ReactNode }) => children,
  },
});

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({
      ready: true,
      busy: false,
      error: sharedWalletError,
      cluster: 'devnet',
      solanaMobileInstalled: false,
      ownerPublicKey: owner,
      agentPublicKey: null,
      connect: async () => undefined,
      disconnect: async () => undefined,
      signAndSend: async () => [],
      getAgentKeypair: async () => null,
      createAgentKeypair: async () => {
        throw new Error('no key');
      },
    }),
  },
});

mock.module('./useOnboarding', {
  namedExports: {
    useOnboarding: () => ({ ready: true, seen: true, markSeen: async () => undefined }),
  },
});

mock.module('./useRulesets', {
  namedExports: {
    useRulesets: () => ({
      ready: rulesetReady.current,
      rulesets: [],
      save: async () => {
        throw new Error('not used');
      },
    }),
  },
});

mock.module('./useNotificationOffer', {
  namedExports: {
    useNotificationOffer: () => ({ show: false, turnOn: async () => undefined }),
  },
});

mock.module('./useNotificationExplanation', {
  namedExports: {
    useNotificationExplanation: () => ({ explanation: null, statusLine: null, onContinue: () => undefined }),
  },
});

mock.module('./chain', {
  namedExports: {
    createClient: () => ({
      connection: {
        getAccountInfo: async () => null,
        getTokenAccountsByOwner: async () => ({ value: [] }),
      },
    }),
    fetchAdvisoryDeclines: async () => [],
    readRuleFunds: async () => ({
      source: 'source',
      balance: 258n,
      kind: 'dedicated',
      closeCreatesAssociated: false,
      decimals: chain.decimals,
      otherRule: null,
      tokenProgram: null,
    }),
  },
});

mock.module('./presignRead', {
  namedExports: {
    observePresign: async () => ({
      configuredCluster: 'devnet',
      genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      ownerTokenBalance: 1000n,
      cap: 0n,
      decimals: 0,
      mintReadable: true,
      solLamports: 1000000000,
      rentAndFeesLamports: 1000000,
      walletFloorLamports: 1000000,
      payeeHasTokenAccount: true,
    }),
  },
});

const UNPROVEN_CLAIM =
  /no rule live|no rule yet|no rules yet|no decisions|no agent|nothing on chain|no rule on chain|open your first rule/i;

function textLines(root: ReactTestRenderer): string[] {
  return root.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => {
      const bits: string[] = [];
      const walk = (child: unknown) => {
        if (typeof child === 'string' || typeof child === 'number') {
          bits.push(String(child));
        } else if (Array.isArray(child)) {
          for (const item of child) {
            walk(item);
          }
        }
      };
      walk(node.props.children);
      return bits.join('');
    })
    .filter((line) => line.length > 0);
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((item) => flatStyle(item)));
  }
  if (style && typeof style === 'object') {
    return style as Record<string, unknown>;
  }
  return {};
}

function hasScreenInset(node: ReactTestInstance | null): boolean {
  let current: ReactTestInstance | null = node;
  while (current) {
    const style = flatStyle(current.props?.style);
    if (style.paddingHorizontal === space.screen || style.marginHorizontal === space.screen) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function textOf(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => {
      const bits: string[] = [];
      const walk = (child: unknown) => {
        if (typeof child === 'string' || typeof child === 'number') {
          bits.push(String(child));
        } else if (Array.isArray(child)) {
          for (const item of child) walk(item);
        }
      };
      walk(node.props.children);
      return bits.join('');
    })
    .filter((line) => line.length > 0)
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

function byLabel(root: ReactTestRenderer, prefix: string): ReactTestInstance {
  const found = root.root
    .findAll((node) => (node.type as unknown) === 'Pressable')
    .find((node) => String(node.props.accessibilityLabel ?? '').startsWith(prefix));
  assert.ok(found, `missing ${prefix}`);
  return found;
}

test('the home spend board says what one block is and shows two decimals', async () => {
  const { SpendBoard } = await import('../components/daily/SpendBoard');
  const root = await mount(
    createElement(SpendBoard, {
      kicker: 'Your agent can still spend',
      remainingText: '0.996 USDC',
      ofText: 'of 300',
      spentText: '16.939875',
      spentCaption: 'spent so far',
      remaining: 151,
      cap: 300,
      accessibilityLabel: 'left',
      leftCaption: '1 block is one share of 300',
      rightCaption: 'Most per payment: 10',
    }),
  );
  const text = textOf(root);
  assert.match(text, /1 block = 1 payment of 10/);
  assert.doesNotMatch(text, /one share of/);
  assert.match(text, /0\.99 USDC/);
  assert.match(text, /16\.94/);
  assert.doesNotMatch(text, /0\.996|16\.939875/);
});

test('a refusal streak counts only the newest run, and the day comes from the opened time', () => {
  assert.equal(networkLabel('devnet'), 'Devnet');
  assert.equal(refusalStreak([{ kind: KIND_PAID }, { kind: KIND_REFUSED }, { kind: KIND_REFUSED }]), 2);
  assert.equal(refusalStreak([{ kind: KIND_REFUSED }, { kind: KIND_PAID }]), 0);
  const now = 1_700_000_000n;
  const opened = now - 5n * 86400n;
  const clock = ruleDay(opened, now + 84n * 86400n, now);
  assert.deepEqual(clock, { day: 6, total: 89 });
  assert.deepEqual(barUnits(258n, 300n).remaining > 0, true);
});

test('home reads loading, empty, error, and the chain amounts', async () => {
  const Screen = (await import('../app/(tabs)/index')).default;
  chain.mandateStatus = 'not-read';
  chain.mandate = null;
  chain.mandates = [];
  chain.error = null;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Reading the chain for this owner/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'empty';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Open your first rule/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'failed';
  chain.error = 'The RPC refused this read';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Could not reach the blockchain\. Pull down to try again/);
  assert.doesNotMatch(textOf(root), /RPC/);
  await act(async () => root.unmount());

  const row = mandate();
  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = row;
  chain.mandates = [row];
  chain.rows = [
    {
      kind: KIND_REFUSED,
      ts: 1n,
      amount: 14n,
      counterparty: row.merchant,
      nonce: 1n,
      suggestedOverride: 0n,
      kindName: 'refused',
      reason: 5,
      reasonText: 'over per-payment maximum',
      signature: null,
    },
  ];
  root = await mount(createElement(Screen));
  const normal = textOf(root);
  assert.match(normal, /Your agent can still spend/);
  assert.match(normal, /258/);
  assert.match(normal, /of 300/);
  assert.match(normal, /garage charger/);
  assert.doesNotMatch(normal, /Charging agent/);
  await act(async () => root.unmount());

  const vtest = mandate({ mint: VTEST_MINT });
  chain.mandate = vtest;
  chain.mandates = [vtest];
  chain.config = { ...chain.config, mint: VTEST_MINT, explorerCluster: 'devnet' };
  root = await mount(createElement(Screen));
  const noted = textOf(root);
  assert.equal(noted.split(VTEST_DEVNET_NOTE).length - 1, 1);
  assert.match(noted, /258 VTEST/);
  await act(async () => root.unmount());

  chain.config = { ...chain.config, explorerCluster: 'mainnet-beta' };
  root = await mount(createElement(Screen));
  assert.equal(textOf(root).includes(VTEST_DEVNET_NOTE), false);
  chain.config = { ...chain.config, explorerCluster: 'devnet' };
  await act(async () => root.unmount());
});

test('home paid tile says how many payments the owner allowed once above the limit', async () => {
  const Screen = (await import('../app/(tabs)/index')).default;
  const paidRow = (nonce: bigint, amount: bigint, merchant: string) => ({
    kind: KIND_PAID,
    ts: 1n,
    amount,
    counterparty: merchant,
    nonce,
    suggestedOverride: 0n,
    kindName: 'paid',
    reason: 0,
    reasonText: '',
    signature: null,
  });
  const rule = mandate({ perTxMax: 5_000_000n, spendCount: 2, cap: 50_000_000n, spent: 13_900_000n });
  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = rule;
  chain.mandates = [rule];
  chain.rows = [paidRow(1n, 1_000_000n, rule.merchant), paidRow(2n, 12_900_000n, rule.merchant)];
  let root = await mount(createElement(Screen));
  let text = textOf(root);
  assert.match(text, /by your agent/);
  assert.match(text, /1 allowed once by you/);
  assert.doesNotMatch(text, /all within the rule/);
  assert.doesNotMatch(text, /nonce/i);
  assert.ok(
    root.root.findAll((node) => node.props.accessibilityLabel === '2 payments paid by your agent, 1 allowed once by you').length > 0,
  );
  await act(async () => root.unmount());

  chain.rows = [paidRow(1n, 1_000_000n, rule.merchant), paidRow(2n, 5_000_000n, rule.merchant)];
  root = await mount(createElement(Screen));
  text = textOf(root);
  assert.match(text, /all within the rule/);
  assert.doesNotMatch(text, /allowed once/);
  await act(async () => root.unmount());
  chain.rows = [];
});

test('home offers Get devnet USDC on the empty state only for that mint, and names the USDC note once', async () => {
  const Screen = (await import('../app/(tabs)/index')).default;
  const previous = chain.config;
  chain.mandateStatus = 'empty';
  chain.mandate = null;
  chain.mandates = [];
  chain.error = null;
  chain.config = { ...previous, mint: DEVNET_USDC_MINT, explorerCluster: 'devnet' };
  openedUrls.length = 0;
  copiedText.length = 0;
  let root = await mount(createElement(Screen));
  let text = textOf(root);
  assert.equal(text.split('Get devnet USDC').length - 1, 1);
  assert.match(text, /Paste this address into the faucet\. It sends devnet USDC, which has no value\./);
  assert.match(text, new RegExp(owner));
  await act(async () => {
    byLabel(root, 'Copy').props.onPress();
    byLabel(root, 'Get devnet USDC').props.onPress();
  });
  assert.deepEqual(copiedText, [owner]);
  assert.deepEqual(openedUrls, ['https://faucet.circle.com']);
  await act(async () => root.unmount());

  chain.config = { ...previous, mint: DEVNET_USDC_MINT, explorerCluster: 'mainnet-beta' };
  root = await mount(createElement(Screen));
  assert.equal(textOf(root).includes('Get devnet USDC'), false);
  await act(async () => root.unmount());

  chain.config = { ...previous, mint: VTEST_MINT, explorerCluster: 'devnet' };
  root = await mount(createElement(Screen));
  assert.equal(textOf(root).includes('Get devnet USDC'), false);
  await act(async () => root.unmount());

  const usdc = mandate({ mint: DEVNET_USDC_MINT });
  chain.mandateStatus = 'present';
  chain.decimals = 0;
  chain.mandate = usdc;
  chain.mandates = [usdc];
  chain.config = { ...previous, mint: DEVNET_USDC_MINT, explorerCluster: 'devnet' };
  root = await mount(createElement(Screen));
  const noted = textOf(root);
  assert.equal(noted.split(USDC_DEVNET_NOTE).length - 1, 1);
  assert.equal(noted.includes(VTEST_DEVNET_NOTE), false);
  assert.equal(noted.includes('Get devnet USDC'), false);
  assert.match(noted, /258 USDC/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'empty';
  chain.mandate = null;
  chain.mandates = [];
  chain.config = previous;
});

test('the rules list names each token and does not add different mints together', async () => {
  const Screen = (await import('../app/(tabs)/rules')).default;
  const vtest = mandate({
    address: 'RuleVtestAddressaaaaaaaaaaaaaaaaaaaaaa',
    agent: 'AgentVtestAddressaaaaaaaaaaaaaaaaaaaaa',
    merchant: 'PayeeVtestAddressaaaaaaaaaaaaaaaaaaaaa',
    mint: VTEST_MINT,
    cap: 111n,
    spent: 0n,
    purpose: 'garage charger',
  });
  const usdc = mandate({
    address: 'RuleUsdcAddressbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'AgentUsdcAddressbbbbbbbbbbbbbbbbbbbbbbb',
    merchant: 'PayeeUsdcAddressbbbbbbbbbbbbbbbbbbbbbbb',
    mint: DEVNET_USDC_MINT,
    cap: 222n,
    spent: 0n,
    purpose: 'charge the car',
  });
  chain.mandateStatus = 'present';
  chain.error = null;
  chain.decimals = 0;
  chain.mandate = vtest;
  chain.mandates = [vtest, usdc];
  const root = await mount(createElement(Screen));
  const text = textOf(root);
  assert.match(text, /111 VTEST/);
  assert.match(text, /222 USDC/);
  assert.match(text, /1 rule in VTEST\. 1 rule in USDC\./);
  assert.equal(text.includes('333'), false);
  await act(async () => root.unmount());
  chain.mandateStatus = 'empty';
  chain.mandate = null;
  chain.mandates = [];
});

test('rules reads loading, empty, error, and a live rule from the chain', async () => {
  const Screen = (await import('../app/(tabs)/rules')).default;
  chain.mandateStatus = 'not-read';
  chain.mandate = null;
  chain.mandates = [];
  chain.error = null;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Reading the chain for this owner/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'empty';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Nothing on chain for this owner yet/);
  assert.match(textOf(root), /Scan a request/);
  assert.match(textOf(root), /Charging agent/);
  assert.match(textOf(root), /Cap a mint bot/);
  assert.match(textOf(root), /Trading bot/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'failed';
  chain.error = 'Rules could not be read';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Could not reach the blockchain\. Pull down to try again/);
  assert.doesNotMatch(textOf(root), /Rules could not be read/);
  await act(async () => root.unmount());

  const row = mandate();
  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = row;
  chain.mandates = [row];
  root = await mount(createElement(Screen));
  const normal = textOf(root);
  assert.match(normal, /garage charger/);
  assert.match(normal, /258/);
  assert.match(normal, /Write a rule/);
  await act(async () => root.unmount());
});

async function tabText(which: 'home' | 'rules'): Promise<ReactTestRenderer> {
  const screen =
    which === 'home'
      ? (await import('../app/(tabs)/index')).default
      : (await import('../app/(tabs)/rules')).default;
  return mount(createElement(screen));
}

for (const which of ['home', 'rules'] as const) {
  test(`${which} while the chain is rate limited says the blockchain is busy and claims nothing about rules or decisions`, async () => {
    chain.mandateStatus = 'rate-limited';
    chain.loading = true;
    chain.error = 'The RPC refused this read';
    chain.mandate = null;
    chain.mandates = [];
    chain.rows = [];
    const root = await tabText(which);
    const text = textOf(root);
    assert.match(text, /The blockchain is busy right now\. Veto keeps trying\./);
    assert.match(text, /Reading\.\.\./);
    assert.doesNotMatch(text, /RPC/);
    assert.doesNotMatch(text, UNPROVEN_CLAIM);
    await act(async () => root.unmount());
  });

  test(`${which} after a failed read says to pull down and does not claim there is no rule or no decisions`, async () => {
    chain.mandateStatus = 'failed';
    chain.loading = false;
    chain.error = 'The RPC refused this read';
    chain.mandate = null;
    chain.mandates = [];
    chain.rows = [];
    const root = await tabText(which);
    const text = textOf(root);
    assert.match(text, /Could not reach the blockchain\. Pull down to try again\./);
    assert.match(text, /Could not read/);
    assert.doesNotMatch(text, /RPC/);
    assert.doesNotMatch(text, UNPROVEN_CLAIM);
    await act(async () => root.unmount());
  });

  test(`${which} after a successful read shows the rule and that one rule is live`, async () => {
    const row = mandate();
    chain.mandateStatus = 'present';
    chain.loading = false;
    chain.error = null;
    chain.mandate = row;
    chain.mandates = [row];
    chain.rows = [];
    const root = await tabText(which);
    const text = textOf(root);
    assert.match(text, /garage charger/);
    assert.match(text, /1 rule live/);
    assert.doesNotMatch(text, /Could not read/);
    assert.doesNotMatch(text, /blockchain is busy/);
    await act(async () => root.unmount());
  });

  test(`${which} draws the reading line below the header with the screen padding`, async () => {
    chain.mandateStatus = 'not-read';
    chain.loading = true;
    chain.error = null;
    chain.mandate = null;
    chain.mandates = [];
    const root = await tabText(which);
    const lines = textLines(root);
    const veto = lines.findIndex((line) => line.includes('Veto'));
    const reading = lines.findIndex((line) => line.includes('Reading the chain.'));
    assert.ok(veto >= 0, lines.join(' | '));
    assert.ok(reading > veto, lines.join(' | '));
    const readingNode = root.root.findAll((candidate) => (candidate.type as unknown) === 'Text').find((candidate) => {
      const bits: string[] = [];
      const walk = (child: unknown) => {
        if (typeof child === 'string' || typeof child === 'number') {
          bits.push(String(child));
        } else if (Array.isArray(child)) {
          for (const item of child) {
            walk(item);
          }
        }
      };
      walk(candidate.props.children);
      return bits.join('').includes('Reading the chain.');
    });
    assert.ok(readingNode);
    assert.equal(hasScreenInset(readingNode), true);
    await act(async () => root.unmount());
  });
}

test('a rule page reads loading, a missing rule, a failed read, and the amounts still in it', async () => {
  const Screen = (await import('../app/rule/[address]')).default;
  const row = mandate();
  route.current = { address: row.address };
  chain.loading = false;
  chain.mandateStatus = 'not-read';
  chain.mandate = null;
  chain.mandates = [];
  chain.error = null;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Reading the chain for this owner/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'empty';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /This rule is not on chain for this owner/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'failed';
  chain.error = 'This rule could not be read';
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Could not reach the blockchain/);
  assert.match(textOf(root), /Pull down to try again/);
  await act(async () => root.unmount());

  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = row;
  chain.mandates = [row];
  root = await mount(createElement(Screen));
  const normal = textOf(root);
  assert.match(normal, /Your agent can still spend/);
  assert.match(normal, /258/);
  assert.match(normal, /garage charger/);
  assert.match(normal, /Give your agent its setup/);
  await act(async () => root.unmount());
});

test('a stopped rule offers close again after a cancelled signature', async () => {
  const Screen = (await import('../app/rule/[address]')).default;
  const row = mandate({ status: STATUS_REVOKED, expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10) });
  route.current = { address: row.address };
  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = row;
  chain.mandates = [row];
  chain.submitHeld = false;
  closeCalls = 0;
  const root = await mount(createElement(Screen));
  assert.match(textOf(root), /You stopped this rule/);
  const press = () => byLabel(root, 'Press and hold to close this rule');
  await act(async () => {
    press().props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    press().props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(closeCalls, 2);
  await act(async () => root.unmount());
});

test('scan reads a missing camera, a denied camera, a bad code, and a live camera', async () => {
  const Screen = (await import('../app/scan')).default;
  route.current = { target: 'request' };
  camera.permission = null;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Checking the camera/);
  await act(async () => root.unmount());

  camera.permission = { granted: false, canAskAgain: true };
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /The camera is off/);
  assert.match(textOf(root), /Allow camera/);
  await act(async () => root.unmount());

  camera.permission = { granted: true, canAskAgain: true };
  root = await mount(createElement(Screen));
  assert.match(textOf(root), /Looking for the code/);
  assert.match(textOf(root), /Point the camera at your agent's rule request code/);
  const cameraNode = root.root.findAll((node) => (node.type as unknown) === 'CameraView')[0];
  assert.ok(cameraNode);
  await act(async () => {
    cameraNode.props.onBarcodeScanned({ data: 'not-a-code' });
  });
  assert.match(textOf(root), /That code is not a rule request|not a rule request or an address/);
  await act(async () => root.unmount());
});

test('a new rule shows loading, an empty payee, a failed open, and arms the hold again', async () => {
  const Screen = (await import('../app/rule/new')).default;
  route.current = { ruleset: 'mint-budget' };
  rulesetReady.current = false;
  let root = await mount(createElement(Screen));
  assert.match(textOf(root), /Reading this phone and the chain/);
  await act(async () => root.unmount());

  rulesetReady.current = true;
  route.current = { ruleset: 'new' };
  chain.submitHeld = false;
  openCalls = 0;
  root = await mount(createElement(Screen));
  const shown = textOf(root);
  assert.match(shown, /Author a ruleset|Press and hold to approve rule/);
  const payee = root.root
    .findAll((node) => (node.type as unknown) === 'TextInput')
    .find((node) => node.props.accessibilityLabel === 'Payee');
  assert.ok(payee);
  assert.equal(payee.props.value, '');
  await act(async () => {
    payee.props.onChangeText(key());
  });
  const press = () => byLabel(root, 'Press and hold to approve rule');
  await act(async () => {
    press().props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    press().props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(openCalls, 2);
  assert.match(textOf(root), /cancelled/);
  await act(async () => root.unmount());
});


test('a renewal link cannot swap the agent and shows a changed payee before signing', async () => {
  const Screen = (await import('../app/rule/new')).default;
  const source = mandate({ expiresAt: BigInt(Math.floor(Date.now() / 1000) + 84 * 86400 + 3600) });
  const attacker = key();
  const saved = chain.mandates;
  chain.mandates = [source];
  try {
    const inputs = (root: ReactTestRenderer, label: string) =>
      root.root
        .findAll((node) => (node.type as unknown) === 'TextInput')
        .find((node) => node.props.accessibilityLabel === label);

    route.current = { from: source.address, renew: '1', payee: attacker, agent: key(), cap: '500', per: '500' };
    let root = await mount(createElement(Screen));
    assert.equal(inputs(root, 'Agent address')?.props.value, source.agent);
    assert.equal(inputs(root, 'Payee')?.props.value, attacker);
    assert.match(textOf(root), new RegExp(`Changed from ${source.merchant} to ${attacker}`));
    await act(async () => root.unmount());

    route.current = { from: source.address, renew: '1', payee: source.merchant, cap: '300', per: '10', days: '84' };
    root = await mount(createElement(Screen));
    assert.equal(inputs(root, 'Agent address')?.props.value, source.agent);
    assert.doesNotMatch(textOf(root), /Changed from/);
    await act(async () => root.unmount());
  } finally {
    chain.mandates = saved;
  }
});


test('a renewal link raising cap, per-payment maximum and days shows each change before signing', async () => {
  const Screen = (await import('../app/rule/new')).default;
  // 84 days and one hour left, so the rule reads as 84 days left for the whole test.
  const source = mandate({ expiresAt: BigInt(Math.floor(Date.now() / 1000) + 84 * 86400 + 3600) });
  const saved = chain.mandates;
  chain.mandates = [source];
  try {
    const input = (root: ReactTestRenderer, label: string) =>
      root.root
        .findAll((node) => (node.type as unknown) === 'TextInput')
        .find((node) => node.props.accessibilityLabel === label || String(node.props.accessibilityLabel).startsWith(`${label},`));

    route.current = { from: source.address, renew: '1', payee: source.merchant, cap: '5000', per: '500', days: '365', purpose: 'garage charger' };
    const root = await mount(createElement(Screen));
    let shown = textOf(root);
    assert.match(shown, /Changed from 300 to 5000/);
    assert.match(shown, /Changed from 10 to 500/);
    assert.match(shown, /Changed from 84 days left to 365 days/);
    assert.doesNotMatch(shown, new RegExp(`Changed from ${source.merchant}`));
    assert.doesNotMatch(shown, /Changed from "/);

    // The owner putting a field back removes its line; editing another field adds one.
    await act(async () => {
      input(root, 'Cap')!.props.onChangeText('300');
    });
    await act(async () => {
      input(root, 'Expiry (days from now)')!.props.onChangeText('84');
    });
    shown = textOf(root);
    assert.doesNotMatch(shown, /Changed from 300 to/);
    assert.doesNotMatch(shown, /days left to/);
    assert.match(shown, /Changed from 10 to 500/);
    await act(async () => {
      input(root, 'Per-payment maximum')!.props.onChangeText('10');
    });
    assert.doesNotMatch(textOf(root), /Changed from/);
    await act(async () => {
      input(root, 'Cap')!.props.onChangeText('301');
    });
    assert.match(textOf(root), /Changed from 300 to 301/);
    await act(async () => root.unmount());
  } finally {
    chain.mandates = saved;
  }
});

test('a renewal link or an edit that changes the purpose shows the change before signing', async () => {
  const Screen = (await import('../app/rule/new')).default;
  const source = mandate({ expiresAt: BigInt(Math.floor(Date.now() / 1000) + 84 * 86400 + 3600) });
  const saved = chain.mandates;
  chain.mandates = [source];
  try {
    const input = (root: ReactTestRenderer, label: string) =>
      root.root
        .findAll((node) => (node.type as unknown) === 'TextInput')
        .find((node) => node.props.accessibilityLabel === label);
    const same = { from: source.address, renew: '1', payee: source.merchant, cap: '300', per: '10', days: '84' };

    route.current = { ...same, purpose: 'pay any invoice' };
    let root = await mount(createElement(Screen));
    assert.match(textOf(root), /Changed from "garage charger" to "pay any invoice"/);
    await act(async () => root.unmount());

    route.current = { ...same, purpose: 'garage charger' };
    root = await mount(createElement(Screen));
    assert.doesNotMatch(textOf(root), /Changed from/);
    await act(async () => {
      input(root, 'Purpose')!.props.onChangeText('garage charger and parking');
    });
    assert.match(textOf(root), /Changed from "garage charger" to "garage charger and parking"/);
    await act(async () => root.unmount());
  } finally {
    chain.mandates = saved;
  }
});

test('Overview and Rules never display the wallet error from another screen', async () => {
  sharedWalletError = 'You cancelled the wallet request.';
  try {
    for (const Screen of [
      (await import('../app/(tabs)/index')).default,
      (await import('../app/(tabs)/rules')).default,
    ]) {
      const root = await mount(createElement(Screen));
      assert.doesNotMatch(textOf(root), /You cancelled the wallet request/);
      await act(async () => root.unmount());
    }
  } finally {
    sharedWalletError = null;
  }
});

for (const later of ['navigation', 'connect', 'sign', 'disconnect', 'partial sign', 'account selection'] as const) {
  test(`a rule cancellation disappears after later ${later}`, async () => {
    const Screen = (await import('../app/rule/[address]')).default;
    const row = mandate({ status: STATUS_REVOKED });
    route.current = { address: row.address };
    chain.mandateStatus = 'present';
    chain.mandate = row;
    chain.mandates = [row];
    chain.submitHeld = false;
    const root = await mount(createElement(Screen));
    await act(async () => {
      byLabel(root, 'Press and hold to close this rule').props.onLongPress();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.match(textOf(root), /The wallet cancelled the request/);
    if (later === 'navigation') {
      focused = false;
      await act(async () => root.update(createElement(Screen)));
      focused = true;
      await act(async () => root.update(createElement(Screen)));
    } else {
      const { connect, disconnect, signAndSendTransactions } = await import('./wallet');
      const { Transaction } = await import('@solana/web3.js');
      const store = {
        getItem: async () => null,
        setItem: async () => undefined,
        deleteItem: async () => undefined,
      };
      const signingWallet = {
        authorize: async () => ({
          accounts: [{ address: Buffer.from(new PublicKey(owner).toBytes()).toString('base64') }],
          auth_token: 'test-token',
        }),
        deauthorize: async () => undefined,
        signAndSendTransactions: async () => ['confirmed-signature'],
        signTransactions: async ({ transactions }: { transactions: import('@solana/web3.js').Transaction[] }) => transactions,
      };
      const transact: import('./wallet').TransactFn = async (callback) => callback(signingWallet);
      await act(async () => {
        if (later === 'connect') await connect(transact, store);
        if (later === 'disconnect') await disconnect(transact, store);
        if (later === 'partial sign') {
          const { signHoldPartial } = await import('./holdSign');
          const tx = new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: owner });
          await signHoldPartial(transact, store, tx);
        }
        if (later === 'account selection') {
          const { exposedWalletAccounts } = await import('./holdSign');
          laterWalletTransact = transact;
          try { await exposedWalletAccounts(); } finally { laterWalletTransact = null; }
        }
        if (later === 'sign') await signAndSendTransactions(transact, store, [new Transaction()], {
          lookup: async () => 'confirmed',
        });
      });
    }
    assert.doesNotMatch(textOf(root), /The wallet cancelled the request/);
    await act(async () => {
      byLabel(root, 'Press and hold to close this rule').props.onLongPress();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.match(textOf(root), /The wallet cancelled the request/, 'a new failure still appears');
    await act(async () => root.unmount());
  });
}

for (const permission of [null, { granted: false, canAskAgain: false }, { granted: true, canAskAgain: true }]) {
  test(`payee paste validates inline and returns to approval with camera ${permission?.granted ?? 'loading'}`, async () => {
    const Screen = (await import('../app/scan')).default;
    const { takeAddressScan } = await import('./scanHandoff');
    route.current = { target: 'payee' };
    camera.permission = permission;
    navigation.length = 0;
    takeAddressScan('payee');
    const root = await mount(createElement(Screen));
    try {
      assert.doesNotMatch(textOf(root), /Write the rule yourself/);
      const input = root.root.findAll((node) => (node.type as unknown) === 'TextInput')
        .find((node) => node.props.accessibilityLabel === 'Payee address');
      assert.ok(input, 'payee address can be pasted without camera access');
      await act(async () => input.props.onChangeText('not-an-address'));
      await act(async () => byLabel(root, 'Use payee address').props.onPress());
      assert.match(textOf(root), /Enter a valid payee address/);
      assert.equal(takeAddressScan('payee'), null);
      assert.deepEqual(navigation, []);
      const address = key();
      await act(async () => input.props.onChangeText(`  ${address}  `));
      await act(async () => byLabel(root, 'Use payee address').props.onPress());
      assert.equal(takeAddressScan('payee'), address);
      assert.deepEqual(navigation, ['back']);
    } finally {
      await act(async () => root.unmount());
    }
  });
}

test('a 2 USDC rule with 0.5 per payment describes its 30 budget blocks accurately', async () => {
  const Screen = (await import('../app/rule/[address]')).default;
  const row = mandate({ mint: DEVNET_USDC_MINT, cap: 2000000n, perTxMax: 500000n, spent: 0n });
  route.current = { address: row.address };
  chain.mandateStatus = 'present';
  chain.error = null;
  chain.mandate = row;
  chain.mandates = [row];
  const previousDecimals = chain.decimals;
  chain.decimals = 6;
  const root = await mount(createElement(Screen));
  try {
    const blocks = root.root.findAll((node) => (node.type as unknown) === 'View' && /^block-\d+$/.test(node.props.testID ?? ''));
    assert.equal(blocks.length, 30);
    assert.match(textOf(root), /1 block is 1\/30 of your 2 USDC cap/);
    assert.match(textOf(root), /0.5 USDC at a time/);
    assert.doesNotMatch(textOf(root), /1 block = one payment/);
  } finally {
    chain.decimals = previousDecimals;
    await act(async () => root.unmount());
  }
});


test('payee scanning stays in approval after rejecting a rule request code', async () => {
  const Screen = (await import('../app/scan')).default;
  const { takeAddressScan } = await import('./scanHandoff');
  route.current = { target: 'payee' };
  camera.permission = { granted: true, canAskAgain: true };
  navigation.length = 0;
  takeAddressScan('payee');
  const root = await mount(createElement(Screen));
  try {
    const cameraNode = root.root.findAll((node) => (node.type as unknown) === 'CameraView')[0];
    assert.ok(cameraNode);
    await act(async () => cameraNode.props.onBarcodeScanned({ data: 'veto://rule-request?v=1' }));
    assert.deepEqual(navigation, []);
    assert.match(textOf(root), /That code is not an address/);
    const address = key();
    await act(async () => cameraNode.props.onBarcodeScanned({ data: address }));
    assert.equal(takeAddressScan('payee'), address);
    assert.deepEqual(navigation, ['back']);
    await act(async () => cameraNode.props.onBarcodeScanned({ data: key() }));
    assert.equal(takeAddressScan('payee'), null);
    assert.deepEqual(navigation, ['back']);
  } finally {
    await act(async () => root.unmount());
  }
});

function inputByLabel(root: ReactTestRenderer, label: string): ReactTestInstance {
  const input = root.root.findAll((node) => (node.type as unknown) === 'TextInput')
    .find((node) => node.props.accessibilityLabel === label);
  assert.ok(input, `missing ${label} field`);
  return input;
}

for (const firstRun of [false, true]) {
  test(`pasting a payee keeps the draft Agent field and its value${firstRun ? ' in first-run approval' : ' after Write a rule'}`, async () => {
    const Rules = (await import('../app/(tabs)/rules')).default;
    const Approval = firstRun
      ? (await import('../app/first-run/approve')).default
      : (await import('../app/rule/new')).default;
    const Scan = (await import('../app/scan')).default;
    const { ApprovalScreen } = await import('../components/ApprovalScreen');
    route.current = {};
    focused = true;
    navigation.length = 0;
    if (!firstRun) {
      const rules = await mount(createElement(Rules));
      await act(async () => byLabel(rules, 'Write a rule').props.onPress());
      assert.equal(navigation.at(-1), '/rule/new');
      await act(async () => rules.unmount());
    }
    const draft = await mount(createElement(Approval));
    let scan: ReactTestRenderer | null = null;
    try {
      const agent = key();
      const payee = key();
      await act(async () => inputByLabel(draft, 'Agent').props.onChangeText(agent));
      await act(async () => inputByLabel(draft, 'Purpose').props.onChangeText('Weekly supplies'));
      await act(async () => byLabel(draft, 'Edit who your agent may pay').props.onPress());
      assert.equal(navigation.at(-1), '/scan?target=payee');
      focused = false;
      await act(async () => draft.update(createElement(Approval)));
      route.current = { target: 'payee' };
      camera.permission = { granted: false, canAskAgain: false };
      scan = await mount(createElement(Scan));
      await act(async () => inputByLabel(scan!, 'Payee address').props.onChangeText(` ${payee} `));
      await act(async () => byLabel(scan!, 'Use payee address').props.onPress());
      assert.equal(navigation.at(-1), 'back');
      route.current = {};
      focused = true;
      await act(async () => draft.update(createElement(Approval)));
      assert.equal(inputByLabel(draft, 'Agent').props.value, agent);
      assert.equal(inputByLabel(draft, 'Payee').props.value, payee);
      assert.equal(inputByLabel(draft, 'Purpose').props.value, 'Weekly supplies');
      assert.equal(draft.root.findByType(ApprovalScreen).props.mode, 'template');
      assert.equal(draft.root.findByType(ApprovalScreen).props.request, null);
      if (firstRun) {
        assert.ok(draft.root.findAll((node) =>
          node.props.accessibilityLabel === 'Approve the rule, current step').length > 0);
      }
    } finally {
      focused = true;
      await act(async () => { scan?.unmount(); draft.unmount(); });
    }
  });
}

test('a genuine scanned rule request opens request mode with the requested agent and payee', async () => {
  const Scan = (await import('../app/scan')).default;
  const Request = (await import('../app/rule-request')).default;
  const { ApprovalScreen } = await import('../components/ApprovalScreen');
  const agent = key();
  const payee = key();
  const url = `veto://rule-request?v=1&agent=${agent}&payee=${payee}&mint=${chain.config.mint}&cap=80&max=12&days=7&purpose=Weekly%20supplies`;
  route.current = { target: 'request' };
  camera.permission = { granted: true, canAskAgain: true };
  navigation.length = 0;
  const scan = await mount(createElement(Scan));
  let approval: ReactTestRenderer | null = null;
  try {
    const cameraNode = scan.root.findAll((node) => (node.type as unknown) === 'CameraView')[0];
    await act(async () => cameraNode.props.onBarcodeScanned({ data: url }));
    const destination = navigation.at(-1)!;
    assert.equal(destination, `/rule-request?url=${encodeURIComponent(url)}`);
    route.current = Object.fromEntries(new URLSearchParams(destination.split('?')[1]));
    approval = await mount(createElement(Request));
    const props = approval.root.findByType(ApprovalScreen).props;
    assert.equal(props.mode, 'request');
    assert.equal(props.request.agent, agent);
    assert.equal(props.request.payee, payee);
    assert.equal(approval.root.findAll((node) => (node.type as unknown) === 'TextInput'
      && node.props.accessibilityLabel === 'Agent').length, 0);
    assert.match(textOf(approval), /Weekly supplies/);
    assert.match(textOf(approval), /asks you for this rule/);
  } finally {
    await act(async () => { scan.unmount(); approval?.unmount(); });
  }
});
