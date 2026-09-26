import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Keypair } from '@solana/web3.js';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { KIND_ADVISORY_DECLINE } from './advisory';
import { KIND_OPENED, KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX, STATUS_ACTIVE } from './constants';
import { buildAgentRecords, type AgentRecord, type GradeDecision, type RuleFacts } from './grade';
import { VTEST_MINT } from './tokens';
import type { AgentScreenData } from '../components/agents/useAgentHistories';

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
      Text: Host('Animated.Text'),
      timing: () => animation,
      sequence: () => animation,
      loop: () => animation,
      delay: () => animation,
    },
    Easing: {
      bezier: () => () => 0,
      linear: (value: number) => value,
      cubic: (value: number) => value,
      out: (fn: unknown) => fn,
      in: (fn: unknown) => fn,
      inOut: (fn: unknown) => fn,
    },
    Image: Host('Image'),
    Linking: { openURL: async () => undefined },
    Pressable: Host('Pressable'),
    RefreshControl: Host('RefreshControl'),
    ScrollView: Host('ScrollView'),
    Share: { share: async () => undefined },
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

mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Circle: Host('Circle'),
    Defs: Host('Defs'),
    G: Host('G'),
    Line: Host('Line'),
    LinearGradient: Host('LinearGradient'),
    Path: Host('Path'),
    Rect: Host('Rect'),
    Stop: Host('Stop'),
    Svg: Host('Svg'),
  },
});

function Tabs(props: { children?: ReactNode }) {
  return createElement('Tabs', null, props.children);
}
function TabScreen(props: { options?: { tabBarLabel?: string; tabBarIcon?: (icon: { color: string }) => ReactNode }; children?: ReactNode }) {
  const label = props.options?.tabBarLabel;
  const icon = props.options?.tabBarIcon?.({ color: '#C9A24D' });
  return createElement('TabScreen', { accessibilityLabel: label }, icon, label);
}
Tabs.Screen = TabScreen;

mock.module('expo-router', {
  namedExports: {
    Tabs,
    useRouter: () => ({ push() {}, back() {}, replace() {} }),
    useLocalSearchParams: () => ({}),
    usePathname: () => '/agents',
  },
});

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({ ready: true, ownerPublicKey: 'owner', seen: true }),
  },
});

mock.module('./useOnboarding', {
  namedExports: {
    useOnboarding: () => ({ ready: true, seen: true, markSeen: async () => undefined }),
  },
});

const START = 1_700_000_000n;
const DAY = 86400n;
const NOW = START + 10n * DAY;
const AGENT = Keypair.generate().publicKey.toBase58();

function decision(over: Partial<GradeDecision> = {}): GradeDecision {
  return {
    kind: KIND_PAID,
    ts: START + 1n,
    amount: 8n,
    nonce: 1n,
    reason: 0,
    counterparty: '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG',
    ...over,
  };
}

function sampleRule(): RuleFacts {
  const paid = Array.from({ length: 6 }, (_, index) =>
    decision({ nonce: BigInt(index + 1), ts: START + BigInt(index + 1) }),
  );
  const refused = Array.from({ length: 12 }, (_, index) =>
    decision({
      kind: KIND_REFUSED,
      nonce: BigInt(100 + index),
      ts: START + BigInt(20 + index),
      amount: 14n,
      reason: REASON_OVER_PER_TX_MAX,
    }),
  );
  return {
    address: 'RuleAddress11111111111111111111111111111111',
    agent: AGENT,
    purpose: 'Charging top-ups',
    cap: 300n,
    spent: 42n,
    perTxMax: 10n,
    expiresAt: START + 90n * DAY,
    status: STATUS_ACTIVE,
    decimals: 0,
    mint: VTEST_MINT,
    merchant: '6i99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaPdCG',
    rows: [
      decision({ kind: KIND_OPENED, ts: START, nonce: 0n, amount: 300n }),
      ...paid,
      ...refused,
      decision({ kind: KIND_ADVISORY_DECLINE, nonce: 80n, amount: 1n }),
    ],
  };
}

function screenData(over: Partial<AgentScreenData> = {}): AgentScreenData {
  return {
    status: 'ready',
    error: null,
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    nowSec: NOW,
    liveRules: 1,
    agents: [],
    refreshing: false,
    refresh() {},
    saveName: async () => undefined,
    ...over,
  };
}

function readyAgents(): AgentRecord[] {
  return buildAgentRecords([sampleRule()], { [AGENT]: 'Charging agent' }, NOW);
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  assert.ok(root);
  return root;
}

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

function button(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => (candidate.type as unknown) === 'Pressable')
    .find((candidate) => candidate.props.accessibilityLabel === label);
  assert.ok(node, `no control labelled ${label}`);
  return node;
}

test('the agents screen shows loading, an empty wallet, a read error, and a graded agent', async () => {
  const { AgentsScreen } = await import('../components/agents/AgentsScreen');
  const loading = visibleText(await mount(createElement(AgentsScreen, { data: screenData({ status: 'loading' }), onOpenAgent() {}, onHowGrades() {} })));
  assert.match(loading, /Reading your agents from the blockchain/);

  const empty = visibleText(await mount(createElement(AgentsScreen, { data: screenData({ status: 'empty', liveRules: 0 }), onOpenAgent() {}, onHowGrades() {} })));
  assert.match(empty, /No agent is on a rule yet/);

  const error = visibleText(await mount(createElement(AgentsScreen, { data: screenData({ status: 'error', error: 'The RPC refused the read.' }), onOpenAgent() {}, onHowGrades() {} })));
  assert.match(error, /Could not reach the blockchain/);
  assert.doesNotMatch(error, /RPC/);
  assert.doesNotMatch(error, /no rule live/i);

  let opened = '';
  const normal = await mount(
    createElement(AgentsScreen, {
      data: screenData({ agents: readyAgents() }),
      onOpenAgent(agent: string) {
        opened = agent;
      },
      onHowGrades() {},
    }),
  );
  const text = visibleText(normal);
  assert.match(text, /Charging agent/);
  assert.match(text, /Pushed its limit often/);
  assert.match(text, /12 of its 18 requests outside its rule/);
  assert.match(text, /Devnet/);
  await act(async () => {
    button(normal, `Open the full record of Charging agent. Grade: Pushed its limit often.`).props.onPress();
  });
  assert.equal(opened, AGENT);
});

test('agents while the chain is rate limited says the blockchain is busy and does not claim no rule is live', async () => {
  const { AgentsScreen } = await import('../components/agents/AgentsScreen');
  const data = screenData({
    status: 'loading',
    error: 'The RPC rate limited this read. Pull to retry.',
    notice: 'The RPC rate limited this read. Pull to retry.',
    liveRules: 0,
    refreshing: true,
    agents: [],
  });
  const text = visibleText(
    await mount(createElement(AgentsScreen, { data, onOpenAgent() {}, onHowGrades() {} })),
  );
  assert.match(text, /The blockchain is busy right now\. Veto keeps trying\./);
  assert.match(text, /Reading\.\.\./);
  assert.doesNotMatch(text, /RPC/);
  assert.doesNotMatch(text, /no rule live/i);
  assert.doesNotMatch(text, /No agent/);
});

test('agents after a failed read says to pull down and does not claim no rule or no agent', async () => {
  const { AgentsScreen } = await import('../components/agents/AgentsScreen');
  const text = visibleText(
    await mount(
      createElement(AgentsScreen, {
        data: screenData({ status: 'error', error: 'The RPC refused the read.', liveRules: 0, agents: [] }),
        onOpenAgent() {},
        onHowGrades() {},
      }),
    ),
  );
  assert.match(text, /Could not reach the blockchain\. Pull down to try again\./);
  assert.match(text, /Could not read/);
  assert.doesNotMatch(text, /RPC/);
  assert.doesNotMatch(text, /no rule live/i);
  assert.doesNotMatch(text, /No agent/);
});

test('agents after a successful read shows the agent and that one rule is live', async () => {
  const { AgentsScreen } = await import('../components/agents/AgentsScreen');
  const text = visibleText(
    await mount(
      createElement(AgentsScreen, {
        data: screenData({ agents: readyAgents(), liveRules: 1, status: 'ready', error: null }),
        onOpenAgent() {},
        onHowGrades() {},
      }),
    ),
  );
  assert.match(text, /Charging agent/);
  assert.match(text, /1 rule live/);
  assert.doesNotMatch(text, /Could not read/);
  assert.doesNotMatch(text, /blockchain is busy/);
  assert.doesNotMatch(text, /No agent/);
});

test('how grades work shows loading, empty, error, and the four rules', async () => {
  const { GradesScreen } = await import('../components/agents/GradesScreen');
  const onBack = () => undefined;
  assert.match(visibleText(await mount(createElement(GradesScreen, { data: screenData({ status: 'loading' }), onBack }))), /Reading your agents/);
  assert.match(
    visibleText(await mount(createElement(GradesScreen, { data: screenData({ status: 'empty', agents: [] }), onBack }))),
    /There is nothing to grade/,
  );
  assert.match(
    visibleText(await mount(createElement(GradesScreen, { data: screenData({ status: 'error', error: 'Config is missing.' }), onBack }))),
    /Config is missing/,
  );
  const normal = visibleText(await mount(createElement(GradesScreen, { data: screenData({ agents: readyAgents() }), onBack })));
  assert.match(normal, /Stayed inside its rule/);
  assert.match(normal, /Fewer than 1 request in 20 outside its rule/);
  assert.match(normal, /Tested its limit now and then/);
  assert.match(normal, /1 to 4 requests in 20 outside its rule/);
  assert.match(normal, /Pushed its limit often/);
  assert.match(normal, /More than 4 requests in 20 outside its rule/);
  assert.match(normal, /Too new to grade/);
  assert.match(normal, /Fewer than 10 requests/);
  assert.match(normal, /fewer than 3 days/);
  assert.match(normal, /A payment you allowed once/);
  assert.match(normal, /2 or more/);
  assert.match(normal, /Not counted/);
  assert.match(normal, /It is not a safety guarantee/);
  assert.doesNotMatch(normal, /There is nothing to grade/);
});

test('the agent record shows loading, a missing agent, an error, and the chain counts', async () => {
  const { AgentRecordScreen } = await import('../components/agents/AgentRecordScreen');
  const props = {
    agent: AGENT,
    onBack() {},
    onHowGrades() {},
    onPlaques() {},
    onShareRecord() {},
    onWeek() {},
    onDecisions() {},
  };
  assert.match(visibleText(await mount(createElement(AgentRecordScreen, { ...props, data: screenData({ status: 'loading' }) }))), /Reading this agent's record/);
  assert.match(visibleText(await mount(createElement(AgentRecordScreen, { ...props, data: screenData({ status: 'empty' }) }))), /not on a rule/);
  assert.match(visibleText(await mount(createElement(AgentRecordScreen, { ...props, data: screenData({ status: 'error', error: 'Ledger missing.' }) }))), /Ledger missing/);
  const normal = visibleText(await mount(createElement(AgentRecordScreen, { ...props, data: screenData({ agents: readyAgents() }) })));
  assert.match(normal, /Pushed its limit often/);
  assert.match(normal, /12 of 18, all 12 refused/);
  assert.match(normal, /Its own signed declines, not in the grade/);
  assert.match(normal, /Ten refusals, none allowed/);
  assert.match(normal, /Money moved: 0/);
});

test('plaques show loading, empty, error, and an engraved fact', async () => {
  const { PlaquesScreen } = await import('../components/agents/PlaquesScreen');
  const props = { agent: AGENT, onBack() {}, onSharePlaque() {} };
  assert.match(visibleText(await mount(createElement(PlaquesScreen, { ...props, data: screenData({ status: 'loading' }) }))), /Reading plaques/);
  assert.match(visibleText(await mount(createElement(PlaquesScreen, { ...props, data: screenData({ status: 'empty' }) }))), /not on a rule/);
  assert.match(visibleText(await mount(createElement(PlaquesScreen, { ...props, data: screenData({ status: 'error', error: 'Plaques unread.' }) }))), /Plaques unread/);
  const normal = visibleText(await mount(createElement(PlaquesScreen, { ...props, data: screenData({ agents: readyAgents() }) })));
  assert.match(normal, /Engraved under this rule/);
  assert.match(normal, /First payment inside the rule/);
  assert.match(normal, /Paid 8 VTEST to/);
  assert.match(normal, /Devnet/);
});

test('the track record shows loading, empty, error, Devnet, and a failed share can be tried again', async () => {
  const { TrackScreen } = await import('../components/agents/TrackScreen');
  const base = { agent: AGENT, onBack() {}, onShareImage: async () => undefined, onCopyLink: async () => undefined, onSaveRecord: async () => undefined };
  assert.match(visibleText(await mount(createElement(TrackScreen, { ...base, data: screenData({ status: 'loading' }) }))), /Reading the track record/);
  assert.match(visibleText(await mount(createElement(TrackScreen, { ...base, data: screenData({ status: 'empty' }) }))), /not on a rule/);
  assert.match(visibleText(await mount(createElement(TrackScreen, { ...base, data: screenData({ status: 'error', error: 'Card unread.' }) }))), /Card unread/);
  let shares = 0;
  const normal = await mount(
    createElement(TrackScreen, {
      ...base,
      data: screenData({ agents: readyAgents() }),
      onShareImage: async () => {
        shares += 1;
        throw new Error('The share sheet closed.');
      },
    }),
  );
  const text = visibleText(normal);
  assert.match(text, /Devnet/);
  assert.match(text, /Asked outside its rule 12 times/);
  const images = normal.root.findAll((node) => (node.type as unknown) === 'Image');
  assert.ok(images.some((node) => node.props.accessibilityLabel === 'QR code of the rule address'));
  await act(async () => {
    button(normal, 'Share as an image').props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(visibleText(normal), /The share sheet closed/);
  await act(async () => {
    button(normal, 'Share as an image').props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(shares, 2);
});

test('week in review shows loading, empty, error, and the seven-day counts', async () => {
  const { WeekScreen } = await import('../components/agents/WeekScreen');
  const base = {
    agent: AGENT,
    onBack() {},
    onSaveFile: async () => undefined,
    onShareCard: async () => undefined,
    onReason() {},
  };
  assert.match(visibleText(await mount(createElement(WeekScreen, { ...base, data: screenData({ status: 'loading' }) }))), /Reading this week/);
  assert.match(visibleText(await mount(createElement(WeekScreen, { ...base, data: screenData({ status: 'empty' }) }))), /not on a rule/);
  assert.match(visibleText(await mount(createElement(WeekScreen, { ...base, data: screenData({ status: 'error', error: 'Week unread.' }) }))), /Week unread/);
  let saved = '';
  const normal = await mount(
    createElement(WeekScreen, {
      ...base,
      data: screenData({ agents: readyAgents(), nowSec: START + 3600n }),
      onSaveFile: async (_name: string, text: string) => {
        saved = text;
      },
    }),
  );
  const text = visibleText(normal);
  assert.match(text, /Week in review/);
  assert.match(text, /Why it was refused/);
  assert.match(text, /Asked more than 10 VTEST per payment/);
  assert.match(text, /Devnet/);
  await act(async () => {
    button(normal, 'Save this week as a file').props.onPress();
    await Promise.resolve();
  });
  assert.match(saved, /Paid: \d+ payments/);
  assert.match(saved, /0 moved/);
  assert.match(saved, /Every line is read from the blockchain/);
});

test('an agent with no saved name is Unnamed agent, the address shows once, and it can be named', async () => {
  const { AgentsScreen } = await import('../components/agents/AgentsScreen');
  const unnamed = buildAgentRecords([sampleRule()], {}, NOW);
  const record = unnamed[0];
  assert.ok(record);
  let saved = '';
  const root = await mount(
    createElement(AgentsScreen, {
      data: screenData({ agents: unnamed }),
      onOpenAgent() {},
      onHowGrades() {},
      onNameAgent(agent: string, name: string) {
        saved = `${agent}:${name}`;
      },
    }),
  );
  const text = visibleText(root);
  assert.match(text, /Unnamed agent/);
  assert.equal(text.split(record.shortAddress).length - 1, 1);
  assert.match(text, /Name this agent/);
  await act(async () => {
    button(root, 'Name this agent').props.onPress();
  });
  const field = root.root
    .findAll((node) => (node.type as unknown) === 'TextInput')
    .find((node) => node.props.accessibilityLabel === 'Agent name');
  assert.ok(field);
  await act(async () => {
    field.props.onChangeText('Depot agent');
  });
  await act(async () => {
    button(root, 'Save agent name').props.onPress();
  });
  assert.equal(saved, `${record.agent}:Depot agent`);
});

test('the tab bar has Agents between Rules and Decisions', async () => {
  const layout = await import('../app/(tabs)/_layout');
  const root = await mount(createElement(layout.default));
  const labels = root.root
    .findAll((node) => (node.type as unknown) === 'TabScreen')
    .map((node) => String(node.props.accessibilityLabel));
  assert.deepEqual(labels, ['Overview', 'Rules', 'Agents', 'Decisions']);
});
