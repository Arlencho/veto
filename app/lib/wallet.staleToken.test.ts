import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Keypair, Transaction } from '@solana/web3.js';

import * as wallet from './wallet';
import { SESSION_STORE_KEY, WALLET_REJECTED_MESSAGE } from './wallet';
import type { AuthorizeParams, MwaWallet, StoredSession, TransactFn, WalletStore } from './wallet';

// exposedWalletAccounts reads the phone store and opens the real wallet
// session, so both are replaced with the same in-memory fakes the tests drive.
const secure: Record<string, string> = {};
let nativeWallet: MwaWallet | null = null;

mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async (key: string) => secure[key] ?? null,
      setItem: async (key: string, value: string) => {
        secure[key] = value;
      },
      deleteItem: async (key: string) => {
        delete secure[key];
      },
    },
    transact: async (callback: (wallet: MwaWallet) => Promise<unknown>) => {
      if (!nativeWallet) throw new Error('no wallet');
      return callback(nativeWallet);
    },
  },
});

const loadHoldSign = () => import('./holdSign');

class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const STALE = () => new ProtocolError(-1, 'authorization request failed');
const DECLINE = () => new ProtocolError(-1, 'authorization request declined');

function memoryStore(init: Record<string, string> = {}): WalletStore & { data: Record<string, string> } {
  const data = { ...init };
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

type Answer = 'ok' | Error;

/** A wallet that answers each authorize call from a script, in order. */
function scriptedWallet(owner: Keypair, answers: Answer[], calls: AuthorizeParams[]) {
  const signed: Transaction[][] = [];
  const fake: MwaWallet & { signTransactions: (p: { transactions: Transaction[] }) => Promise<Transaction[]> } = {
    async authorize(params) {
      calls.push(params);
      const answer = answers.shift() ?? 'ok';
      if (answer instanceof Error) throw answer;
      return { accounts: [{ address: 'x', publicKey: owner.publicKey.toBytes() }], auth_token: 'fresh-token' };
    },
    async deauthorize() {
      return undefined;
    },
    async signAndSendTransactions(params) {
      signed.push(params.transactions);
      return params.transactions.map((_, i) => `sig-${i}`);
    },
    async signTransactions(params) {
      signed.push(params.transactions);
      return params.transactions;
    },
  };
  return { fake, signed };
}

function transactWith(fake: MwaWallet, sessions: { count: number }): TransactFn {
  return async (callback) => {
    sessions.count += 1;
    return callback(fake);
  };
}

function storedSession(owner: Keypair, authToken = 'stale-token'): Record<string, string> {
  const session: StoredSession = { authToken, ownerPublicKey: owner.publicKey.toBase58() };
  return { [SESSION_STORE_KEY]: JSON.stringify(session) };
}

function sampleTx(owner: Keypair): Transaction {
  const tx = new Transaction();
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx;
}

test('a stale token is cleared and a fresh authorize in the same session succeeds (connect)', async () => {
  const owner = Keypair.generate();
  const store = memoryStore(storedSession(owner));
  const calls: AuthorizeParams[] = [];
  const sessions = { count: 0 };
  const { fake } = scriptedWallet(owner, [STALE(), 'ok'], calls);
  const connected = await wallet.connect(transactWith(fake, sessions), store);
  assert.equal(sessions.count, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.auth_token, 'stale-token');
  assert.equal(calls[1]?.auth_token, undefined);
  assert.equal(connected.authToken, 'fresh-token');
  assert.equal((await wallet.loadSession(store))?.authToken, 'fresh-token');
});

test('a stale token then a fresh authorize lets a send continue (rules, allow one, stop, close)', async () => {
  const owner = Keypair.generate();
  const store = memoryStore(storedSession(owner));
  const calls: AuthorizeParams[] = [];
  const sessions = { count: 0 };
  const { fake, signed } = scriptedWallet(owner, [STALE(), 'ok'], calls);
  const sigs = await wallet.signAndSendTransactions(transactWith(fake, sessions), store, [sampleTx(owner)], {
    lookup: async () => 'confirmed',
  });
  assert.deepEqual(sigs, ['sig-0']);
  assert.equal(sessions.count, 1);
  assert.equal(calls.length, 2);
  assert.equal(signed.length, 1);
  assert.equal((await wallet.loadSession(store))?.authToken, 'fresh-token');
});

test('a stale token then a decline shows the plain message and asks only twice', async () => {
  const owner = Keypair.generate();
  const store = memoryStore(storedSession(owner));
  const calls: AuthorizeParams[] = [];
  const sessions = { count: 0 };
  const { fake, signed } = scriptedWallet(owner, [STALE(), DECLINE(), 'ok', 'ok'], calls);
  await assert.rejects(
    wallet.signAndSendTransactions(transactWith(fake, sessions), store, [sampleTx(owner)]),
    (err: Error) => err.message === WALLET_REJECTED_MESSAGE,
  );
  assert.equal(calls.length, 2);
  assert.equal(sessions.count, 1);
  assert.equal(signed.length, 0);
  const left = await wallet.loadSession(store);
  assert.equal(left?.authToken, '', 'the refused token is forgotten');
  assert.equal(left?.ownerPublicKey, owner.publicKey.toBase58(), 'the owner stays connected');
});

test('a fresh authorize that also fails is not retried again', async () => {
  const owner = Keypair.generate();
  const store = memoryStore(storedSession(owner));
  const calls: AuthorizeParams[] = [];
  const { fake } = scriptedWallet(owner, [STALE(), STALE(), 'ok'], calls);
  await assert.rejects(
    wallet.connect(transactWith(fake, { count: 0 }), store),
    (err: Error) => err.message === WALLET_REJECTED_MESSAGE,
  );
  assert.equal(calls.length, 2);
});

test('a decline after two seconds keeps the stored token without retrying', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const owner = Keypair.generate();
  const store = memoryStore(storedSession(owner));
  const calls: AuthorizeParams[] = [];
  const { fake } = scriptedWallet(owner, [STALE(), 'ok'], calls);
  const authorize = fake.authorize;
  fake.authorize = async (params) => {
    t.mock.timers.tick(2000);
    return authorize(params);
  };
  await assert.rejects(wallet.connect(transactWith(fake, { count: 0 }), store));
  assert.equal(calls.length, 1);
  assert.equal((await wallet.loadSession(store))?.authToken, 'stale-token');
});

test('with no stored token there is one authorize and no retry on failure', async () => {
  const owner = Keypair.generate();
  const calls: AuthorizeParams[] = [];
  const ok = scriptedWallet(owner, ['ok'], calls);
  const connected = await wallet.connect(transactWith(ok.fake, { count: 0 }), memoryStore());
  assert.equal(connected.authToken, 'fresh-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.auth_token, undefined);

  const failing: AuthorizeParams[] = [];
  const bad = scriptedWallet(owner, [STALE(), 'ok'], failing);
  await assert.rejects(wallet.connect(transactWith(bad.fake, { count: 0 }), memoryStore()));
  assert.equal(failing.length, 1);
});

test('an emptied token is not sent and disconnect skips deauthorize', async () => {
  const owner = Keypair.generate();
  const store = memoryStore(storedSession(owner, ''));
  const calls: AuthorizeParams[] = [];
  const { fake } = scriptedWallet(owner, ['ok'], calls);
  await wallet.connect(transactWith(fake, { count: 0 }), store);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.auth_token, undefined);

  const empty = memoryStore(storedSession(owner, ''));
  const sessions = { count: 0 };
  await wallet.disconnect(transactWith(fake, sessions), empty);
  assert.equal(sessions.count, 0);
  assert.equal(await wallet.loadSession(empty), null);
});

test('Hold signing recovers from a stale token in the same session', async () => {
  const owner = Keypair.generate();
  const store = memoryStore(storedSession(owner));
  const calls: AuthorizeParams[] = [];
  const sessions = { count: 0 };
  const { fake, signed } = scriptedWallet(owner, [STALE(), 'ok'], calls);
  const holdSign = await loadHoldSign();
  const payload = await holdSign.signHoldPartial(transactWith(fake, sessions), store, sampleTx(owner));
  assert.ok(payload.length > 0);
  assert.equal(sessions.count, 1);
  assert.equal(calls.length, 2);
  assert.equal(signed.length, 1);
});

test('Hold setup account list recovers from a stale token and stops after a decline', async () => {
  const owner = Keypair.generate();
  const holdSign = await loadHoldSign();
  Object.assign(secure, storedSession(owner));
  const calls: AuthorizeParams[] = [];
  nativeWallet = scriptedWallet(owner, [STALE(), 'ok'], calls).fake;
  const accounts = await holdSign.exposedWalletAccounts();
  assert.deepEqual(accounts, [owner.publicKey.toBase58()]);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(secure[SESSION_STORE_KEY] ?? '{}').authToken, '');

  Object.assign(secure, storedSession(owner));
  const declined: AuthorizeParams[] = [];
  nativeWallet = scriptedWallet(owner, [STALE(), DECLINE(), 'ok'], declined).fake;
  await assert.rejects(holdSign.exposedWalletAccounts(), (err: Error) => err.message === WALLET_REJECTED_MESSAGE);
  assert.equal(declined.length, 2);
});

test('isStaleAuthTokenError checks elapsed time, wallet code and wording', () => {
  assert.equal(wallet.isStaleAuthTokenError(STALE(), 100), true);
  assert.equal(wallet.isStaleAuthTokenError(STALE(), 1500), false);
  assert.equal(wallet.isStaleAuthTokenError(STALE(), 2000), false);
  assert.equal(wallet.isStaleAuthTokenError(DECLINE(), 100), false);
  assert.equal(wallet.isStaleAuthTokenError(new ProtocolError(-3, 'not signed'), 100), false);
  assert.equal(wallet.isStaleAuthTokenError(new Error('authorization request failed'), 100), false);
  const nested = Object.assign(new Error('authorization request failed'), { userInfo: { jsonRpcErrorCode: -1 } });
  assert.equal(wallet.isStaleAuthTokenError(nested, 100), true);
});
