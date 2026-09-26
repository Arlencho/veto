import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { space } from '../components/theme';
import { KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE } from './constants';
import type { MandateAccount } from './mandate';
import type { LedgerRow } from './ring';
import { VTEST_MINT } from './tokens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const motion = { reduced: true };
const shared: { message?: string; title?: string }[] = [];
const nav = { push: [] as string[], back: 0 };
let params: { id?: string } = {};
let chainState: Record<string, unknown>;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

function timing() {
  return {
    start(cb?: (result: { finished: boolean }) => void) {
      cb?.({ finished: true });
    },
    stop() {},
  };
}

mock.module('react-native', {
  namedExports: {
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(motion.reduced),
      addEventListener: () => ({ remove() {} }),
    },
    ActivityIndicator: Host('ActivityIndicator'),
    Animated: {
      Value: class AnimatedValue {
        _value: number;
        constructor(value: number) {
          this._value = value;
        }
        setValue(value: number) {
          this._value = value;
        }
        interpolate() {
          return 0;
        }
      },
      View: Host('Animated.View'),
      Text: Host('Animated.Text'),
      timing,
      delay: timing,
      sequence: () => timing(),
      loop: (inner: { start: () => void; stop: () => void }) => inner,
      createAnimatedComponent: (Component: unknown) => Component,
    },
    Easing: {
      linear: (amount: number) => amount,
      bezier: () => (amount: number) => amount,
      out: (easing: (amount: number) => number) => easing,
      inOut: (easing: (amount: number) => number) => easing,
    },
    Keyboard: { addListener: () => ({ remove() {} }) },
    KeyboardAvoidingView: Host('KeyboardAvoidingView'),
    Linking: { openURL: async () => undefined },
    Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
    Pressable: Host('Pressable'),
    RefreshControl: Host('RefreshControl'),
    ScrollView: Host('ScrollView'),
    Share: {
      share: async (payload: { message?: string; title?: string }) => {
        shared.push(payload);
      },
    },
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
      hairlineWidth: 1,
      absoluteFill: {},
    },
    Text: Host('Text'),
    TextInput: Host('TextInput'),
    UIManager: {},
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
    useLocalSearchParams: () => params,
    usePathname: () => '/help',
    useFocusEffect: () => undefined,
    useNavigation: () => ({
      getState: () => ({ routes: [{ name: 'help/export' }] }),
    }),
    useRouter: () => ({
      push: (href: string) => {
        nav.push.push(href);
      },
      back: () => {
        nav.back += 1;
      },
      replace: () => undefined,
      dismiss: () => undefined,
      canDismiss: () => false,
    }),
  },
});

mock.module('../components/ConnectGate', {
  namedExports: {
    ConnectGate: (props: { children?: ReactNode }) => props.children ?? null,
  },
});

mock.module('./useChain', {
  namedExports: {
    useChain: () => chainState,
  },
});

function mandate(over: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: 'Mandate1111111111111111111111111111111111111',
    owner: 'Owner111111111111111111111111111111111111111',
    agent: 'Agent111111111111111111111111111111111111111',
    mint: VTEST_MINT,
    source: 'Source11111111111111111111111111111111111111',
    merchant: 'Payee11111111111111111111111111111111111111',
    mandateId: 1n,
    cap: 300n,
    spent: 42n,
    perTxMax: 10n,
    expiresAt: 5_000n,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 1n,
    purpose: 'Charging top-ups at the SE3 spot rate',
    status: STATUS_ACTIVE,
    spendCount: 1,
    refusalCount: 1,
    bump: 1,
    ...over,
  };
}

function refusedRow(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: 1_700n,
    amount: 14n,
    counterparty: 'Payee11111111111111111111111111111111111111',
    nonce: 2n,
    suggestedOverride: 14n,
    kind: KIND_REFUSED,
    kindName: 'refused',
    reason: REASON_OVER_PER_TX_MAX,
    reasonText: 'over per-payment maximum',
    signature: 'Signature111111111111111111111111111111111111',
    ...over,
  };
}

function paidRow(): LedgerRow {
  return {
    ts: BigInt(Math.floor(Date.now() / 1000)),
    amount: 8n,
    counterparty: 'Payee11111111111111111111111111111111111111',
    nonce: 3n,
    suggestedOverride: 0n,
    kind: KIND_PAID,
    kindName: 'paid',
    reason: 0,
    reasonText: 'ok',
    signature: 'PaidSig11111111111111111111111111111111111111',
  };
}

function baseChain(over: Record<string, unknown> = {}) {
  const rule = mandate();
  return {
    ready: true,
    loading: false,
    error: null,
    rateLimited: false,
    checkedOwner: rule.owner,
    mandateStatus: 'present',
    config: {
      rpcUrl: 'http://127.0.0.1:8899',
      programId: 'Prog111111111111111111111111111111111111111',
      mint: null,
      explorerCluster: 'devnet',
      mintDecimals: 0,
    },
    configError: null,
    mandate: rule,
    mandates: [rule],
    snapshot: null,
    rows: [],
    decimals: 0,
    nowMs: 1_500_000,
    genesisHash: 'genesis-hash',
    submitHeld: false,
    refresh: async () => undefined,
    selectMandate: async () => undefined,
    open: async () => undefined,
    revoke: async () => undefined,
    close: async () => undefined,
    probeOverride: async () => ({ status: 'none', why: 'not this row' }),
    grantOverride: async () => {
      throw new Error('You cancelled the wallet request.');
    },
    ...over,
  };
}

function textIn(node: ReactTestInstance): string {
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
  walk(node.props.children);
  return bits.join('');
}

function visibleText(root: ReactTestRenderer): string {
  return root.root
    .findAll((candidate) => (candidate.type as unknown) === 'Text')
    .map((node) => textIn(node))
    .filter((line) => line.length > 0)
    .join('\n');
}

function pressable(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => (candidate.type as unknown) === 'Pressable')
    .find((candidate) => String(candidate.props.accessibilityLabel ?? '') === label || String(candidate.props.accessibilityLabel ?? '').includes(label));
  assert.ok(node, `no control labelled ${label}`);
  return node;
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  assert.ok(root);
  return root;
}

test.beforeEach(() => {
  motion.reduced = true;
  shared.length = 0;
  nav.push.length = 0;
  nav.back = 0;
  params = {};
  chainState = baseChain();
});

test('decisions shows the chain read while the rule has not been read', async () => {
  chainState = baseChain({ mandateStatus: 'not-read', mandate: null, mandates: [] });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const text = visibleText(await mount(createElement(Decisions)));
  assert.match(text, /Reading the chain for this owner/);
  assert.doesNotMatch(text, /Decisions under the rule/);
});

test('decisions says when this owner has no rule', async () => {
  chainState = baseChain({ mandateStatus: 'empty', mandate: null, mandates: [] });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const text = visibleText(await mount(createElement(Decisions)));
  assert.match(text, /No rule on chain for this owner/);
});

const UNPROVEN_CLAIM =
  /no rule live|no rule yet|no rules yet|no decisions|no agent|nothing on chain|no rule on chain|open your first rule/i;

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

function textLines(root: ReactTestRenderer): string[] {
  return root.root
    .findAll((candidate) => (candidate.type as unknown) === 'Text')
    .map((node) => textIn(node))
    .filter((line) => line.length > 0);
}

test('decisions while the chain is rate limited says the blockchain is busy and claims nothing was proven', async () => {
  chainState = baseChain({
    mandateStatus: 'rate-limited',
    loading: true,
    mandate: null,
    mandates: [],
    rows: [],
    error: 'The RPC refused this read.',
  });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const root = await mount(createElement(Decisions));
  const text = visibleText(root);
  assert.match(text, /The blockchain is busy right now\. Veto keeps trying\./);
  assert.match(text, /Reading\.\.\./);
  assert.doesNotMatch(text, /RPC/);
  assert.doesNotMatch(text, UNPROVEN_CLAIM);
});

test('decisions after a failed read says to pull down and does not claim there are no decisions', async () => {
  chainState = baseChain({
    mandateStatus: 'failed',
    loading: false,
    mandate: null,
    mandates: [],
    rows: [],
    error: 'The RPC refused this read.',
  });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const text = visibleText(await mount(createElement(Decisions)));
  assert.match(text, /Could not reach the blockchain\. Pull down to try again\./);
  assert.match(text, /Could not read/);
  assert.doesNotMatch(text, /RPC/);
  assert.doesNotMatch(text, UNPROVEN_CLAIM);
});

test('decisions after a successful read shows the decision and that one rule is live', async () => {
  const rule = mandate();
  chainState = baseChain({
    mandateStatus: 'present',
    loading: false,
    error: null,
    mandate: rule,
    mandates: [rule],
    rows: [paidRow()],
  });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const text = visibleText(await mount(createElement(Decisions)));
  assert.match(text, /Charging top-ups/);
  assert.match(text, /Paid/);
  assert.match(text, /1 rule live/);
  assert.doesNotMatch(text, /Could not read/);
  assert.doesNotMatch(text, /blockchain is busy/);
});

test('decisions draws the reading line below the header with the screen padding', async () => {
  chainState = baseChain({ mandateStatus: 'not-read', loading: true, mandate: null, mandates: [], error: null });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const root = await mount(createElement(Decisions));
  const lines = textLines(root);
  const veto = lines.findIndex((line) => line.includes('Veto'));
  const reading = lines.findIndex((line) => line.includes('Reading the chain.'));
  assert.ok(veto >= 0, lines.join(' | '));
  assert.ok(reading > veto, lines.join(' | '));
  const readingNode = root.root.findAll((candidate) => (candidate.type as unknown) === 'Text').find((candidate) => {
    return textIn(candidate).includes('Reading the chain.');
  });
  assert.ok(readingNode);
  assert.equal(hasScreenInset(readingNode), true);
});

test('decisions shows a failed read and hides it while the RPC is only rate limiting', async () => {
  chainState = baseChain({
    mandateStatus: 'failed',
    mandate: null,
    mandates: [],
    error: 'The RPC refused this read.',
  });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const failed = visibleText(await mount(createElement(Decisions)));
  assert.match(failed, /Could not reach the blockchain/);
  assert.match(failed, /Pull down to try again/);
  assert.doesNotMatch(failed, /RPC/);

  chainState = baseChain({
    mandateStatus: 'rate-limited',
    mandate: null,
    mandates: [],
    error: 'The RPC refused this read.',
  });
  const limited = visibleText(await mount(createElement(Decisions)));
  assert.match(limited, /The blockchain is busy right now/);
  assert.doesNotMatch(limited, /RPC/);
});

test('loading decisions does not raise the pull spinner, and the header names Export without a brass blob', async () => {
  let pulls = 0;
  chainState = baseChain({
    loading: true,
    refresh: async () => {
      pulls += 1;
    },
  });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const root = await mount(createElement(Decisions));
  const scroll = root.root.findAll((node) => (node.type as unknown) === 'ScrollView')[0];
  assert.ok(scroll);
  const control = scroll.props.refreshControl;
  assert.ok(control);
  assert.equal(control.props.refreshing, false);
  assert.equal(control.props.progressBackgroundColor, '#0F1A16');
  const text = visibleText(root);
  assert.match(text, /Reading the chain/);
  assert.match(text, /Export/);
  assert.doesNotMatch(text, /↑/);
  const brass = root.root.findAll((node) => {
    const style = node.props.style;
    return style && !Array.isArray(style) && style.backgroundColor === 'rgba(201, 162, 77, 0.16)';
  });
  assert.equal(brass.length, 0);
  await act(async () => {
    control.props.onRefresh();
  });
  assert.equal(pulls, 1);
});

test('the decision list shows the payee and two decimals, and the detail keeps the exact amount', async () => {
  const row = paidRow();
  row.amount = 15_152_750n;
  row.counterparty = '2bt9bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbay7F';
  const rule = mandate({ perTxMax: 10_000_000n, cap: 300_000_000n, spent: 0n });
  chainState = baseChain({ decimals: 6, rows: [row], mandate: rule, mandates: [rule] });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const list = visibleText(await mount(createElement(Decisions)));
  assert.match(list, /Paid 15\.15 VTEST to Paye\.\.\.1111/);
  assert.match(list, /See it on the blockchain/);
  assert.doesNotMatch(list, /15\.15275|2bt9|RPC/);
  params = { id: `${rule.address}:${row.ts.toString()}:${row.kind}:${row.nonce.toString()}` };
  const { default: Detail } = await import('../app/decision/[id]');
  const detail = visibleText(await mount(createElement(Detail)));
  assert.match(detail, /15\.15275/);
});

test('decisions lists paid and refused rows in plain words and the filter keeps one kind', async () => {
  const paid = paidRow();
  paid.ts = 1_700n;
  const refused = refusedRow({ ts: 1_700n });
  chainState = baseChain({ nowMs: 1_500_000, rows: [paid, refused] });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  const root = await mount(createElement(Decisions));
  const text = visibleText(root);
  assert.match(text, /Decisions under the rule/);
  assert.match(text, /Paid 8 VTEST to Paye\.\.\.1111/);
  assert.match(text, /Inside your limit of 10 VTEST per payment/);
  assert.match(text, /Refused: your agent asked 14 VTEST, your limit is 10 VTEST per payment/);
  assert.match(text, /No money moved\. Reason saved on the blockchain/);
  assert.match(text, /258 VTEST left of your 300 VTEST total/);
  await act(async () => {
    pressable(root, 'Refused').props.onPress();
  });
  const filtered = visibleText(root);
  assert.match(filtered, /Refused: your agent asked 14/);
  assert.doesNotMatch(filtered, /Paid 8 VTEST to/);
});

test('one decision shows what was asked, that nothing moved, and the chain record', async () => {
  const rule = mandate();
  const row = refusedRow();
  params = { id: `${rule.address}:1700:2:2` };
  const { assessOverride } = await import('./override');
  chainState = baseChain({
    mandate: rule,
    mandates: [rule],
    rows: [row],
    probeOverride: async () =>
      assessOverride({
        row,
        mandate: rule,
        decimals: 0,
        nowSec: 1_500n,
      }),
  });
  const { default: Detail } = await import('../app/decision/[id]');
  const root = await mount(createElement(Detail));
  const text = visibleText(root);
  assert.match(text, /No money moved/);
  assert.match(text, /Your agent asked to pay 14 VTEST/);
  assert.match(text, /Your rule allows 10 VTEST per payment/);
  assert.match(text, /Money moved/);
  assert.match(text, /Over your per-payment limit of 10 VTEST/);
  assert.match(text, /Saved on the blockchain/);
  assert.match(text, /This one payment only: 14 VTEST to Paye\.\.\.1111/);
  assert.match(text, /Your limit stays 10 VTEST per payment/);
  assert.match(text, /258 VTEST now, 244 VTEST after it is paid/);
  assert.match(text, /Press and hold to allow this one payment of 14 VTEST/);
});

test('a refusal whose ledger names the payee token account shows the rule payee on screen', async () => {
  const payee = '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG';
  const tokenAccount = '2bt9bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbay7F';
  const rule = mandate({ merchant: payee });
  const row = refusedRow({ counterparty: tokenAccount });
  params = { id: `${rule.address}:1700:2:2` };
  const { assessOverride } = await import('./override');
  chainState = baseChain({
    mandate: rule,
    mandates: [rule],
    rows: [row],
    probeOverride: async () =>
      assessOverride({
        row,
        mandate: rule,
        decimals: 0,
        nowSec: 1_500n,
      }),
  });
  const { default: Detail } = await import('../app/decision/[id]');
  const text = visibleText(await mount(createElement(Detail)));
  assert.match(text, /To payee\n6i99\.\.\.PdCG/);
  assert.match(text, /This one payment only: 14 VTEST to 6i99\.\.\.PdCG/);
  assert.match(text, /Payee token account\n2bt9\.\.\.ay7F/);
  assert.doesNotMatch(text, /to 2bt9/);
  assert.equal((text.match(/2bt9/g) ?? []).length, 1);
});

test('a cancelled or failed allow-once signature arms the hold again', async () => {
  const rule = mandate();
  const row = refusedRow();
  params = { id: `${rule.address}:1700:2:2` };
  let grants = 0;
  const { assessOverride } = await import('./override');
  chainState = baseChain({
    mandate: rule,
    mandates: [rule],
    rows: [row],
    probeOverride: async () =>
      assessOverride({ row, mandate: rule, decimals: 0, nowSec: 1_500n }),
    grantOverride: async () => {
      grants += 1;
      throw new Error('You cancelled the wallet request.');
    },
  });
  const { default: Detail } = await import('../app/decision/[id]');
  const { HoldToApprove } = await import('../components/backglass/HoldToApprove');
  const root = await mount(createElement(Detail));
  const before = root.root.findByType(HoldToApprove);
  assert.equal(before.props.resetKey, 0);
  await act(async () => {
    pressable(root, 'Press and hold to allow this one payment of 14').props.onAccessibilityAction({
      nativeEvent: { actionName: 'longpress' },
    });
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  assert.equal(grants, 1);
  const text = visibleText(root);
  assert.match(text, /You cancelled the wallet request/);
  const afterFail = root.root.findByType(HoldToApprove);
  assert.equal(afterFail.props.resetKey, 1);
  await act(async () => {
    pressable(root, 'Cancel').props.onPress();
  });
  assert.equal(root.root.findByType(HoldToApprove).props.resetKey, 2);
});

test('a held signature does not start another allow-once signature', async () => {
  const rule = mandate();
  const row = refusedRow();
  params = { id: `${rule.address}:1700:2:2` };
  let grants = 0;
  const { assessOverride } = await import('./override');
  chainState = baseChain({
    mandate: rule,
    mandates: [rule],
    rows: [row],
    submitHeld: true,
    probeOverride: async () =>
      assessOverride({ row, mandate: rule, decimals: 0, nowSec: 1_500n }),
    grantOverride: async () => {
      grants += 1;
      throw new Error('should not sign');
    },
  });
  const { default: Detail } = await import('../app/decision/[id]');
  const { HoldToApprove } = await import('../components/backglass/HoldToApprove');
  const root = await mount(createElement(Detail));
  const hold = root.root.findByType(HoldToApprove);
  assert.equal(hold.props.disabled, true);
  await act(async () => {
    pressable(root, 'Press and hold to allow this one payment of 14').props.onAccessibilityAction({
      nativeEvent: { actionName: 'longpress' },
    });
  });
  assert.equal(grants, 0);
});

test('a missing decision says the ring does not have it', async () => {
  const rule = mandate();
  params = { id: `${rule.address}:1700:2:99` };
  chainState = baseChain({ mandate: rule, mandates: [rule], rows: [refusedRow()] });
  const { default: Detail } = await import('../app/decision/[id]');
  const text = visibleText(await mount(createElement(Detail)));
  assert.match(text, /not on the ring for the selected rule/);
});

test('a decision stays unread until the chain read finishes, and a failed read is not an empty ring', async () => {
  params = { id: 'Mandate1111111111111111111111111111111111111:1700:2:2' };
  chainState = baseChain({ mandateStatus: 'not-read', mandate: null, mandates: [] });
  const { default: Detail } = await import('../app/decision/[id]');
  const loading = visibleText(await mount(createElement(Detail)));
  assert.match(loading, /Reading the chain for this owner/);

  chainState = baseChain({ mandateStatus: 'failed', mandate: null, mandates: [], error: null });
  const failed = visibleText(await mount(createElement(Detail)));
  assert.match(failed, /Could not reach the blockchain/);
  assert.doesNotMatch(failed, /not on the ring/);
});

test('share explains a missing rule, a failed read, and a decision from another rule', async () => {
  const { default: ShareScreen } = await import('../app/share');
  chainState = baseChain({ mandateStatus: 'not-read', mandate: null, mandates: [] });
  assert.match(visibleText(await mount(createElement(ShareScreen))), /Reading the chain for this owner/);

  chainState = baseChain({ mandateStatus: 'empty', mandate: null, mandates: [] });
  assert.match(
    visibleText(await mount(createElement(ShareScreen))),
    /No rule is selected\. Switch on the Rules tab first/,
  );

  chainState = baseChain({ mandateStatus: 'failed', mandate: null, mandates: [], error: null });
  assert.match(visibleText(await mount(createElement(ShareScreen))), /Could not reach the blockchain/);

  const rule = mandate();
  params = { id: 'OtherMandate1111111111111111111111111111111:1700:2:2' };
  chainState = baseChain({ mandate: rule, mandates: [rule], mandateStatus: 'present' });
  const mismatch = visibleText(await mount(createElement(ShareScreen)));
  assert.match(mismatch, /This decision belongs to a rule that is not selected/);
  assert.doesNotMatch(mismatch, /Export the record/);
});

test('share saves a CSV of this decision and can share the blockchain link', async () => {
  const rule = mandate();
  const row = refusedRow();
  params = { id: `${rule.address}:1700:2:2` };
  chainState = baseChain({ mandate: rule, mandates: [rule], rows: [row] });
  const { default: ShareScreen } = await import('../app/share');
  const root = await mount(createElement(ShareScreen));
  const text = visibleText(root);
  assert.match(text, /Export the record/);
  assert.match(text, /Charging top-ups at the SE3 spot rate/);
  assert.match(text, /This decision/);
  assert.match(text, /What the file proves/);
  assert.match(text, /1 signed row in this file/);
  await act(async () => {
    pressable(root, 'Save this decision as a CSV file').props.onPress();
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  assert.equal(shared.length, 1);
  assert.match(shared[0]?.message ?? '', /Signature111111111111111111111111111111111111/);
  assert.match(shared[0]?.message ?? '', /completeness/);
  await act(async () => {
    pressable(root, 'Share the blockchain link instead').props.onPress();
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  assert.match(shared[1]?.message ?? '', /explorer\.solana\.com\/tx\/Signature111111111111111111111111111111111111/);
});

test('help home, the refusal page, and the export page say what a rule, a refusal, and a file prove', async () => {
  const [home, refusal, exported] = await Promise.all([
    import('../app/help/index'),
    import('../app/help/refusal'),
    import('../app/help/export'),
  ]);
  const homeText = visibleText(await mount(createElement(home.default)));
  assert.match(homeText, /Your agent can only ask/);
  assert.match(homeText, /What a rule is/);
  assert.match(homeText, /What a refusal is/);
  assert.match(homeText, /What the export proves/);
  assert.match(homeText, /Show the introduction again/);
  assert.match(homeText, /allows one payment, used once, never above the remaining cap/);

  const refusalText = visibleText(await mount(createElement(refusal.default)));
  assert.match(refusalText, /Why a refusal is recorded/);
  assert.match(refusalText, /allows one payment, used once, never above the remaining cap/);
  assert.match(refusalText, /A refusal is a success/);

  const exportText = visibleText(await mount(createElement(exported.default)));
  assert.match(exportText, /What the export proves/);
  assert.match(exportText, /CSV opens in a spreadsheet/);
  assert.match(exportText, /complete over payments, never over attempts/);
});

for (const reason of [11, 12, 13, 14]) {
  test(`trade refusal ${reason} labels the account according to what the ledger records`, async () => {
    const rule = mandate();
    const row = refusedRow({ family: 'trade', reason });
    params = { id: `${rule.address}:1700:2:2` };
    chainState = baseChain({ mandate: rule, mandates: [rule], rows: [row] });
    const { default: Detail } = await import('../app/decision/[id]');
    const root = await mount(createElement(Detail));
    const text = visibleText(root);
    assert.match(text, reason <= 12 ? /Tried account/ : /Output account/);
    assert.doesNotMatch(text, reason <= 12 ? /Output account/ : /Tried account/);
  });
}

test('the trade detail headline preserves every base unit', async () => {
  const { WSOL_MINT, DEVNET_USDC_MINT } = await import('./tokens');
  const row = { ...paidRow(), family: 'trade' as const, amount: 999_994n,
    amountOut: 10_992_000n, outDecimals: 6, outMint: DEVNET_USDC_MINT };
  const rule = mandate({ mint: WSOL_MINT, perTxMax: 1_996_000n });
  chainState = baseChain({ decimals: 9, rows: [row], mandate: rule, mandates: [rule] });
  params = { id: `${rule.address}:${row.ts}:${row.kind}:${row.nonce}` };
  const { default: Detail } = await import('../app/decision/[id]');
  const root = await mount(createElement(Detail));
  assert.ok(textLines(root).includes('Traded 0.000999994 wrapped SOL for 10.992 USDC.'));
});

test('the decisions balance never rounds remaining USDC up', async () => {
  const { DEVNET_USDC_MINT } = await import('./tokens');
  const rule = mandate({ mint: DEVNET_USDC_MINT, cap: 1_000_000n, spent: 4_000n });
  chainState = baseChain({ decimals: 6, rows: [paidRow()], mandate: rule, mandates: [rule] });
  const { default: Decisions } = await import('../app/(tabs)/decisions');
  assert.match(visibleText(await mount(createElement(Decisions))), /0\.99 USDC left of your/);
});
