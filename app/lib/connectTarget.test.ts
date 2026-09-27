import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { Keypair } from '@solana/web3.js';
import { act, createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;
process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER = 'devnet';

const SEEKER_LINE = 'You will approve with your Seeker ID (Seed Vault).';
const NETWORK_LINE = 'This app uses devnet. The wallet must be on devnet.';
const SOLANA_MOBILE_BASE = 'https://connect.solanamobile.com';

const owner = Keypair.generate();
const memory = new Map<string, string>();
const calls: Array<{ baseUri?: string } | undefined> = [];
let installed = true;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode } & Record<string, unknown>) {
    return createElement(type, props, props.children);
  };
}

mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 48, right: 0, bottom: 0, left: 0 }),
  },
});

mock.module('react-native', {
  namedExports: {
    ActivityIndicator: Host('ActivityIndicator'),
    Platform: { OS: 'android' },
    NativeModules: {},
    Pressable: Host('Pressable'),
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
    },
    Text: Host('Text'),
    View: Host('View'),
  },
});

mock.module('./installedPackage', {
  namedExports: {
    SOLANA_MOBILE_WALLET_PACKAGE: 'com.solanamobile.wallet',
    SOLANA_MOBILE_WALLET_BASE_URI: SOLANA_MOBILE_BASE,
    isSolanaMobileWalletInstalled: async () => installed,
  },
});

mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async (key: string) => memory.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        memory.set(key, value);
      },
      deleteItem: async (key: string) => {
        memory.delete(key);
      },
    },
    transact: async (
      callback: (wallet: {
        authorize: () => Promise<unknown>;
        deauthorize: () => Promise<void>;
      }) => Promise<unknown>,
      config?: { baseUri?: string },
    ) => {
      calls.push(config);
      return callback({
        async authorize() {
          return {
            accounts: [
              {
                address: Buffer.from(owner.publicKey.toBytes()).toString('base64'),
                publicKey: owner.publicKey.toBytes(),
              },
            ],
            auth_token: 'tok',
            wallet_uri_base: 'https://connect.solanamobile.com',
          };
        },
        async deauthorize() {
          return undefined;
        },
      });
    },
  },
});

type Loaded = {
  ConnectGate: (props: { children: ReactNode }) => ReactNode;
  WalletProvider: (props: { children: ReactNode }) => ReactNode;
  OnboardingProvider: (props: { children: ReactNode }) => ReactNode;
  Text: ComponentType<{ children?: ReactNode }>;
};

let ui: Loaded;

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
}

function visibleText(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => isHost(node, 'Text'))
    .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''))
    .join('\n');
}

function button(root: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return root.root
    .findAll((node) => isHost(node, 'Pressable'))
    .find((node) => node.props.accessibilityLabel === label);
}

async function mount(): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(
      createElement(
        ui.WalletProvider,
        null,
        createElement(
          ui.OnboardingProvider,
          null,
          createElement(ui.ConnectGate, {
            children: createElement(ui.Text, null, 'home'),
          }),
        ),
      ) as ReactElement,
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(root);
  return root;
}

async function settle(root: ReactTestRenderer, ready: (text: string) => boolean): Promise<string> {
  for (let i = 0; i < 40; i += 1) {
    const text = visibleText(root);
    if (ready(text)) {
      return text;
    }
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  assert.fail(visibleText(root));
}

test.before(async () => {
  const [connect, useWallet, onboarding, rn] = await Promise.all([
    import('../components/ConnectGate'),
    import('./useWallet'),
    import('./useOnboarding'),
    import('react-native'),
  ]);
  ui = {
    ConnectGate: connect.ConnectGate,
    WalletProvider: useWallet.WalletProvider,
    OnboardingProvider: onboarding.OnboardingProvider,
    Text: rn.Text,
  };
});

test.beforeEach(() => {
  memory.clear();
  memory.set('veto.onboarding.seen', '1');
  calls.length = 0;
  installed = true;
});

test('the devnet notice on a screen outside the safe area sits below the status bar', async () => {
  const root = await mount();
  await settle(root, (value) => value.includes(SEEKER_LINE));
  const connectButton = button(root, 'Open Solana Mobile wallet');
  assert.ok(connectButton);
  await act(async () => {
    connectButton.props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await settle(root, (value) => value.includes('home') && value.includes(NETWORK_LINE));
  const notice = root.root
    .findAll((node) => isHost(node, 'Text'))
    .find((node) => node.children.some((child) => typeof child === 'string' && child.includes('This app uses devnet')));
  assert.ok(notice);
  let safe = false;
  let parent = notice.parent;
  while (parent) {
    if (isHost(parent, 'SafeAreaView') && Array.isArray(parent.props.edges) && parent.props.edges.includes('top')) {
      safe = true;
    }
    parent = parent.parent;
  }
  assert.equal(safe, true);
});

test('Connect names Seeker ID and targets the Solana Mobile wallet when it is installed', async () => {
  const root = await mount();
  const text = await settle(root, (value) => value.includes('Connect') || value.includes(SEEKER_LINE));
  assert.ok(text.includes(SEEKER_LINE), text);
  assert.ok(text.includes(NETWORK_LINE), text);
  const connectButton = button(root, 'Open Solana Mobile wallet');
  const otherButton = button(root, 'Use another wallet');
  assert.ok(connectButton, text);
  assert.ok(otherButton, text);
  await act(async () => {
    connectButton.props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await settle(root, (value) => value.includes('home'));
  assert.equal(calls[0]?.baseUri, SOLANA_MOBILE_BASE);
});

test('Use another wallet keeps the system chooser', async () => {
  const root = await mount();
  await settle(root, (value) => value.includes(SEEKER_LINE));
  const otherButton = button(root, 'Use another wallet');
  assert.ok(otherButton);
  await act(async () => {
    otherButton.props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await settle(root, (value) => value.includes('home'));
  assert.equal(calls[0]?.baseUri, undefined);
});

test('without the Solana Mobile wallet, Connect keeps the system chooser', async () => {
  installed = false;
  const root = await mount();
  const text = await settle(root, (value) => value.includes(SEEKER_LINE));
  assert.equal(button(root, 'Use another wallet'), undefined);
  const connectButton = button(root, 'Open Solana Mobile wallet');
  assert.ok(connectButton, text);
  await act(async () => {
    connectButton.props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await settle(root, (value) => value.includes('home'));
  assert.equal(calls[0]?.baseUri, undefined);
});
