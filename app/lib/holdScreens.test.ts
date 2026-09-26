import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import test, { mock } from 'node:test';

import { act, createElement, useState, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

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
      linear: (value: number) => value,
      cubic: (value: number) => value,
      out: (ease: (value: number) => number) => ease,
      inOut: (ease: (value: number) => number) => ease,
      bezier: () => (value: number) => value,
    },
    Pressable: Host('Pressable'),
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
    View: Host('View'),
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Circle: Host('Circle'),
    Path: Host('Path'),
    Rect: Host('Rect'),
    G: Host('G'),
  },
});

mock.module('expo-router', {
  namedExports: {
    useRouter: () => ({ push() {}, replace() {}, back() {} }),
  },
});

function textOf(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''))
    .join('\n');
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(root);
  return root;
}

function pressable(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => (candidate.type as unknown) === 'Pressable')
    .find((candidate) => String(candidate.props.accessibilityLabel ?? '').startsWith(label));
  assert.ok(node, `missing ${label}`);
  return node;
}

async function resignsAfterCancel(
  node: ReactElement,
  label: string,
  name: string,
  prop: 'onSign' | 'onStop' | 'onRecover',
): Promise<void> {
  let calls = 0;
  const sign = () => {
    calls += 1;
    return Promise.reject(new Error('You cancelled the wallet request.'));
  };
  const props = { ...(node.props as Record<string, unknown>), [prop]: sign };
  const withSign = await mount(
    createElement(node.type as (next: Record<string, unknown>) => ReactElement, props),
  );
  if (name === 'open-vault') {
    await act(async () => pressable(withSign, 'Review safe address').props.onPress());
  }
  await act(async () => {
    pressable(withSign, label).props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(textOf(withSign), /You cancelled the wallet request/);
  assert.equal(withSign.root.findAll((item) => item.props.testID === `${name}-0`).length, 0);
  assert.ok(withSign.root.findAll((item) => item.props.testID === `${name}-1`).length >= 1);
  await act(async () => {
    pressable(withSign, label).props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(calls, 2, 'a cancelled signature left the hold button disarmed');
  await act(async () => withSign.unmount());
}

const countdown = {
  days: 1,
  hours: 23,
  minutes: 41,
  remainingSec: 171660n,
  over: false,
  accessibilityLabel: '1 day, 23 hours, 41 minutes left',
};

test('the promise screen states the Hold promise', async () => {
  const { PromiseScreen } = await import('../components/hold/PromiseScreen');
  const text = textOf(
    await mount(createElement(PromiseScreen, { network: 'Test tokens', onBack() {}, onStart() {} })),
  );
  assert.match(text, /If someone gets your key, they can start a big withdrawal but they cannot finish it/);
  assert.match(text, /1, 2 or 3 days on the blockchain clock/);
  assert.match(text, /Everyday door/);
  assert.match(text, /Big door/);
});

test('moving money in shows loading, an empty wallet, an error, and a balance', async () => {
  const { AmountScreen } = await import('../components/hold/AmountScreen');
  const props = {
    network: 'Test tokens',
    amountText: '',
    balanceLabel: null as string | null,
    tokenName: 'test tokens',
    walletLabel: '6Ywq...GSV5',
    onAmount() {},
    onBack() {},
    onNext() {},
  };
  assert.match(
    textOf(await mount(createElement(AmountScreen, { ...props, status: 'loading', error: null }))),
    /Reading the blockchain/,
  );
  assert.match(
    textOf(await mount(createElement(AmountScreen, { ...props, status: 'empty', error: null }))),
    /No token account was found/,
  );
  assert.match(
    textOf(await mount(createElement(AmountScreen, { ...props, status: 'error', error: 'The balance could not be read.' }))),
    /The balance could not be read/,
  );
  const ready = textOf(
    await mount(
      createElement(AmountScreen, { ...props, status: 'ready', error: null, balanceLabel: '1,000' }),
    ),
  );
  assert.match(ready, /holds 1,000 test tokens/);
  assert.match(ready, /6Ywq\.\.\.GSV5/);
  assert.equal(ready.includes('Get devnet USDC'), false);
});

test('the deposit screen keeps the devnet USDC faucet when the wallet has no token account', async () => {
  const { AmountScreen } = await import('../components/hold/AmountScreen');
  const { Text } = await import('react-native');
  const props = {
    network: 'Devnet, a test network',
    amountText: '5',
    balanceLabel: null as string | null,
    tokenName: 'USDC',
    walletLabel: '6Ywq...GSV5',
    onAmount() {},
    onBack() {},
    onNext() {},
    faucet: createElement(Text, null, 'Get devnet USDC'),
  };
  const empty = textOf(
    await mount(createElement(AmountScreen, { ...props, status: 'empty', error: null })),
  );
  assert.match(empty, /No token account was found/);
  assert.match(empty, /Get devnet USDC/);
  const ready = textOf(
    await mount(
      createElement(AmountScreen, { ...props, status: 'ready', error: null, balanceLabel: '1' }),
    ),
  );
  assert.match(ready, /holds 1 USDC/);
  assert.match(ready, /Get devnet USDC/);
});

test('the rules screen names the amount, the daily limit, the wait, and the four triggers', async () => {
  const { RulesScreen } = await import('../components/hold/RulesScreen');
  function Rules() {
    const [value, setValue] = useState('50');
    return createElement(RulesScreen, {
      network: 'Test tokens',
      amountLabel: '1,000',
      tokenName: 'test tokens',
      walletLabel: '6Ywq...GSV5',
      dailyLabel: value,
      days: 2,
      onLower: () => setValue(String(Number(value) - 1)),
      onRaise: () => setValue(String(Number(value) + 1)),
      onDays() {},
      onBack() {},
      onNext() {},
    });
  }
  const root = await mount(createElement(Rules));
  const text = textOf(root);
  assert.match(text, /1,000/);
  assert.match(text, /test tokens/);
  assert.match(text, /More than 50 in one day/);
  assert.match(text, /never paid/);
  assert.match(text, /quarter/);
  assert.match(text, /loosens these rules/);
  assert.match(text, /Making it shorter later waits 2 days/);
  await act(async () => {
    pressable(root, 'Raise the everyday limit').props.onPress();
  });
  assert.match(textOf(root), /51/);
});

test('guardian choices explain a second account and the second Seeker', async () => {
  const { GuardianScreen } = await import('../components/hold/GuardianScreen');
  const missing = textOf(
    await mount(
      createElement(GuardianScreen, {
        network: 'Test tokens',
        status: 'ready',
        error: null,
        owner: '6YwqYUYYYYYYYYGSV5w',
        phoneKey: null,
        days: 2,
        mode: 'seeker',
        guardianText: '',
        safeText: '',
        onMode() {},
        onGuardian() {},
        onSafe() {},
        onBack() {},
        onSign: async () => undefined,
      }),
    ),
  );
  assert.match(missing, /Choose a guardian and a safe wallet/);
  assert.match(missing, /Your second Seeker/);
  assert.match(missing, /did not expose a second account/);
  assert.match(missing, /seed phrase/);
  const found = textOf(
    await mount(
      createElement(GuardianScreen, {
        network: 'Test tokens',
        status: 'ready',
        error: null,
        owner: '6YwqYUYYYYYYYYGSV5w',
        phoneKey: '4mKpxxxxxxxxR2vd',
        days: 2,
        mode: 'phone',
        guardianText: '4mKpxxxxxxxxR2vd',
        safeText: '4mKpxxxxxxxxR2vd',
        onMode() {},
        onGuardian() {},
        onSafe() {},
        onBack() {},
        onSign: async () => undefined,
      }),
    ),
  );
  assert.match(found, /4mKp\.\.\.R2vd/);
  assert.match(found, /Not a stolen seed phrase/);
});

test('a cancelled vault signature arms the hold button again', async () => {
  const { GuardianScreen } = await import('../components/hold/GuardianScreen');
  await resignsAfterCancel(
    createElement(GuardianScreen, {
      network: 'Test tokens',
      status: 'ready',
      error: null,
      owner: Keypair.generate().publicKey.toBase58(),
      phoneKey: null,
      days: 2,
      mode: 'seeker',
      guardianText: Keypair.generate().publicKey.toBase58(),
      safeText: Keypair.generate().publicKey.toBase58(),
      onMode() {},
      onGuardian() {},
      onSafe() {},
      onBack() {},
      onSign: async () => undefined,
    }),
    'Press and hold to sign with your key on this phone',
    'open-vault',
    'onSign',
  );
});

test('a held withdrawal shows the chain countdown and Stop as the main action', async () => {
  const { HeldScreen } = await import('../components/hold/HeldScreen');
  const root = await mount(
    createElement(HeldScreen, {
      network: 'Test tokens',
      status: 'ready',
      error: null,
      amountLabel: '1,000',
      tokenName: 'test tokens',
      destinationLabel: '8xQf...Tz9A',
      waitLabel: '2 days',
      countdown,
      untilLabel: 'Sun 27 Sep, 14:12, unless stopped. Blockchain clock.',
      reasons: ['1,000 is over your 50 a day', 'New address', '100% of your vault'],
      toldLine: 'Both phones were told at 14:12. Reminders follow at 1 hour, at 12 hours, every 12 hours, then 6 hours and 1 hour before it goes.',
      dailyLabel: '50',
      onClose() {},
      onAlerts() {},
      onSkip() {},
      onStop: async () => undefined,
      onFreeze: async () => undefined,
    }),
  );
  const text = textOf(root);
  assert.match(text, /Nothing has moved yet/);
  assert.match(text, /1,000 test tokens/);
  assert.match(text, /8xQf\.\.\.Tz9A/);
  assert.match(text, /Blockchain clock/);
  assert.match(text, /1,000 is over your 50 a day/);
  assert.match(text, /New address/);
  assert.match(text, /100% of your vault/);
  assert.ok(
    root.root.findAll((node) => node.props.accessibilityLabel === '1 day, 23 hours, 41 minutes left').length >= 1,
  );
  const buttons = root.root
    .findAll((node) => (node.type as unknown) === 'Pressable')
    .map((node) => String(node.props.accessibilityLabel));
  const stopAt = buttons.findIndex((label) => label.startsWith('Press and hold to stop this withdrawal'));
  const freezeAt = buttons.findIndex((label) => label.startsWith('Press and hold to freeze the whole vault'));
  assert.ok(stopAt >= 0 && freezeAt > stopAt);
  assert.match(
    textOf(
      await mount(
        createElement(HeldScreen, {
          network: 'Test tokens',
          status: 'loading',
          error: null,
          amountLabel: '0',
          tokenName: 'test tokens',
          destinationLabel: '',
          waitLabel: '2 days',
          countdown,
          untilLabel: '',
          reasons: [],
          toldLine: '',
          dailyLabel: '50',
          onClose() {},
          onAlerts() {},
          onSkip() {},
          onStop: async () => undefined,
          onFreeze: async () => undefined,
        }),
      ),
    ),
    /Reading the blockchain/,
  );
  assert.match(
    textOf(
      await mount(
        createElement(HeldScreen, {
          network: 'Test tokens',
          status: 'empty',
          error: null,
          empty: 'No withdrawal is waiting.',
          amountLabel: '0',
          tokenName: 'test tokens',
          destinationLabel: '',
          waitLabel: '2 days',
          countdown,
          untilLabel: '',
          reasons: [],
          toldLine: '',
          dailyLabel: '50',
          onClose() {},
          onAlerts() {},
          onSkip() {},
          onStop: async () => undefined,
          onFreeze: async () => undefined,
        }),
      ),
    ),
    /No withdrawal is waiting/,
  );
});

test('a cancelled stop arms Stop again', async () => {
  const { HeldScreen } = await import('../components/hold/HeldScreen');
  await resignsAfterCancel(
    createElement(HeldScreen, {
      network: 'Test tokens',
      status: 'ready',
      error: null,
      amountLabel: '1,000',
      tokenName: 'test tokens',
      destinationLabel: '8xQf...Tz9A',
      waitLabel: '2 days',
      countdown,
      untilLabel: 'Sun 27 Sep, 14:12, unless stopped. Blockchain clock.',
      reasons: ['New address'],
      toldLine: 'Both phones are told.',
      dailyLabel: '50',
      onClose() {},
      onAlerts() {},
      onSkip() {},
      onStop: async () => undefined,
      onFreeze: async () => undefined,
    }),
    'Press and hold to stop this withdrawal',
    'stop',
    'onStop',
  );
});

test('the alert plan lists the asks and says they cannot be muted', async () => {
  const { AlertPlanScreen } = await import('../components/hold/AlertPlanScreen');
  const text = textOf(
    await mount(
      createElement(AlertPlanScreen, {
        network: 'Test tokens',
        status: 'ready',
        error: null,
        headline: 'Both your phones get each of these while 1,000 test tokens to 8xQf...Tz9A waits. Miss them all and the wait still runs its full 2 days.',
        noticeTitle: 'Held: 1,000 test tokens to a new address',
        noticeBody: 'Goes Sunday 14:12 unless you stop it. Tap to stop.',
        noticeWhen: 'Fri 14:12, both phones',
        rows: [
          { when: 'Fri 14:12', what: 'Held. What, where, when it goes.', state: 'done' },
          { when: 'Sat 14:12', what: 'Reminder, 1 day left.', state: 'next' },
          { when: 'Sun 13:12', what: 'Goes in 1 hour unless stopped.', state: 'later' },
        ],
        onBack() {},
        onStop: async () => undefined,
      }),
    ),
  );
  assert.match(text, /You will be asked more than once/);
  assert.match(text, /1,000 test tokens to 8xQf\.\.\.Tz9A/);
  assert.match(text, /Reminder, 1 day left/);
  assert.match(text, /Goes in 1 hour unless stopped/);
  assert.match(text, /every 15 minutes/);
  assert.match(text, /Hold alerts cannot be muted/);
  assert.match(
    textOf(
      await mount(
        createElement(AlertPlanScreen, {
          network: 'Test tokens',
          status: 'empty',
          error: null,
          headline: '',
          noticeTitle: '',
          noticeBody: '',
          noticeWhen: '',
          rows: [],
          onBack() {},
          onStop: async () => undefined,
        }),
      ),
    ),
    /No withdrawal is waiting/,
  );
});

test('a frozen vault says nothing leaves and Recover goes to the safe address', async () => {
  const { FrozenScreen } = await import('../components/hold/FrozenScreen');
  const text = textOf(
    await mount(
      createElement(FrozenScreen, {
        network: 'Test tokens',
        status: 'ready',
        error: null,
        frozenBy: 'By your guardian key',
        amountLabel: '1,000',
        tokenName: 'test tokens',
        stoppedLine: 'All 1,000 test tokens is still here.',
        sinceLabel: 'Frozen since Fri 25 Sep, 15:02.',
        safeLabel: '4mKp...R2vd',
        records: [
          { time: '14:12', title: 'Held: 1,000 test tokens to 8xQf...Tz9A', detail: 'Asked with your key.', tone: 'bone' },
          { time: '15:02', title: 'Stopped', detail: 'No money moved.', tone: 'stop' },
          { time: '15:02', title: 'Vault frozen by your guardian key', detail: 'Every door is closed.', tone: 'stop' },
        ],
        unfreezeHint: 'Needs both keys, signed separately',
        onClose() {},
        onRecover: async () => undefined,
        onUnfreeze() {},
      }),
    ),
  );
  assert.match(text, /Nothing leaves/);
  assert.match(text, /1,000/);
  assert.match(text, /test tokens/);
  assert.match(text, /By your guardian key/);
  assert.match(text, /Vault frozen by your guardian key/);
  assert.match(text, /4mKp\.\.\.R2vd/);
  assert.match(text, /Needs both keys/);
  assert.match(
    textOf(
      await mount(
        createElement(FrozenScreen, {
          network: 'Test tokens',
          status: 'error',
          error: 'The vault record could not be read.',
          frozenBy: '',
          amountLabel: '',
          tokenName: '',
          stoppedLine: '',
          sinceLabel: '',
          safeLabel: '',
          records: [],
          unfreezeHint: '',
          onClose() {},
          onRecover: async () => undefined,
          onUnfreeze() {},
        }),
      ),
    ),
    /The vault record could not be read/,
  );
});

test('a cancelled recover arms Recover again', async () => {
  const { FrozenScreen } = await import('../components/hold/FrozenScreen');
  await resignsAfterCancel(
    createElement(FrozenScreen, {
      network: 'Test tokens',
      status: 'ready',
      error: null,
      frozenBy: 'By your key',
      amountLabel: '1,000',
      tokenName: 'test tokens',
      stoppedLine: 'Still here.',
      sinceLabel: 'Frozen since Fri.',
      safeLabel: '4mKp...R2vd',
      records: [],
      unfreezeHint: 'Needs both keys, signed separately',
      onClose() {},
      onRecover: async () => undefined,
      onUnfreeze() {},
    }),
    'Press and hold to recover: move all 1,000 to your safe address',
    'recover',
    'onRecover',
  );
});

test('skip with both keys says one key cannot skip and shows a waiting signature', async () => {
  const { SkipScreen } = await import('../components/hold/SkipScreen');
  const waiting = textOf(
    await mount(
      createElement(SkipScreen, {
        network: 'Test tokens',
        purpose: 'skip',
        status: 'ready',
        error: null,
        headline: 'To pay 1,000 test tokens to 8xQf...Tz9A before Sunday 14:12, both keys must sign. One key alone can never skip the wait.',
        yourKey: 'Key 6Ywq...GSV5.',
        guardianKey: 'Key 4mKp...R2vd.',
        signedHere: true,
        waitingLine: '1 of 2 signed. Waiting for the other key.',
        whenBoth: ['1,000 test tokens goes to 8xQf...Tz9A at once.', 'The record says released early by both keys.'],
        payload: 'request',
        onPayload() {},
        onBack() {},
        onSign: async () => undefined,
        signLabel: 'Press and hold to sign with your key on this phone',
        signHint: 'Each signature uses Seed Vault.',
        onCancel() {},
      }),
    ),
  );
  assert.match(waiting, /Two keys, two fingerprints/);
  assert.match(waiting, /One key alone can never skip the wait/);
  assert.match(waiting, /1 of 2 signed/);
  assert.match(waiting, /4mKp\.\.\.R2vd/);
  assert.match(waiting, /blockchain blockhash/);
  assert.match(
    textOf(
      await mount(
        createElement(SkipScreen, {
          network: 'Test tokens',
          purpose: 'skip',
          status: 'loading',
          error: null,
          headline: '',
          yourKey: '',
          guardianKey: '',
          signedHere: false,
          waitingLine: '',
          whenBoth: [],
          payload: '',
          onPayload() {},
          onBack() {},
          onSign: async () => undefined,
          signLabel: 'Sign',
          signHint: 'hint',
          onCancel() {},
        }),
      ),
    ),
    /Reading the blockchain/,
  );
});

test('a vault home shows loading, an error, and a live vault', async () => {
  const { VaultHome } = await import('../components/hold/VaultHome');
  const base = {
    network: 'Test tokens',
    vaults: [] as [],
    onBack() {},
    onSetup() {},
    onOpen() {},
    onSend() {},
  };
  assert.match(textOf(await mount(createElement(VaultHome, { ...base, status: 'loading', error: null }))), /Reading the blockchain/);
  assert.match(
    textOf(await mount(createElement(VaultHome, { ...base, status: 'error', error: 'Vaults could not be read.' }))),
    /Vaults could not be read/,
  );
  const ready = textOf(
    await mount(
      createElement(VaultHome, {
        ...base,
        status: 'ready',
        error: null,
        vaults: [
          {
            address: 'vault',
            amountLabel: '1,000',
            tokenName: 'test tokens',
            dailyLabel: '50',
            waitLabel: '2 days',
            frozen: false,
            pendingLabel: '1,000 test tokens is waiting',
            guardianLabel: '4mKp...R2vd',
            safeLabel: '4mKp...R2vd',
          },
        ],
      }),
    ),
  );
  assert.match(ready, /1,000/);
  assert.match(ready, /50 a day/);
  assert.match(ready, /waits 2 days/);
  assert.match(ready, /1,000 test tokens is waiting/);
});

test('home and rules share one Hold entry', async () => {
  const { HoldEntry } = await import('../components/hold/HoldEntry');
  const text = textOf(await mount(createElement(HoldEntry, { cluster: 'devnet' })));
  assert.match(text, /Big money waits, and a second key can say no/);
  assert.match(text, /they cannot finish it/);
});

const guardBase = {
  network: 'Devnet, a test network',
  ownerLabel: '6Ywq...GSV5',
  amountLabel: '1,000',
  hasMoney: true,
  tokenName: 'USDC',
  frozen: false,
  waiting: {
    amountLabel: '400',
    destinationLabel: '8xQf...Tz9A',
    untilLabel: 'Waits until Thu 16 Nov, 22:13, unless stopped.',
  },
  changeLines: [] as string[],
  changeAtLabel: null as string | null,
  safeAddress: '4mKpSafeAddressFullR2vd',
  safeLabel: '4mKp...R2vd',
  result: null,
  onClose() {},
  onStop: async () => undefined,
  onFreeze: async () => undefined,
  onRecover: async () => undefined,
  onOpenLink() {},
};

test('the guardian screen says what waits and offers stop and freeze, and nothing else', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const root = await mount(createElement(GuardScreen, { ...guardBase, status: 'ready', error: null }));
  const text = textOf(root);
  assert.match(text, /This vault belongs to 6Ywq\.\.\.GSV5\. It holds 1,000 USDC\. Your key is its guardian/);
  assert.match(text, /Waiting to leave/);
  assert.match(text, /400/);
  assert.match(text, /To 8xQf\.\.\.Tz9A\. Waits until Thu 16 Nov, 22:13, unless stopped\./);
  assert.match(text, /Stop this withdrawal/);
  assert.match(text, /Freeze the vault/);
  assert.match(text, /400 USDC stays in the vault/);
  assert.match(text, /Move everything to the safe address/);
  assert.doesNotMatch(text, /Unfreeze|Let it go|both keys|[Ss]ettings/);
  assert.doesNotMatch(text, /[\u2013\u2014]/);
});

test('the guardian screen names the safe address before moving everything', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  let recovered = 0;
  const root = await mount(
    createElement(GuardScreen, {
      ...guardBase,
      status: 'ready',
      error: null,
      onRecover: async () => {
        recovered += 1;
      },
    }),
  );
  assert.doesNotMatch(textOf(root), /goes to the safe address/);
  await act(async () => {
    pressable(root, 'Move everything to the safe address').props.onPress();
  });
  assert.match(
    textOf(root),
    /All 1,000 USDC goes to the safe address 4mKpSafeAddressFullR2vd\. Nothing else can receive it\./,
  );
  await act(async () => {
    pressable(root, 'Move everything to the safe address').props.onLongPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(recovered, 1);
});

test('the guardian screen explains a proposed change and a frozen vault', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const change = textOf(
    await mount(
      createElement(GuardScreen, {
        ...guardBase,
        status: 'ready',
        error: null,
        waiting: null,
        changeLines: ['The everyday limit goes up from 50 USDC to 500 USDC a day'],
        changeAtLabel: 'Wed 15 Nov, 22:13',
      }),
    ),
  );
  assert.match(change, /A settings change is waiting/);
  assert.match(change, /The everyday limit goes up from 50 USDC to 500 USDC a day\./);
  assert.match(change, /It applies Wed 15 Nov, 22:13\./);
  assert.match(change, /Freezing does not stop the change/);
  assert.doesNotMatch(change, /Stop this withdrawal/);
  assert.match(change, /Freeze the vault/);

  const frozen = textOf(
    await mount(createElement(GuardScreen, { ...guardBase, status: 'ready', error: null, frozen: true })),
  );
  assert.match(frozen, /The vault is frozen\. Withdrawals cannot leave\./);
  assert.doesNotMatch(frozen, /Freeze the vault/);
  assert.match(frozen, /Stop this withdrawal/);
  assert.match(frozen, /Removes it for good\. The vault stays frozen\./);
});

test('after a brake the guardian screen shows the confirmed result and the transaction link', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const opened: string[] = [];
  const root = await mount(
    createElement(GuardScreen, {
      ...guardBase,
      status: 'ready',
      error: null,
      waiting: null,
      result: {
        line: 'Stopped. 400 USDC to 8xQf...Tz9A will not be paid.',
        link: 'https://explorer.solana.com/tx/abc?cluster=devnet',
      },
      onOpenLink: (link: string) => opened.push(link),
    }),
  );
  const text = textOf(root);
  assert.match(text, /Confirmed on the blockchain/);
  assert.match(text, /Stopped\. 400 USDC to 8xQf\.\.\.Tz9A will not be paid\./);
  await act(async () => {
    pressable(root, 'See the transaction').props.onPress();
  });
  assert.deepEqual(opened, ['https://explorer.solana.com/tx/abc?cluster=devnet']);
});

test('the guardian screen says so when the connected key is not the guardian', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const text = textOf(
    await mount(
      createElement(GuardScreen, {
        ...guardBase,
        status: 'error',
        error: 'The connected key is not the guardian of this vault. Connect the guardian key to brake it.',
      }),
    ),
  );
  assert.match(text, /not the guardian of this vault/);
  assert.doesNotMatch(text, /Stop this withdrawal/);
});

test('the owner held screen explains when the guardian phone checks only when a guardian is set', async () => {
  const { HeldScreen } = await import('../components/hold/HeldScreen');
  const props = {
    network: 'Test tokens',
    status: 'ready' as const,
    error: null,
    amountLabel: '400',
    tokenName: 'USDC',
    destinationLabel: '8xQf...Tz9A',
    waitLabel: '2 days',
    countdown,
    untilLabel: 'Thu 16 Nov, 22:13, unless stopped. Blockchain clock.',
    reasons: ['New address'],
    toldLine: 'Both phones were told.',
    dailyLabel: '50',
    onClose() {},
    onAlerts() {},
    onSkip() {},
    onStop: async () => undefined,
    onFreeze: async () => undefined,
  };
  const withGuardian = await mount(createElement(HeldScreen, { ...props, guardianLine: "Your guardian's phone is told when it next checks, and it can stop this." }));
  assert.match(
    textOf(withGuardian),
    /Your guardian's phone is told when it next checks, and it can stop this./,
  );
  assert.ok(
    withGuardian.root.findAll((node) => node.props.accessibilityLabel === 'Guardian set').length >= 1,
    'the lamp says the guardian is set, not alerted',
  );
  assert.equal(
    withGuardian.root.findAll((node) => node.props.accessibilityLabel === 'Guardian alerted').length,
    0,
  );
  assert.doesNotMatch(
    textOf(await mount(createElement(HeldScreen, { ...props, guardianLine: null }))),
    /Your guardian's phone is told when it next checks, and it can stop this./,
  );
});

test('the Hold home lists the vaults you guard with their state', async () => {
  const { VaultHome } = await import('../components/hold/VaultHome');
  const guarded: string[] = [];
  const root = await mount(
    createElement(VaultHome, {
      network: 'Test tokens',
      status: 'ready',
      error: null,
      vaults: [],
      guarded: [
        {
          address: 'A',
          ownerLabel: '6Ywq...GSV5',
          amountLabel: '1,000',
          tokenName: 'USDC',
          state: 'normal',
          stateLabel: 'Normal. Nothing is waiting.',
        },
        {
          address: 'B',
          ownerLabel: '9Abc...Q1xz',
          amountLabel: '20',
          tokenName: 'USDC',
          state: 'waiting',
          stateLabel: 'Waiting: 5 USDC to 8xQf...Tz9A.',
        },
        {
          address: 'C',
          ownerLabel: '3Def...K7mn',
          amountLabel: '0',
          tokenName: 'USDC',
          state: 'frozen',
          stateLabel: 'Frozen. Nothing can leave.',
        },
      ],
      onBack() {},
      onSetup() {},
      onOpen() {},
      onSend() {},
      onGuard: (address: string) => guarded.push(address),
    }),
  );
  const text = textOf(root);
  assert.match(text, /Vaults you guard/);
  assert.match(text, /Vault of 6Ywq\.\.\.GSV5: 1,000 USDC/);
  assert.match(text, /Normal\. Nothing is waiting\./);
  assert.match(text, /Waiting: 5 USDC to 8xQf\.\.\.Tz9A\./);
  assert.match(text, /Frozen\. Nothing can leave\./);
  assert.doesNotMatch(text, /Your vault/);
  await act(async () => {
    pressable(root, 'Vault of 9Abc...Q1xz').props.onPress();
  });
  assert.deepEqual(guarded, ['B']);
});


test('an empty vault does not offer recovery even when zero has decimal places', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const root = await mount(createElement(GuardScreen, { ...guardBase, status: 'ready', amountLabel: '0.00', hasMoney: false }));
  assert.doesNotMatch(textOf(root), /Move everything to the safe address/);
});

test('a funded vault offers recovery even when its displayed amount rounds to zero', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const root = await mount(createElement(GuardScreen, { ...guardBase, status: 'ready', amountLabel: '0', hasMoney: true }));
  assert.match(textOf(root), /Move everything to the safe address/);
});

test('the guardian can recover at any time', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const root = await mount(createElement(GuardScreen, { ...guardBase, status: 'ready' }));
  assert.match(textOf(root), /You can also move everything to the safe address at any time. It can only go there./);
});

test('keeping the money in the vault has a 48dp touch target', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const root = await mount(createElement(GuardScreen, { ...guardBase, status: 'ready' }));
  await act(async () => { pressable(root, 'Move everything to the safe address').props.onPress(); });
  assert.ok(pressable(root, 'Keep the money in the vault').props.style.minHeight >= 48);
});

test('a stale notification explains the missing withdrawal without offering Stop', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const root = await mount(createElement(GuardScreen, { ...guardBase, status: 'ready', waiting: null, missingWithdrawal: true }));
  assert.match(textOf(root), /The withdrawal you were told about is no longer waiting./);
  assert.doesNotMatch(textOf(root), /Stop this withdrawal|Nothing is waiting right now/);
});

test('a stale notification lists the withdrawals still waiting and lets the guardian pick one', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const picked: string[] = [];
  const root = await mount(
    createElement(GuardScreen, {
      ...guardBase,
      status: 'ready',
      error: null,
      waiting: null,
      missingWithdrawal: true,
      moreWaiting: 1,
      waitingOthers: [
        {
          id: '7',
          amountLabel: '400',
          destinationLabel: '8xQf...Tz9A',
          untilLabel: 'Waits until Thu 16 Nov, 22:13, unless stopped.',
        },
      ],
      onPick: (id: string) => picked.push(id),
    }),
  );
  const text = textOf(root);
  assert.match(text, /The withdrawal you were told about is no longer waiting\./);
  assert.match(text, /1 withdrawal is waiting\./);
  assert.match(text, /400 USDC to 8xQf\.\.\.Tz9A\./);
  assert.doesNotMatch(text, /Stop this withdrawal|Nothing is waiting right now/);
  await act(async () => {
    pressable(root, 'Review the withdrawal of 400 USDC to 8xQf...Tz9A').props.onPress();
  });
  assert.deepEqual(picked, ['7']);

  const plural = textOf(
    await mount(
      createElement(GuardScreen, {
        ...guardBase,
        status: 'ready',
        error: null,
        waiting: null,
        missingWithdrawal: true,
        moreWaiting: 2,
        waitingOthers: [
          {
            id: '7',
            amountLabel: '400',
            destinationLabel: '8xQf...Tz9A',
            untilLabel: 'Waits until Thu 16 Nov, 22:13, unless stopped.',
          },
          {
            id: '8',
            amountLabel: '25',
            destinationLabel: '4mKp...R2vd',
            untilLabel: 'Waits until Fri 17 Nov, 10:00, unless stopped.',
          },
        ],
        onPick() {},
      }),
    ),
  );
  assert.match(plural, /2 withdrawals are waiting\./);
  assert.match(plural, /400 USDC/);
  assert.match(plural, /25 USDC/);
});

test('the transaction link has a 48dp touch target', async () => {
  const { GuardScreen } = await import('../components/hold/GuardScreen');
  const root = await mount(
    createElement(GuardScreen, {
      ...guardBase,
      status: 'ready',
      error: null,
      waiting: null,
      result: {
        line: 'Stopped. 400 USDC to 8xQf...Tz9A will not be paid.',
        link: 'https://explorer.solana.com/tx/abc?cluster=devnet',
      },
    }),
  );
  assert.ok(pressable(root, 'See the transaction').props.style.minHeight >= 48);
});


test('home and rules have no Hold entry on mainnet', async () => {
  const { HoldEntry } = await import('../components/hold/HoldEntry');
  const root = await mount(createElement(HoldEntry, { cluster: 'mainnet-beta' }));
  assert.equal(root.toJSON(), null);
});


test('safe wallet setup requires entry, refuses the guardian, and reviews the full independent address', async () => {
  const { GuardianScreen } = await import('../components/hold/GuardianScreen');
  const owner = Keypair.generate().publicKey.toBase58();
  const guardian = Keypair.generate().publicKey.toBase58();
  const safe = Keypair.generate().publicKey.toBase58();
  let signed: string | null = null;
  function Setup() {
    const [address, setAddress] = useState('');
    return createElement(GuardianScreen, {
      network: 'Devnet', status: 'ready', owner, phoneKey: guardian, days: 2,
      mode: 'phone', guardianText: guardian, safeText: address,
      onMode() {}, onGuardian() {}, onSafe: setAddress, onBack() {},
      onSign: async () => { signed = address; },
    });
  }
  const root = await mount(createElement(Setup));
  const input = () => root.root.findAll((n) => (n.type as unknown) === 'TextInput' && n.props.accessibilityLabel === 'Safe address')[0];
  assert.equal(input().props.value, '');
  assert.equal(pressable(root, 'Review safe address').props.disabled, true);
  await act(async () => input().props.onChangeText(guardian));
  assert.match(textOf(root), /guardian does not control/);
  assert.equal(pressable(root, 'Review safe address').props.disabled, true);
  await act(async () => input().props.onChangeText(safe));
  await act(async () => pressable(root, 'Review safe address').props.onPress());
  assert.ok(textOf(root).includes(safe));
  assert.match(textOf(root), /Confirm your safe address/);
  await act(async () => pressable(root, 'Press and hold to sign').props.onLongPress());
  assert.equal(signed, safe);
  await act(async () => root.unmount());
});

test('owner recovery needs explicit confirmation and editing clears consent and review', async () => {
  const { GuardianScreen } = await import('../components/hold/GuardianScreen');
  const owner = Keypair.generate().publicKey.toBase58();
  const guardian = Keypair.generate().publicKey.toBase58();
  let accepted: boolean | undefined;
  function Setup() {
    const [address, setAddress] = useState(owner);
    return createElement(GuardianScreen, {
      network: 'Devnet', status: 'ready', owner, phoneKey: null, days: 2,
      mode: 'seeker', guardianText: guardian, safeText: address,
      onMode() {}, onGuardian() {}, onSafe: setAddress, onBack() {},
      onSign: async (confirmed) => { accepted = confirmed; },
    });
  }
  const root = await mount(createElement(Setup));
  assert.match(textOf(root), /stolen owner key would also reach the safe address/);
  assert.equal(pressable(root, 'Review safe address').props.disabled, true);
  await act(async () => pressable(root, 'I accept the owner wallet recovery risk').props.onPress());
  await act(async () => pressable(root, 'Review safe address').props.onPress());
  assert.ok(textOf(root).includes(owner));
  await act(async () => pressable(root, 'Press and hold to sign').props.onLongPress());
  assert.equal(accepted, true);
  const input = () => root.root.findAll((n) => (n.type as unknown) === 'TextInput' && n.props.accessibilityLabel === 'Safe address')[0];
  await act(async () => input().props.onChangeText(''));
  await act(async () => input().props.onChangeText(owner));
  assert.equal(pressable(root, 'Review safe address').props.disabled, true);
  assert.doesNotMatch(textOf(root), /Confirm your safe address/);
  await act(async () => root.unmount());
});
