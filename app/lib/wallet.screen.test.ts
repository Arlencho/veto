import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { Keypair, Transaction } from '@solana/web3.js';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER = 'devnet';

const NO_ANSWER = 'The wallet closed without signing, so nothing was sent.';
const REJECTED = 'The wallet rejected the request.';
const CLOSED = 'The wallet closed the session without a signature.';
const NOT_YET_VISIBLE =
  'The transaction has not appeared on devnet yet. It may still land, so check your rules before trying again. The wallet must be on devnet.';

const owner = Keypair.generate();
const memory = new Map<string, string>();
let mode: 'cancel' | 'reject' | 'empty' | 'missing' = 'cancel';

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode } & Record<string, unknown>) {
    return createElement(type, props, props.children);
  };
}

mock.module('react-native', {
  namedExports: {
    Platform: { OS: 'android' },
    NativeModules: {},
    Pressable: Host('Pressable'),
    Text: Host('Text'),
    View: Host('View'),
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
    },
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
    transact: async (callback: (wallet: unknown) => Promise<unknown>) =>
      callback({
        async authorize() {
          return {
            accounts: [
              {
                address: Buffer.from(owner.publicKey.toBytes()).toString('base64'),
                publicKey: owner.publicKey.toBytes(),
              },
            ],
            auth_token: 'auth-1',
          };
        },
        async deauthorize() {
          return undefined;
        },
        async signAndSendTransactions() {
          if (mode === 'cancel') {
            throw new Error('Local association cancelled by user');
          }
          if (mode === 'reject') {
            throw new Error('User rejected the request');
          }
          if (mode === 'empty') {
            return [];
          }
          return ['sig-not-on-devnet'];
        },
      }),
  },
});

function textOf(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''))
    .join('\n');
}

test('the screen that asked shows each wallet outcome', async () => {
  const { WalletProvider, useWallet } = await import('./useWallet');
  const { Text } = await import('react-native');
  const { signatureConfirmation } = await import('./wallet');
  signatureConfirmation.timeoutMs = 0;
  signatureConfirmation.lookup = async () => 'missing';
  signatureConfirmation.contextSlot = async () => undefined;

  function AskingScreen() {
    const wallet = useWallet();
    return createElement(
      'View',
      null,
      createElement(Text, null, wallet.ready ? (wallet.error ?? 'no error') : 'loading'),
      createElement('Pressable', {
        accessibilityLabel: 'Sign',
        onPress: () => {
          void wallet.signAndSend([new Transaction()]).catch(() => undefined);
        },
      }),
    );
  }

  async function shown(next: typeof mode, expected: string): Promise<void> {
    mode = next;
    memory.clear();
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        createElement(WalletProvider, null, createElement(AskingScreen)) as ReactElement,
      );
      await new Promise((resolve) => setImmediate(resolve));
    });
    const mounted = root;
    for (let i = 0; i < 30 && textOf(mounted).includes('loading'); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
    }
    const button = mounted.root.findAll((node) => (node.type as unknown) === 'Pressable')[0];
    assert.ok(button, 'the screen that asked has the sign control');
    await act(async () => {
      button.props.onPress();
      await new Promise((resolve) => setImmediate(resolve));
    });
    for (let i = 0; i < 30 && !textOf(mounted).includes(expected); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
    }
    assert.ok(textOf(mounted).includes(expected), textOf(mounted));
    await act(async () => {
      mounted.unmount();
    });
  }

  await shown('cancel', NO_ANSWER);
  await shown('reject', REJECTED);
  await shown('empty', CLOSED);
  await shown('missing', NOT_YET_VISIBLE);
});
