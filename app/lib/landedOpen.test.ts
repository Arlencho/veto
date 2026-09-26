import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  type Connection,
  type Transaction,
} from '@solana/web3.js';
import { useEffect, type ComponentType, type ReactNode } from 'react';
import { tokenSymbol } from './tokens';
import { act, createElement } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import {
  LEDGER_ACCOUNT_SIZE,
  LEDGER_DISCRIMINATOR,
  LEDGER_HEADER_SIZE,
  MANDATE_ACCOUNT_SIZE,
  MANDATE_DISCRIMINATOR,
  KIND_OVERRIDE,
  KIND_REFUSED,
  REASON_OVER_PER_TX_MAX,
  STATUS_ACTIVE,
  STATUS_REVOKED,
  writeI64Le,
  writeU32Le,
  writeU64Le,
} from './constants';
import type { MandateAccount } from './mandate';
import type { LedgerRow } from './ring';
import { ledgerPda } from './ring';
import { signatureNotYetVisibleMessage } from './wallet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = Keypair.generate().publicKey;
const AGENT = Keypair.generate();
const MERCHANT = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const PROGRAM = Keypair.generate().publicKey;
const SIG = 'landed-sig';
const TOKEN_RENT = 2_039_280;
const MANDATE_RENT = 3_474_240;
const LEDGER_RENT = 11_349_200;
const SOL = 50_000_000;

const nav = { replaces: [] as string[], pushes: [] as string[] };
const params: Record<string, string> = { ruleset: 'new' };
const listeners = new Set<() => void>();
let permissionGranted = false;
let alreadyAsked = false;
let askCalls = 0;
let afterSign: (txs: Transaction[]) => void = () => undefined;
let held: { mandate: MandateAccount; bytes: Buffer }[] = [];
let ledgerEntry: Buffer | null = null;
let api: {
  ready: boolean;
  error: string | null;
  config: unknown;
  mandate: { address: string } | null;
  open: (input: {
    merchant: PublicKey;
    agent?: PublicKey;
    cap: bigint;
    perTxMax: bigint;
    expiresAt: bigint;
    purpose: string;
  }) => Promise<unknown>;
  close: () => Promise<unknown>;
  revoke: () => Promise<unknown>;
  grantOverride: (address: string, row: LedgerRow) => Promise<unknown>;
  refresh: () => Promise<void>;
} | null = null;
let signCalls = 0;
let signatureRow: { err: null; confirmationStatus: string } | null = {
  err: null,
  confirmationStatus: 'finalized',
};

type Mode = 'overview' | 'rules' | 'decisions' | 'new' | 'rule';
let mode: Mode = 'overview';

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

function useFocusEffect(effect: () => void | (() => void)) {
  useEffect(() => {
    let cleanup: void | (() => void);
    const run = () => {
      if (typeof cleanup === 'function') cleanup();
      cleanup = effect();
    };
    listeners.add(run);
    run();
    return () => {
      listeners.delete(run);
      if (typeof cleanup === 'function') cleanup();
    };
  }, [effect]);
}

function refocus(): void {
  for (const run of [...listeners]) run();
}

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
    cb?.({ finished: false });
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
      Text: Host('Animated.Text'),
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
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    KeyboardAvoidingView: Host('KeyboardAvoidingView'),
    Linking: { openURL: async () => undefined },
    Platform: { OS: 'ios' },
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
    UIManager: { measureLayout: () => undefined },
    View: Host('View'),
    findNodeHandle: () => null,
    PanResponder: { create: () => ({ panHandlers: {} }) },
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
    usePathname: () => '/',
    useRouter: () => ({
      push: (href: string) => {
        nav.pushes.push(href);
      },
      replace: (href: string) => {
        nav.replaces.push(href);
      },
      back: () => undefined,
    }),
    useFocusEffect,
    Stack: Host('Stack'),
    Tabs: Host('Tabs'),
  },
});

mock.module('expo-constants', {
  defaultExport: {
    expoConfig: {
      extra: {
        vetoRpc: 'http://127.0.0.1:8899',
        vetoProgramId: PROGRAM.toBase58(),
        vetoMint: MINT.toBase58(),
        vetoExplorerCluster: 'devnet',
        vetoMintDecimals: '6',
      },
    },
  },
});

mock.module('expo-clipboard', {
  namedExports: {
    getStringAsync: async () => '',
    setStringAsync: async () => undefined,
  },
});

mock.module('expo-notifications', {
  namedExports: {
    getPermissionsAsync: async () => ({ granted: permissionGranted }),
    requestPermissionsAsync: async () => {
      permissionGranted = true;
      return { granted: true };
    },
  },
});

mock.module('./decisionNotifyTask', {
  namedExports: {
    hasAskedForDecisionNotifications: async () => alreadyAsked,
    askAfterFirstRuleOpened: async () => {
      askCalls += 1;
    },
    scanDecisionsIfAllowed: async () => undefined,
  },
});

mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async () => null,
      setItem: async () => undefined,
      deleteItem: async () => undefined,
    },
  },
});

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({
      ready: true,
      busy: false,
      error: null,
      cluster: 'devnet',
      solanaMobileInstalled: false,
      ownerPublicKey: OWNER.toBase58(),
      agentPublicKey: AGENT.publicKey.toBase58(),
      connect: async () => undefined,
      disconnect: async () => undefined,
      signAndSend: async (txs: Transaction[]) => {
        signCalls += 1;
        afterSign(txs);
        return [SIG];
      },
      createAgentKeypair: async () => AGENT,
      getAgentKeypair: async () => AGENT,
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
      ready: true,
      rulesets: [],
      save: async () => {
        throw new Error('this test does not save a ruleset');
      },
    }),
  },
});

function mintData(): Buffer {
  const data = Buffer.alloc(82);
  data[44] = 6;
  return data;
}

function tokenData(amount: bigint): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

function encodeMandate(m: MandateAccount): Buffer {
  const purpose = Buffer.from(m.purpose, 'utf8');
  const buf = Buffer.alloc(8 + 32 * 5 + 8 * 8 + 4 + purpose.length + 1 + 4 + 4 + 1);
  let o = 0;
  MANDATE_DISCRIMINATOR.copy(buf, o);
  o += 8;
  for (const k of [m.owner, m.agent, m.mint, m.source, m.merchant]) {
    Buffer.from(new PublicKey(k).toBytes()).copy(buf, o);
    o += 32;
  }
  for (const v of [m.mandateId, m.cap, m.spent, m.perTxMax]) {
    writeU64Le(buf, o, v);
    o += 8;
  }
  writeI64Le(buf, o, m.expiresAt);
  o += 8;
  for (const v of [m.overrideAmount, m.overrideNonce, m.lastNonce]) {
    writeU64Le(buf, o, v);
    o += 8;
  }
  writeU32Le(buf, o, purpose.length);
  o += 4;
  purpose.copy(buf, o);
  o += purpose.length;
  buf[o] = m.status;
  o += 1;
  writeU32Le(buf, o, m.spendCount);
  o += 4;
  writeU32Le(buf, o, m.refusalCount);
  o += 4;
  buf[o] = m.bump;
  return buf;
}

function ledgerBytes(mandate: PublicKey): Buffer {
  const data = Buffer.alloc(LEDGER_ACCOUNT_SIZE);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  Buffer.from(mandate.toBytes()).copy(data, 8);
  data.writeUInt32LE(ledgerEntry ? 1 : 0, 40);
  data.writeUInt16LE(0, 44);
  data[46] = 255;
  if (ledgerEntry) {
    ledgerEntry.copy(data, 8 + LEDGER_HEADER_SIZE);
  }
  return data;
}

function entryBytes(args: {
  ts: bigint;
  amount: bigint;
  counterparty: PublicKey;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  reason: number;
}): Buffer {
  const raw = Buffer.alloc(72);
  raw.writeBigInt64LE(args.ts, 0);
  raw.writeBigUInt64LE(args.amount, 8);
  Buffer.from(args.counterparty.toBytes()).copy(raw, 16);
  raw.writeBigUInt64LE(args.nonce, 48);
  raw.writeBigUInt64LE(args.suggestedOverride, 56);
  raw[64] = args.kind;
  raw[65] = args.reason;
  return raw;
}

function mandateFromOpen(tx: Transaction): MandateAccount {
  const ix = tx.instructions.find((item) => item.programId.equals(PROGRAM));
  if (!ix) {
    throw new Error('the open transaction has no program instruction');
  }
  const data = Buffer.from(ix.data);
  const purposeLen = data.readUInt32LE(104);
  return {
    address: ix.keys[1]!.pubkey.toBase58(),
    owner: ix.keys[0]!.pubkey.toBase58(),
    agent: new PublicKey(data.subarray(16, 48)).toBase58(),
    mint: ix.keys[4]!.pubkey.toBase58(),
    source: ix.keys[3]!.pubkey.toBase58(),
    merchant: new PublicKey(data.subarray(48, 80)).toBase58(),
    mandateId: data.readBigUInt64LE(8),
    cap: data.readBigUInt64LE(80),
    spent: 0n,
    perTxMax: data.readBigUInt64LE(88),
    expiresAt: data.readBigInt64LE(96),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: data.subarray(108, 108 + purposeLen).toString('utf8'),
    status: STATUS_ACTIVE,
    spendCount: 0,
    refusalCount: 0,
    bump: 1,
  };
}

function publish(mandate: MandateAccount): void {
  held = [{ mandate, bytes: encodeMandate(mandate) }];
}

function seedMandate(over: Partial<MandateAccount> = {}): MandateAccount {
  const mandate: MandateAccount = {
    address: Keypair.generate().publicKey.toBase58(),
    owner: OWNER.toBase58(),
    agent: AGENT.publicKey.toBase58(),
    mint: MINT.toBase58(),
    source: Keypair.generate().publicKey.toBase58(),
    merchant: MERCHANT.toBase58(),
    mandateId: 4n,
    cap: 200n,
    spent: 0n,
    perTxMax: 60n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400 * 30),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'garage charger',
    status: STATUS_ACTIVE,
    spendCount: 0,
    refusalCount: 0,
    bump: 1,
    ...over,
  };
  publish(mandate);
  return mandate;
}

function refusedRow(): LedgerRow {
  return {
    ts: BigInt(Math.floor(Date.now() / 1000)),
    amount: 180n,
    counterparty: MERCHANT.toBase58(),
    nonce: 7n,
    suggestedOverride: 180n,
    kind: KIND_REFUSED,
    kindName: 'refused',
    reason: REASON_OVER_PER_TX_MAX,
    reasonText: 'over per-payment maximum',
    signature: null,
  };
}

const ata = getAssociatedTokenAddressSync(MINT, OWNER, false, TOKEN_PROGRAM_ID);

const connection = {
  async getAccountInfo(address: PublicKey) {
    if (address.equals(MINT)) {
      return { data: mintData(), owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
    }
    if (address.equals(ata)) {
      return { data: tokenData(100_000_000n), owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
    }
    for (const item of held) {
      const mandateKey = new PublicKey(item.mandate.address);
      if (address.equals(mandateKey)) {
        return { data: item.bytes, owner: PROGRAM, executable: false, lamports: 1 };
      }
      if (address.equals(ledgerPda(PROGRAM, mandateKey))) {
        return { data: ledgerBytes(mandateKey), owner: PROGRAM, executable: false, lamports: 1 };
      }
    }
    return null;
  },
  async getProgramAccounts() {
    return held.map((item) => ({
      pubkey: new PublicKey(item.mandate.address),
      account: { data: item.bytes, owner: PROGRAM, executable: false, lamports: 1 },
    }));
  },
  async getBalance() {
    return SOL;
  },
  async getMinimumBalanceForRentExemption(size: number) {
    if (size === ACCOUNT_SIZE) return TOKEN_RENT;
    if (size === MANDATE_ACCOUNT_SIZE) return MANDATE_RENT;
    if (size === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
    if (size === 0) return 890_880;
    throw new Error(`unexpected rent size ${size}`);
  },
  async getLatestBlockhash() {
    return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 9 };
  },
  async getSignaturesForAddress() {
    return [];
  },
  async getGenesisHash() {
    return 'genesis';
  },
  async confirmTransaction() {
    throw new TransactionExpiredBlockheightExceededError(SIG);
  },
  async getSignatureStatuses(signatures: string[], config?: { searchTransactionHistory: boolean }) {
    if (config?.searchTransactionHistory !== true || signatures[0] !== SIG) {
      throw new Error('status lookup must search transaction history for the sent signature');
    }
    return { value: [signatureRow] };
  },
};

let Overview: ComponentType = () => null;
let Rules: ComponentType = () => null;
let Decisions: ComponentType = () => null;
let NewRule: ComponentType = () => null;
let RuleDetail: ComponentType = () => null;
let ChainProvider: (props: { children: ReactNode }) => ReactNode = ({ children }) => children;
let useChain: () => typeof api;
let restoreConnection: (() => void) | null = null;

function Binder() {
  const chain = useChain();
  useEffect(() => {
    api = chain as NonNullable<typeof api>;
  }, [chain]);
  return null;
}

function Shell() {
  const Screen =
    mode === 'overview' ? Overview : mode === 'rules' ? Rules : mode === 'decisions' ? Decisions : mode === 'new' ? NewRule : RuleDetail;
  return createElement(ChainProvider, null, createElement(Binder), createElement(Screen));
}

async function loadApp(): Promise<void> {
  const offer = await import('./useNotificationOffer');
  // Node 22 still evaluates the real package on a dynamic import, mock or not.
  // expo-notifications and the decision scan both pull the Expo runtime, which
  // throws __DEV__ is not defined. These fakes answer the offer instead.
  offer.notificationPermissions.reader = {
    getPermissionsAsync: async () => ({ granted: permissionGranted }),
    requestPermissionsAsync: async () => {
      permissionGranted = true;
      return { granted: true };
    },
  };
  offer.notificationPermissions.scanDecisions = async () => undefined;
  if (restoreConnection) return;
  const chain = await import('./chain');
  const hook = await import('./useChain');
  const saved = chain.chainConnection.open;
  chain.chainConnection.open = () => connection as unknown as Connection;
  restoreConnection = () => {
    chain.chainConnection.open = saved;
  };
  useChain = hook.useChain as () => typeof api;
  ChainProvider = hook.ChainProvider;
  Overview = (await import('../app/(tabs)/index')).default;
  Rules = (await import('../app/(tabs)/rules')).default;
  Decisions = (await import('../app/(tabs)/decisions')).default;
  NewRule = (await import('../app/rule/new')).default;
  RuleDetail = (await import('../app/rule/[address]')).default;
}

function reset(): void {
  nav.replaces.length = 0;
  nav.pushes.length = 0;
  permissionGranted = false;
  alreadyAsked = false;
  askCalls = 0;
  signCalls = 0;
  signatureRow = { err: null, confirmationStatus: 'finalized' };
  held = [];
  ledgerEntry = null;
  afterSign = () => undefined;
  api = null;
  params.ruleset = 'new';
  delete params.address;
  listeners.clear();
}

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
}

function visibleText(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => isHost(node, 'Text'))
    .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''))
    .join('\n');
}

function labelsOf(root: ReactTestRenderer): string[] {
  return root.root
    .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
    .map((node) => String(node.props.accessibilityLabel));
}

function holdButton(root: ReactTestRenderer): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => isHost(candidate, 'Pressable'))
    .find((candidate) => String(candidate.props.accessibilityLabel ?? '').startsWith('Press and hold to approve rule'));
  assert.ok(node, `no hold button. Labels: ${labelsOf(root).join(' | ')}`);
  return node;
}

function pressHold(node: ReactTestInstance): void {
  const fire = node.props.onLongPress as (() => void) | undefined;
  assert.ok(fire, 'hold control has no long press');
  fire();
}

function button(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => isHost(candidate, 'Pressable'))
    .find((candidate) => candidate.props.accessibilityLabel === label);
  assert.ok(node, `no button labelled ${label}. Labels: ${labelsOf(root).join(' | ')}`);
  return node;
}

async function settle(root: ReactTestRenderer, ready: (text: string) => boolean): Promise<string> {
  let text = '';
  for (let i = 0; i < 60; i += 1) {
    text = visibleText(root);
    if (ready(text)) return text;
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  throw new Error(`timed out.\n${text}\n${api?.error ?? ''}`);
}

async function show(next: Mode): Promise<ReactTestRenderer> {
  mode = next;
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(createElement(Shell));
  });
  return root;
}

test.describe('landed open', { concurrency: 1 }, () => {
  test('after a successful open the new rule screen no longer offers Open this rule and routes to the rule read back from chain', async () => {
    await loadApp();
    reset();
    afterSign = (txs) => {
      publish(mandateFromOpen(txs[0]!));
    };
    const root = await show('new');
    try {
      await settle(root, () => labelsOf(root).some((label) => label.startsWith('Press and hold to approve rule')) && api?.config != null);
      const payee = root.root
        .findAll((node) => isHost(node, 'TextInput'))
        .find((node) => node.props.accessibilityLabel === 'Payee');
      assert.ok(payee, 'payee field missing');
      await act(async () => {
        payee.props.onChangeText(MERCHANT.toBase58());
      });
      await act(async () => {
        pressHold(holdButton(root));
      });
      await settle(root, () => !labelsOf(root).some((label) => label.startsWith('Press and hold to approve rule')));
      assert.equal(labelsOf(root).some((label) => label.startsWith('Press and hold to approve rule')), false);
      assert.equal(nav.replaces.at(-1), `/rule/${held[0]?.mandate.address}`);
    } finally {
      root.unmount();
    }
  });

  test('a landed open leads to the notification ask', async () => {
    await loadApp();
    reset();
    afterSign = (txs) => {
      publish(mandateFromOpen(txs[0]!));
    };
    const root = await show('new');
    try {
      await settle(root, () => labelsOf(root).some((label) => label.startsWith('Press and hold to approve rule')) && api?.config != null);
      const payee = root.root
        .findAll((node) => isHost(node, 'TextInput'))
        .find((node) => node.props.accessibilityLabel === 'Payee');
      assert.ok(payee);
      await act(async () => {
        payee.props.onChangeText(MERCHANT.toBase58());
      });
      await act(async () => {
        pressHold(holdButton(root));
      });
      await settle(root, () => nav.replaces.length > 0);
      const href = nav.replaces.at(-1) ?? '';
      assert.equal(href, `/rule/${held[0]?.mandate.address}`);
      params.address = href.slice('/rule/'.length);
      mode = 'rule';
      await act(async () => {
        root.update(createElement(Shell));
      });
      const text = await settle(root, (value) => /notification permission/i.test(value));
      assert.match(text, /notification permission/i);
      await act(async () => {
        button(root, 'Continue to notification permission').props.onPress();
      });
      await settle(root, () => askCalls === 1);
      assert.equal(askCalls, 1);
    } finally {
      root.unmount();
    }
  });

  test('a landed open refetches the owner rules onto Overview', async () => {
    await loadApp();
    reset();
    afterSign = (txs) => {
      publish(mandateFromOpen(txs[0]!));
    };
    const root = await show('overview');
    try {
      await settle(root, (text) => text.includes('Open your first rule'));
      await act(async () => {
        await api!.open({
          merchant: MERCHANT,
          agent: AGENT.publicKey,
          cap: 200n,
          perTxMax: 60n,
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
          purpose: 'night charging',
        });
      });
      const text = await settle(root, (value) => value.includes('night charging'));
      assert.match(text, /night charging/);
      assert.equal(text.includes('Open your first rule'), false);
    } finally {
      root.unmount();
    }
  });

  test('a landed close refetches the owner rules onto Rules', async () => {
    await loadApp();
    reset();
    seedMandate({ purpose: 'garage charger', status: STATUS_REVOKED });
    afterSign = () => {
      held = [];
    };
    const root = await show('rules');
    try {
      await settle(root, (text) => text.includes('garage charger'));
      await act(async () => {
        await api!.close();
      });
      const text = await settle(root, (value) => value.includes('Nothing on chain for this owner yet'));
      assert.match(text, /Nothing on chain for this owner yet/);
      assert.equal(text.includes('garage charger'), false);
    } finally {
      root.unmount();
    }
  });

  test('a landed revoke refetches the owner rules onto Rules', async () => {
    await loadApp();
    reset();
    seedMandate({ purpose: 'garage charger', status: STATUS_ACTIVE });
    afterSign = () => {
      const current = held[0]?.mandate;
      if (!current) return;
      publish({ ...current, status: STATUS_REVOKED });
    };
    const root = await show('rules');
    try {
      await settle(root, (text) => text.includes('garage charger'));
      assert.equal(
        labelsOf(root).some((label) => label.includes('revoked')),
        false,
      );
      await act(async () => {
        await api!.revoke();
      });
      await settle(root, () => labelsOf(root).some((label) => label.includes('revoked')));
      assert.ok(labelsOf(root).some((label) => label.includes('garage charger') && label.includes('revoked')));
    } finally {
      root.unmount();
    }
  });

  test('a landed override refetches the owner rules onto Decisions', async () => {
    await loadApp();
    reset();
    seedMandate({ purpose: 'garage charger', cap: 200n, perTxMax: 60n, spent: 0n, lastNonce: 0n });
    afterSign = () => {
      ledgerEntry = entryBytes({
        ts: BigInt(Math.floor(Date.now() / 1000)),
        amount: 180n,
        counterparty: MERCHANT,
        nonce: 7n,
        suggestedOverride: 180n,
        kind: KIND_OVERRIDE,
        reason: 0,
      });
    };
    const root = await show('decisions');
    try {
      await settle(root, (text) => text.includes('No decisions on this rule yet'));
      await act(async () => {
        await api!.grantOverride(api!.mandate!.address, refusedRow());
      });
      const text = await settle(root, (value) =>
        value.includes('Allowed once: this payment of <0.01'),
      );
      assert.match(text, /Allowed once: this payment of <0\.01/);
      assert.match(text, /<0\.01/);
      assert.equal(text.includes('No decisions on this rule yet'), false);
      assert.ok(labelsOf(root).includes(`Waived by the owner 0.00018 ${tokenSymbol(MINT.toBase58())}`));
    } finally {
      root.unmount();
    }
  });

  test('Overview refetches the owner rules when it regains focus', async () => {
    await loadApp();
    reset();
    const root = await show('overview');
    try {
      await settle(root, (text) => text.includes('Open your first rule'));
      seedMandate({ purpose: 'garage charger' });
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
      assert.match(visibleText(root), /Open your first rule/);
      await act(async () => {
        refocus();
      });
      const text = await settle(root, (value) => value.includes('garage charger'));
      assert.match(text, /garage charger/);
      assert.equal(text.includes('Open your first rule'), false);
    } finally {
      root.unmount();
    }
  });

  test('Rules refetches the owner rules when it regains focus', async () => {
    await loadApp();
    reset();
    const root = await show('rules');
    try {
      await settle(root, (text) => text.includes('Nothing on chain for this owner yet'));
      seedMandate({ purpose: 'garage charger' });
      await act(async () => {
        refocus();
      });
      const text = await settle(root, (value) => value.includes('garage charger'));
      assert.match(text, /garage charger/);
      assert.equal(text.includes('Nothing on chain for this owner yet'), false);
    } finally {
      root.unmount();
    }
  });

  test('Decisions refetches the owner rules when it regains focus', async () => {
    await loadApp();
    reset();
    const root = await show('decisions');
    try {
      await settle(root, (text) => text.includes('No rule on chain for this owner'));
      seedMandate({ purpose: 'garage charger' });
      await act(async () => {
        refocus();
      });
      const text = await settle(root, (value) => value.includes('garage charger'));
      assert.match(text, /garage charger/);
      assert.equal(text.includes('No rule on chain for this owner'), false);
    } finally {
      root.unmount();
    }
  });

  test('Overview offers to turn notifications on when a rule exists and permission is off', async () => {
    await loadApp();
    reset();
    permissionGranted = false;
    seedMandate({ purpose: 'garage charger' });
    const root = await show('overview');
    try {
      const text = await settle(root, (value) => value.includes('Turn notifications on'));
      assert.match(text, /Turn notifications on/);
      assert.match(text, /garage charger/);
      await act(async () => {
        button(root, 'Turn notifications on').props.onPress();
      });
      const after = await settle(root, (value) => !value.includes('Turn notifications on'));
      assert.equal(after.includes('Turn notifications on'), false);
      assert.match(after, /garage charger/);
    } finally {
      root.unmount();
    }
  });

  test('after the signature is still absent, Open this rule stays disabled until the rules list is refreshed', async () => {
    await loadApp();
    reset();
    signatureRow = null;
    const chain = await import('./chain');
    const watch = (chain as { signatureWatch?: { windowMs: number } }).signatureWatch;
    const savedWindow = watch?.windowMs;
    if (watch) {
      watch.windowMs = 0;
    }
    const root = await show('new');
    try {
      await settle(root, () => labelsOf(root).some((label) => label.startsWith('Press and hold to approve rule')) && api?.config != null);
      const payee = root.root
        .findAll((node) => isHost(node, 'TextInput'))
        .find((node) => node.props.accessibilityLabel === 'Payee');
      assert.ok(payee, 'payee field missing');
      await act(async () => {
        payee.props.onChangeText(MERCHANT.toBase58());
      });
      await act(async () => {
        pressHold(holdButton(root));
      });
      const absent = signatureNotYetVisibleMessage('devnet');
      const text = await settle(root, (value) => value.includes(absent));
      assert.equal(text.includes('nothing moved'), false);
      assert.equal(holdButton(root).props.disabled, true);
      const signed = signCalls;
      await act(async () => {
        pressHold(holdButton(root));
        await new Promise((resolve) => setImmediate(resolve));
      });
      assert.equal(signCalls, signed);
      await act(async () => {
        await api!.refresh();
      });
      await settle(root, () => holdButton(root).props.disabled !== true);
      assert.equal(holdButton(root).props.disabled, false);
    } finally {
      if (watch && savedWindow != null) {
        watch.windowMs = savedWindow;
      }
      root.unmount();
    }
  });
});
