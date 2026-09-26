import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

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
    StyleSheet: { create<T>(styles: T): T { return styles; }, hairlineWidth: 1, absoluteFill: {} },
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
    .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''))
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

const noop = () => undefined;

test('learn story shows loading, empty, error, and the first step', async () => {
  const { LearnStory } = await import('./LearnStory');
  const props = {
    onSkip: noop,
    onConnect: noop,
    showConnect: true,
  };
  assert.match(visibleText(await mount(createElement(LearnStory, { ...props, view: 'loading' }))), /Loading/);
  assert.match(
    visibleText(await mount(createElement(LearnStory, { ...props, view: 'empty' }))),
    /no steps to show/,
  );
  assert.match(
    visibleText(await mount(createElement(LearnStory, { ...props, view: 'error', error: 'Could not save that choice on this phone.' }))),
    /Could not save that choice on this phone/,
  );
  const normal = visibleText(await mount(createElement(LearnStory, props)));
  assert.match(normal, /Your agent can only ask/);
  assert.match(normal, /Learn/);
  assert.doesNotMatch(normal, /\b14\b/);
  assert.doesNotMatch(normal, /\b300\b/);
});

test('how Veto works shows loading, empty, error, and the story', async () => {
  const { HowVetoWorks } = await import('./HowVetoWorks');
  const props = { cluster: 'devnet', connected: false, onConnect: noop, onDone: noop };
  assert.match(visibleText(await mount(createElement(HowVetoWorks, { ...props, view: 'loading' }))), /Loading/);
  assert.match(visibleText(await mount(createElement(HowVetoWorks, { ...props, view: 'empty' }))), /not available yet/);
  assert.match(visibleText(await mount(createElement(HowVetoWorks, { ...props, view: 'error', error: 'Wallet closed.' }))), /Wallet closed/);
  const normal = visibleText(await mount(createElement(HowVetoWorks, props)));
  assert.match(normal, /Your agent asks\. The rule decides\. You get told\./);
  assert.match(normal, /Connect wallet/);
});

test('connect wallet shows loading, empty, error, and the wallet ask', async () => {
  const { ConnectWalletScreen } = await import('./ConnectWalletScreen');
  const props = { cluster: 'devnet', onConnect: noop };
  assert.match(visibleText(await mount(createElement(ConnectWalletScreen, { ...props, view: 'loading' }))), /Loading/);
  assert.match(visibleText(await mount(createElement(ConnectWalletScreen, { ...props, cluster: null, view: 'empty' }))), /Waiting for the network/);
  assert.match(visibleText(await mount(createElement(ConnectWalletScreen, { ...props, view: 'error', error: 'You cancelled the wallet request.' }))), /You cancelled the wallet request/);
  const normal = visibleText(await mount(createElement(ConnectWalletScreen, props)));
  assert.match(normal, /Open Solana Mobile wallet/);
  assert.match(normal, /devnet/);
});

test('wallet connected shows loading, empty, error, and the connected address', async () => {
  const { WalletConnectedScreen } = await import('./WalletConnectedScreen');
  const owner = 'So11111111111111111111111111111111111111112';
  const props = { cluster: 'devnet', owner, onAddAgent: noop };
  assert.match(visibleText(await mount(createElement(WalletConnectedScreen, { ...props, view: 'loading' }))), /Loading/);
  assert.match(visibleText(await mount(createElement(WalletConnectedScreen, { ...props, owner: null, view: 'empty' }))), /No wallet is connected/);
  assert.match(visibleText(await mount(createElement(WalletConnectedScreen, { ...props, view: 'error', error: 'Session closed.' }))), /Session closed/);
  const normal = visibleText(await mount(createElement(WalletConnectedScreen, props)));
  assert.match(normal, /Your Seeker ID, on this phone/);
  assert.match(normal, /So11\.\.\.1112/);
  assert.doesNotMatch(normal, /arlenzo/);
});

test('add agent shows loading, empty, error, and the three ways in', async () => {
  const { AddAgentScreen } = await import('./AddAgentScreen');
  const props = { cluster: 'devnet', onScan: noop, onPaste: noop, onCreateTest: noop, onHow: noop };
  assert.match(visibleText(await mount(createElement(AddAgentScreen, { ...props, view: 'loading' }))), /Loading/);
  assert.match(visibleText(await mount(createElement(AddAgentScreen, { ...props, view: 'empty' }))), /Connect a wallet before you add an agent/);
  assert.match(visibleText(await mount(createElement(AddAgentScreen, { ...props, view: 'error', error: 'The test agent could not be created.' }))), /could not be created/);
  const normal = visibleText(await mount(createElement(AddAgentScreen, props)));
  assert.match(normal, /Scan your agent's code/);
  assert.match(normal, /Paste your agent's address/);
  assert.match(normal, /Create a test agent on this phone/);
});

test('name agent shows loading, empty, error, and a found address without sample amounts', async () => {
  const { NameAgentScreen } = await import('./NameAgentScreen');
  const props = {
    cluster: 'devnet',
    address: 'So11111111111111111111111111111111111111112',
    name: 'Charger',
    onName: noop,
    facts: null,
    onReview: noop,
    onReject: noop,
  };
  assert.match(visibleText(await mount(createElement(NameAgentScreen, { ...props, view: 'loading' }))), /Loading/);
  assert.match(visibleText(await mount(createElement(NameAgentScreen, { ...props, address: null, view: 'empty' }))), /No agent yet/);
  assert.match(visibleText(await mount(createElement(NameAgentScreen, { ...props, view: 'error', error: 'That is not an agent address or a rule request.' }))), /not an agent address/);
  const normal = visibleText(await mount(createElement(NameAgentScreen, props)));
  assert.match(normal, /Your agent, found/);
  assert.match(normal, /Nothing is approved yet/);
  assert.doesNotMatch(normal, /\b300\b/);
});

test('rule live shows loading, empty, error, and the opened rule amounts', async () => {
  const { RuleLiveScreen } = await import('./RuleLiveScreen');
  const facts = {
    setAside: '12',
    setAsideWhole: 12,
    day: 1,
    totalDays: 9,
    paid: 0,
    refused: 0,
    summary: 'Charger can now ask to pay Abcd...Wxyz, at most 2 per payment and 12 in total, for 9 days. It can only ask. It cannot take.',
    seeUrl: null,
  };
  const props = { cluster: 'devnet', facts, onSetup: noop, onOverview: noop };
  assert.match(visibleText(await mount(createElement(RuleLiveScreen, { ...props, view: 'loading' }))), /Loading/);
  assert.match(visibleText(await mount(createElement(RuleLiveScreen, { ...props, facts: null, view: 'empty' }))), /No rule is live yet/);
  assert.match(visibleText(await mount(createElement(RuleLiveScreen, { ...props, view: 'error', error: 'Open failed' }))), /Open failed/);
  const normal = visibleText(await mount(createElement(RuleLiveScreen, props)));
  assert.match(normal, /Your rule is live/);
  assert.match(normal, /12/);
  assert.match(normal, /Next: protect your money/);
  assert.doesNotMatch(normal, /Go to overview/);
  assert.doesNotMatch(normal, /\b300\b/);
});

test('agent setup shows loading, empty, error, and the copy action', async () => {
  const { AgentSetupScreen } = await import('./AgentSetupScreen');
  const props = {
    cluster: 'devnet',
    rows: [{ label: 'Mandate', value: 'RuleAddress111' }],
    configJson: '{"mandate":"RuleAddress111"}',
    status: null,
    onCopy: noop,
    onAlerts: noop,
    onOverview: noop,
  };
  assert.match(visibleText(await mount(createElement(AgentSetupScreen, { ...props, view: 'loading' }))), /Loading/);
  assert.match(visibleText(await mount(createElement(AgentSetupScreen, { ...props, configJson: null, status: null, view: 'empty' }))), /Waiting for your agent's first request/);
  assert.match(visibleText(await mount(createElement(AgentSetupScreen, { ...props, view: 'error', error: 'Could not read the payee token account' }))), /payee token account/);
  const normal = visibleText(await mount(createElement(AgentSetupScreen, props)));
  assert.match(normal, /Give your agent its setup/);
  assert.match(normal, /Copy setup text/);
  assert.match(normal, /RuleAddress111/);
  assert.match(normal, /Next: protect your money/);
  assert.doesNotMatch(normal, /Go to overview/);
});

test('alerts shows loading, empty, error, and the permission ask without a sample amount', async () => {
  const { AlertsScreen } = await import('./AlertsScreen');
  const props = {
    cluster: 'devnet',
    explanation: 'Decision notifications need Android notification permission so this phone can tell you when a rule pays or refuses.',
    statusLine: null,
    exampleLimit: null,
    onTurnOn: noop,
    onNotNow: noop,
  };
  assert.match(visibleText(await mount(createElement(AlertsScreen, { ...props, view: 'loading' }))), /Loading/);
  assert.match(visibleText(await mount(createElement(AlertsScreen, { ...props, view: 'empty' }))), /Open a rule first/);
  assert.match(visibleText(await mount(createElement(AlertsScreen, { ...props, view: 'error', error: 'Notifications are off, nothing is announced' }))), /nothing is announced/);
  const normal = visibleText(await mount(createElement(AlertsScreen, props)));
  assert.match(normal, /Know the moment it happens/);
  assert.match(normal, /Turn on alerts/);
  assert.match(normal, /more than the limit/);
  assert.doesNotMatch(normal, /asked for 14/);
});

test('Hold offers second Seeker, same phone and later without blocking the agent path', async () => {
  const { ProtectScreen } = await import('./ProtectScreen');
  let choice = '';
  const root = await mount(createElement(ProtectScreen, {
    cluster: 'devnet', owner: 'owner', error: null,
    onSeeker: (address) => { choice = address; },
    onPhone: () => { choice = 'phone'; }, onLater: () => { choice = 'later'; },
  }));
  assert.match(visibleText(root), /Protect the rest of your money/);
  assert.match(visibleText(root), /1, 2 or 3 days/);
  assert.match(visibleText(root), /A second key on this phone is weaker: if you lose this phone, or someone gets into it, both keys are at risk\./);
  assert.match(visibleText(root), /Acting alone, it cannot choose another destination\./);
  assert.match(visibleText(root), /guardian does not control/);
  assert.match(visibleText(root), /stolen owner key/);
  assert.doesNotMatch(visibleText(root), /only say no|also your safe address/);
  assert.match(visibleText(root), /You can set up Hold later from Overview\./);
  const press = async (label: string) => act(async () => {
    root.root.findAll((node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label)[0].props.onPress();
  });
  await press('Set up later');
  assert.equal(choice, 'later');
  await press('Set up with my second Seeker');
  assert.match(visibleText(root), /tap Receive for Solana/);
  await act(async () => {
    root.root.findByType('TextInput' as never).props.onChangeText('So11111111111111111111111111111111111111112');
  });
  await press('Continue with this address');
  assert.equal(choice, 'So11111111111111111111111111111111111111112');
  await act(async () => root.unmount());
});

test('Hold offer with a kept address opens the input pre-filled', async () => {
  const { ProtectScreen } = await import('./ProtectScreen');
  const root = await mount(createElement(ProtectScreen, {
    cluster: 'devnet', owner: 'owner', error: null,
    initialAddress: 'So11111111111111111111111111111111111111112',
    onSeeker: noop, onPhone: noop, onLater: noop,
  }));
  assert.match(visibleText(root), /tap Receive for Solana/);
  assert.equal(
    root.root.findByType('TextInput' as never).props.value,
    'So11111111111111111111111111111111111111112',
  );
  await act(async () => root.unmount());
});
