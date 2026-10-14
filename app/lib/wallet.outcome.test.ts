import assert from 'node:assert/strict';
import test from 'node:test';

import { Buffer } from 'buffer';
import { Keypair, Transaction } from '@solana/web3.js';

import {
  explainWalletFailure,
  SESSION_STORE_KEY,
  connect,
  disconnect,
  loadSession,
  readContextSlot,
  signAndSendTransactions,
  signatureConfirmation,
  type MwaWallet,
  type TransactFn,
  type WalletStore,
} from './wallet';

process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER = 'devnet';
// No test here reaches an RPC for the context slot unless it sets one.
signatureConfirmation.contextSlot = async () => undefined;

const CANCELLED = 'You cancelled the wallet request.';
const REJECTED = 'The wallet rejected the request.';
const CLOSED = 'The wallet closed the session without a signature.';
const NO_ANSWER = 'The wallet closed without signing, so nothing was sent.';
const NOT_ON_CLUSTER =
  'The wallet did not submit the transaction. This app uses devnet. The wallet must be on devnet.';
const NOT_YET_VISIBLE =
  'The transaction has not appeared on devnet yet. It may still land, so check your rules before trying again. The wallet must be on devnet.';
const SEEN_UNCONFIRMED =
  'The transaction was seen on devnet but is not confirmed yet. It may still land, so check your rules before trying again.';
const SOLANA_MOBILE_BASE = 'https://connect.solanamobile.com';

type Association = { baseUri?: string } | undefined;
type SignOptions = {
  timeoutMs?: number;
  lookup?: (signature: string) => Promise<'confirmed' | 'missing' | 'failed' | 'seen'>;
};
type ConnectOptions = { baseUri?: string; chooser?: boolean };

function memoryStore(): WalletStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    async getItem(key) {
      return data[key] ?? null;
    },
    async setItem(key, value) {
      data[key] = value;
    },
    async deleteItem(key) {
      delete data[key];
    },
  };
}

function ownerAccount(owner: Keypair): { address: string; publicKey: Uint8Array } {
  return {
    address: Buffer.from(owner.publicKey.toBytes()).toString('base64'),
    publicKey: owner.publicKey.toBytes(),
  };
}

function recordingTransact(wallet: MwaWallet, calls: Association[]): TransactFn {
  const fn = async (callback: (wallet: MwaWallet) => Promise<unknown>, config?: Association) => {
    calls.push(config);
    return callback(wallet);
  };
  return fn as TransactFn;
}

async function sign(
  transact: TransactFn,
  store: WalletStore,
  options?: SignOptions,
): Promise<string[]> {
  const fn = signAndSendTransactions as (
    transact: TransactFn,
    store: WalletStore,
    transactions: Transaction[],
    options?: SignOptions,
  ) => Promise<string[]>;
  return fn(transact, store, [new Transaction()], options);
}

async function connectWith(
  transact: TransactFn,
  store: WalletStore,
  owner: Keypair,
  options?: ConnectOptions,
) {
  const fn = connect as (
    transact: TransactFn,
    store: WalletStore,
    generate?: () => Keypair,
    options?: ConnectOptions,
  ) => ReturnType<typeof connect>;
  return fn(transact, store, () => owner, options);
}

function walletReturning(result: {
  signatures?: string[];
  throwOnAuthorize?: unknown;
  throwOnSign?: unknown;
  walletUriBase?: string;
  owner: Keypair;
}): MwaWallet {
  return {
    async authorize() {
      if (result.throwOnAuthorize) {
        throw result.throwOnAuthorize;
      }
      return {
        accounts: [ownerAccount(result.owner)],
        auth_token: 'auth-1',
        ...(result.walletUriBase ? { wallet_uri_base: result.walletUriBase } : {}),
      };
    },
    async deauthorize() {
      return undefined;
    },
    async signAndSendTransactions() {
      if (result.throwOnSign) {
        throw result.throwOnSign;
      }
      return result.signatures as string[];
    },
  };
}

type StatusName = 'processed' | 'confirmed';

let statusProbe: Promise<void> = Promise.resolve();

function runAlone<T>(body: () => Promise<T>): Promise<T> {
  const run = statusProbe.then(body, body);
  statusProbe = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function statusResult(name: StatusName) {
  return {
    context: { slot: 1 },
    value: [{ err: null, slot: 1, confirmations: null, confirmationStatus: name }],
  };
}

function restoreConfirmation(saved: {
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  openConnection: typeof signatureConfirmation.openConnection;
}): void {
  signatureConfirmation.timeoutMs = saved.timeoutMs;
  signatureConfirmation.pollMs = saved.pollMs;
  signatureConfirmation.now = saved.now;
  signatureConfirmation.sleep = saved.sleep;
  signatureConfirmation.openConnection = saved.openConnection;
}

test('a session the adapter tears down is not blamed on the person', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(
    walletReturning({
      owner,
      throwOnSign: new Error('Local association cancelled by user'),
    }),
    [],
  );
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === NO_ANSWER,
  );
});

test('a wallet cancel that is not the adapter teardown still reads as cancelled', async () => {
  assert.equal(explainWalletFailure(new Error('Request cancelled'), 'devnet'), CANCELLED);
});

test('the sign request carries the current slot as minContextSlot', async () => {
  const owner = Keypair.generate();
  const signature = 'sig-slot';
  const seen: Array<Record<string, unknown>> = [];
  const wallet = walletReturning({ owner, signatures: [signature] });
  const inner = wallet.signAndSendTransactions!;
  wallet.signAndSendTransactions = async (params) => {
    seen.push(params as unknown as Record<string, unknown>);
    return inner(params);
  };
  const saved = signatureConfirmation.contextSlot;
  signatureConfirmation.contextSlot = async () => 4242;
  try {
    await signAndSendTransactions(recordingTransact(wallet, []), memoryStore(), [new Transaction()], {
      lookup: async () => 'confirmed',
    });
  } finally {
    signatureConfirmation.contextSlot = saved;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.minContextSlot, 4242);
  assert.equal(seen[0]?.commitment, 'confirmed');
});

test('the sign request leaves minContextSlot out when no slot is known', async () => {
  const owner = Keypair.generate();
  const seen: Array<Record<string, unknown>> = [];
  const wallet = walletReturning({ owner, signatures: ['sig-noslot'] });
  const inner = wallet.signAndSendTransactions!;
  wallet.signAndSendTransactions = async (params) => {
    seen.push(params as unknown as Record<string, unknown>);
    return inner(params);
  };
  await signAndSendTransactions(recordingTransact(wallet, []), memoryStore(), [new Transaction()], {
    lookup: async () => 'confirmed',
  });
  assert.equal(seen.length, 1);
  assert.equal('minContextSlot' in (seen[0] ?? {}), false);
});

test('the slot reader asks the RPC at confirmed and survives an RPC failure', async () => {
  const saved = signatureConfirmation.openConnection;
  const asked: unknown[] = [];
  try {
    signatureConfirmation.openConnection = async () => ({
      async getSlot(commitment?: 'confirmed') {
        asked.push(commitment);
        return 777;
      },
      async getSignatureStatuses() {
        return { value: [] };
      },
    });
    assert.equal(await readContextSlot(), 777);
    assert.deepEqual(asked, ['confirmed']);
    signatureConfirmation.openConnection = async () => ({
      async getSlot() {
        throw new Error('rpc down');
      },
      async getSignatureStatuses() {
        return { value: [] };
      },
    });
    assert.equal(await readContextSlot(), undefined);
    signatureConfirmation.openConnection = async () => {
      throw new Error('no config');
    };
    assert.equal(await readContextSlot(), undefined);
  } finally {
    signatureConfirmation.openConnection = saved;
  }
});

test('a rejected sign tells the person the wallet rejected the request', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(
    walletReturning({ owner, throwOnSign: new Error('User rejected the request') }),
    [],
  );
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === REJECTED,
  );
});

test('an authorization failure from the wallet is told as a rejection', async () => {
  const owner = Keypair.generate();
  const failed = new Error('authorization failed');
  (failed as Error & { code: number }).code = -1;
  const transact = recordingTransact(walletReturning({ owner, throwOnAuthorize: failed }), []);
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === REJECTED,
  );
});

test('a wallet that reports the transaction was not submitted names the network', async () => {
  const owner = Keypair.generate();
  const failed = new Error('not submitted');
  (failed as Error & { code: number }).code = -4;
  const transact = recordingTransact(walletReturning({ owner, throwOnSign: failed }), []);
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === NOT_ON_CLUSTER,
  );
});

test('a session that closes before it returns a signature says so', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(
    walletReturning({
      owner,
      throwOnSign: new Error('The wallet session was closed before connection.'),
    }),
    [],
  );
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === CLOSED,
  );
});

test('a sign that returns no signature says the session closed without one', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(walletReturning({ owner, signatures: [] }), []);
  await assert.rejects(
    () => sign(transact, memoryStore()),
    (err: unknown) => err instanceof Error && err.message === CLOSED,
  );
});

test('a signature still absent when the wait ends says it has not appeared and may still land', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(
    walletReturning({ owner, signatures: ['sig-not-on-devnet'] }),
    [],
  );
  await assert.rejects(
    () =>
      sign(transact, memoryStore(), {
        timeoutMs: 0,
        lookup: async () => 'missing',
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, NOT_YET_VISIBLE);
      return true;
    },
  );
});

test('a signature the configured RPC confirms is returned', async () => {
  const owner = Keypair.generate();
  const transact = recordingTransact(walletReturning({ owner, signatures: ['sig-ok'] }), []);
  const signatures = await sign(transact, memoryStore(), {
    timeoutMs: 0,
    lookup: async () => 'confirmed',
  });
  assert.deepEqual(signatures, ['sig-ok']);
});

test('connect stores the wallet base URI and later sessions pass it to transact', async () => {
  const owner = Keypair.generate();
  const store = memoryStore();
  const calls: Association[] = [];
  const wallet = walletReturning({
    owner,
    walletUriBase: 'https://wallet.example/mwa',
    signatures: ['sig-ok'],
  });
  const transact = recordingTransact(wallet, calls);
  await connectWith(transact, store, owner);
  const stored = await loadSession(store);
  assert.equal(stored?.walletUriBase, 'https://wallet.example/mwa');

  calls.length = 0;
  await sign(transact, store, { timeoutMs: 0, lookup: async () => 'confirmed' });
  assert.equal(calls[0]?.baseUri, 'https://wallet.example/mwa');
});

test('disconnect sends the stored base URI and then clears it', async () => {
  const owner = Keypair.generate();
  const store = memoryStore();
  const calls: Association[] = [];
  const wallet = walletReturning({ owner, walletUriBase: 'https://wallet.example/mwa' });
  const transact = recordingTransact(wallet, calls);
  await connectWith(transact, store, owner);
  calls.length = 0;
  await disconnect(transact, store);
  assert.equal(calls[0]?.baseUri, 'https://wallet.example/mwa');
  assert.equal(await loadSession(store), null);
  assert.equal(store.data[SESSION_STORE_KEY], undefined);

  calls.length = 0;
  const signed = walletReturning({
    owner,
    signatures: ['sig-ok'],
  });
  await sign(recordingTransact(signed, calls), store, {
    timeoutMs: 0,
    lookup: async () => 'confirmed',
  });
  assert.equal(calls[0]?.baseUri, undefined);
});

test('primary connect targets the Solana Mobile wallet, and the chooser does not', async () => {
  const owner = Keypair.generate();
  const calls: Association[] = [];
  const wallet = walletReturning({ owner, walletUriBase: SOLANA_MOBILE_BASE });
  const transact = recordingTransact(wallet, calls);

  await connectWith(transact, memoryStore(), owner, { baseUri: SOLANA_MOBILE_BASE });
  assert.equal(calls[0]?.baseUri, SOLANA_MOBILE_BASE);

  calls.length = 0;
  await connectWith(transact, memoryStore(), owner, {
    chooser: true,
    baseUri: SOLANA_MOBILE_BASE,
  });
  assert.equal(calls[0]?.baseUri, undefined);
});

test('a processed signature is read again and the wait says it was seen', async () => {
  await runAlone(async () => {
    const saved = {
      timeoutMs: signatureConfirmation.timeoutMs,
      pollMs: signatureConfirmation.pollMs,
      now: signatureConfirmation.now,
      sleep: signatureConfirmation.sleep,
      openConnection: signatureConfirmation.openConnection,
    };
    let polls = 0;
    let now = 5_000;
    signatureConfirmation.now = () => now;
    signatureConfirmation.sleep = async () => {
      now += 1_000;
    };
    signatureConfirmation.timeoutMs = 2_500;
    signatureConfirmation.pollMs = 1;
    signatureConfirmation.openConnection = async () => ({
      async getSignatureStatuses() {
        polls += 1;
        return statusResult('processed');
      },
    });
    try {
      const owner = Keypair.generate();
      const transact = recordingTransact(
        walletReturning({ owner, signatures: ['sig-processed'] }),
        [],
      );
      await assert.rejects(
        () => sign(transact, memoryStore()),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, SEEN_UNCONFIRMED);
          return true;
        },
      );
      assert.ok(polls >= 3, `the processed signature was read ${polls} times`);
    } finally {
      restoreConfirmation(saved);
    }
  });
});

test('each confirmation reads every poll through one connection', async () => {
  await runAlone(async () => {
    const saved = {
      timeoutMs: signatureConfirmation.timeoutMs,
      pollMs: signatureConfirmation.pollMs,
      now: signatureConfirmation.now,
      sleep: signatureConfirmation.sleep,
      openConnection: signatureConfirmation.openConnection,
    };
    const opened: { polls: number }[] = [];
    const plan: StatusName[] = ['processed', 'processed', 'confirmed', 'confirmed'];
    let step = 0;
    signatureConfirmation.pollMs = 0;
    signatureConfirmation.timeoutMs = 1_000;
    signatureConfirmation.openConnection = async () => {
      const connection = {
        polls: 0,
        async getSignatureStatuses() {
          this.polls += 1;
          const name = plan[step] ?? 'confirmed';
          step += 1;
          return statusResult(name);
        },
      };
      opened.push(connection);
      return connection;
    };
    try {
      const owner = Keypair.generate();
      const wallet = walletReturning({ owner, signatures: ['sig-a', 'sig-b'] });
      const transact = recordingTransact(wallet, []);
      const transactions = [new Transaction(), new Transaction()];
      const signatures = await signAndSendTransactions(transact, memoryStore(), transactions);
      const first = opened.slice();
      assert.deepEqual(signatures, ['sig-a', 'sig-b']);
      assert.equal(first.length, 1, `opened ${first.length} connections for the first confirmation`);
      assert.equal(first[0].polls, 4);

      const again = await signAndSendTransactions(transact, memoryStore(), transactions);
      const second = opened.slice(first.length);
      assert.deepEqual(again, ['sig-a', 'sig-b']);
      assert.equal(second.length, 1, `opened ${second.length} connections for the next confirmation`);
      assert.equal(second[0].polls, 2);
      assert.notEqual(second[0], first[0]);
    } finally {
      restoreConfirmation(saved);
    }
  });
});

test('wallet error text never exposes RPC credentials', () => {
  const error = 'Request failed at https://user:password@rpc.example/?api-key=wallet-secret';
  for (const input of [error, new Error(error)]) {
    const message = explainWalletFailure(input, 'devnet');
    assert.doesNotMatch(message, /api-key|wallet-secret|password|user/);
    assert.match(message, /\[redacted\]/);
  }
});
