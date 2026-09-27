import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import {
  LEDGER_ACCOUNT_SIZE,
  LEDGER_DISCRIMINATOR,
  MANDATE_DISCRIMINATOR,
  STATUS_ACTIVE,
  STATUS_REVOKED,
  writeI64Le,
  writeU32Le,
  writeU64Le,
} from './constants';
import type { MandateAccount } from './mandate';
import { ledgerPda } from './ring';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = Keypair.generate().publicKey;
const AGENT = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const PROGRAM = Keypair.generate().publicKey;
const NOW = BigInt(Math.floor(Date.now() / 1000));
const DAY = 86400n;

const store = new Map<string, string>();

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

mock.module('./mwa', {
  namedExports: {
    secureStore: {
      getItem: async (key: string) => store.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        store.set(key, value);
      },
      deleteItem: async (key: string) => {
        store.delete(key);
      },
    },
  },
});

mock.module('./useWallet', {
  namedExports: {
    useWallet: () => ({
      ready: true,
      busy: false,
      error: null,
      ownerPublicKey: OWNER.toBase58(),
      signAndSend: async () => {
        throw new Error('this test does not sign');
      },
      createAgentKeypair: async () => Keypair.generate(),
    }),
  },
});

function rule(over: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: Keypair.generate().publicKey.toBase58(),
    owner: OWNER.toBase58(),
    agent: AGENT.toBase58(),
    mint: MINT.toBase58(),
    source: Keypair.generate().publicKey.toBase58(),
    merchant: Keypair.generate().publicKey.toBase58(),
    mandateId: 1_700_000_000_000n,
    cap: 100_000_000n,
    spent: 0n,
    perTxMax: 10_000_000n,
    expiresAt: NOW + 40n * DAY,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'Charging top-ups',
    status: STATUS_ACTIVE,
    spendCount: 0,
    refusalCount: 0,
    bump: 1,
    ...over,
  };
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
  data[46] = 255;
  return data;
}

function mintData(): Buffer {
  const data = Buffer.alloc(82);
  data[44] = 6;
  return data;
}

let held: MandateAccount[] = [];
let reads = 0;
let paused: Promise<void> | null = null;

const connection = {
  async getAccountInfo(address: PublicKey) {
    if (address.equals(MINT)) {
      return { data: mintData(), owner: PROGRAM, executable: false, lamports: 1 };
    }
    for (const item of held) {
      const key = new PublicKey(item.address);
      if (address.equals(ledgerPda(PROGRAM, key))) {
        return { data: ledgerBytes(key), owner: PROGRAM, executable: false, lamports: 1 };
      }
    }
    return null;
  },
  async getProgramAccounts() {
    if (paused) {
      await paused;
    }
    return held.map((item) => ({
      pubkey: new PublicKey(item.address),
      account: { data: encodeMandate(item), owner: PROGRAM, executable: false, lamports: 1 },
    }));
  },
  async getSignaturesForAddress() {
    return [];
  },
  async getGenesisHash() {
    reads += 1;
    return 'genesis';
  },
};

type Api = {
  mandate: MandateAccount | null;
  refresh: (options?: { join?: boolean }) => Promise<void>;
  selectMandate: (address: string) => Promise<void>;
};

let api: Api | null = null;

async function mount(): Promise<ReactTestRenderer> {
  const chain = await import('./chain');
  chain.chainConnection.open = () => connection as unknown as Connection;
  const hook = await import('./useChain');
  function Binder() {
    const value = hook.useChain();
    useEffect(() => {
      api = value as unknown as Api;
    }, [value]);
    return null;
  }
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(createElement(hook.ChainProvider, null, createElement(Binder) as ReactNode));
  });
  await settle();
  assert.ok(root);
  return root;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function refresh(): Promise<void> {
  await act(async () => {
    await api?.refresh();
  });
  await settle();
}

function reset(): void {
  store.clear();
  held = [];
  api = null;
  reads = 0;
  paused = null;
}

function pause(): () => void {
  let release = () => {};
  paused = new Promise<void>((resolve) => {
    release = () => {
      paused = null;
      resolve();
    };
  });
  return release;
}

async function pickMandate(...args: Parameters<typeof import('./chain').pickMandate>) {
  const chain = await import('./chain');
  return chain.pickMandate(...args);
}

test('with no choice, the most recently opened live rule is picked', async () => {
  const older = rule({ mandateId: 1_700_000_000_000n, purpose: 'VTEST rule' });
  const newer = rule({ mandateId: 1_790_000_000_000n, purpose: 'USDC rule' });
  assert.equal((await pickMandate([older, newer], null, NOW))?.address, newer.address);
  assert.equal((await pickMandate([newer, older], null, NOW))?.address, newer.address);
});

test('with no choice, a newer ended or stopped rule does not beat an older live one', async () => {
  const live = rule({ mandateId: 1_700_000_000_000n });
  const ended = rule({ mandateId: 1_790_000_000_000n, expiresAt: NOW - DAY });
  const stopped = rule({ mandateId: 1_795_000_000_000n, status: STATUS_REVOKED });
  assert.equal((await pickMandate([stopped, ended, live], null, NOW))?.address, live.address);
});

test('an explicit choice wins over a newer rule, and a missing choice falls back to the newest live rule', async () => {
  const older = rule({ mandateId: 1_700_000_000_000n });
  const newer = rule({ mandateId: 1_790_000_000_000n });
  assert.equal((await pickMandate([older, newer], older.address, NOW))?.address, older.address);
  assert.equal((await pickMandate([older, newer], 'gone', NOW))?.address, newer.address);
});

test('after a new rule is opened, Overview and Decisions move to it when the user never chose one', async () => {
  reset();
  const older = rule({ mandateId: 1_700_000_000_000n, purpose: 'VTEST rule' });
  held = [older];
  const root = await mount();
  assert.equal(api?.mandate?.address, older.address);

  const newer = rule({ mandateId: 1_790_000_000_000n, purpose: 'USDC rule' });
  held = [older, newer];
  await refresh();
  assert.equal(api?.mandate?.address, newer.address);
  assert.equal(store.get('veto.mandate.selected'), newer.address, 'the widget follows the rule on screen');
  act(() => root.unmount());
});

test('a rule remembered by an older build as the automatic default does not hold the screen', async () => {
  reset();
  const older = rule({ mandateId: 1_700_000_000_000n, purpose: 'VTEST rule' });
  const newer = rule({ mandateId: 1_790_000_000_000n, purpose: 'USDC rule' });
  held = [older, newer];
  store.set('veto.mandate.selected', older.address);
  const root = await mount();
  assert.equal(api?.mandate?.address, newer.address);
  act(() => root.unmount());
});

test('a rule the user picked stays picked when a newer rule appears', async () => {
  reset();
  const older = rule({ mandateId: 1_700_000_000_000n, purpose: 'VTEST rule' });
  const newer = rule({ mandateId: 1_790_000_000_000n, purpose: 'USDC rule' });
  held = [older, newer];
  const root = await mount();
  assert.equal(api?.mandate?.address, newer.address);

  await act(async () => {
    await api?.selectMandate(older.address);
  });
  await settle();
  assert.equal(api?.mandate?.address, older.address);

  const newest = rule({ mandateId: 1_799_000_000_000n, purpose: 'Third rule' });
  held = [older, newer, newest];
  await refresh();
  assert.equal(api?.mandate?.address, older.address);
  act(() => root.unmount());
});

test('a focus refresh during the launch read joins it, so one chain read goes out', async () => {
  reset();
  held = [rule()];
  const release = pause();
  const root = await mount();
  assert.equal(reads, 0, 'the launch read is still waiting on the chain');
  let joined: Promise<void> | undefined;
  await act(async () => {
    joined = api?.refresh({ join: true });
  });
  release();
  await act(async () => {
    await joined;
  });
  await settle();
  assert.equal(reads, 1);
  assert.equal(api?.mandate?.address, held[0]?.address);
  act(() => root.unmount());
});

test('a rule picked while a read is in flight is shown once the reads finish', async () => {
  reset();
  const older = rule({ mandateId: 1_700_000_000_000n, purpose: 'VTEST rule' });
  const newer = rule({ mandateId: 1_790_000_000_000n, purpose: 'USDC rule' });
  held = [older, newer];
  const root = await mount();
  assert.equal(api?.mandate?.address, newer.address);
  reads = 0;

  const release = pause();
  let focus: Promise<void> | undefined;
  let picked: Promise<void> | undefined;
  await act(async () => {
    focus = api?.refresh({ join: true });
  });
  await act(async () => {
    picked = api?.selectMandate(older.address);
  });
  await settle();
  release();
  await act(async () => {
    await Promise.all([focus, picked]);
  });
  await settle();
  assert.equal(api?.mandate?.address, older.address);
  assert.equal(store.get('veto.mandate.selected'), older.address);
  assert.equal(reads, 2, 'the pick gets its own read after the one in flight');
  act(() => root.unmount());
});

test('explicit refreshes during a read share one follow-up read, and a join reuses the read in flight', async () => {
  const { createRefreshGate } = await import('./useChain');
  const gate = createRefreshGate();
  let started = 0;
  const finishers: Array<() => void> = [];
  const read = () => {
    started += 1;
    return new Promise<void>((resolve) => {
      finishers.push(resolve);
    });
  };
  const first = gate('owner', true, read);
  const joined = gate('owner', true, read);
  const fresh = gate('owner', false, read);
  const alsoFresh = gate('owner', false, read);
  assert.equal(started, 1);
  finishers[0]?.();
  await first;
  await joined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 2, 'one follow-up read for both explicit refreshes');
  finishers[1]?.();
  await Promise.all([fresh, alsoFresh]);
  const other = gate('other owner', true, read);
  assert.equal(started, 3, 'a different owner never waits on another owner read');
  finishers[2]?.();
  await other;
});

test('a failed read does not jam the gate, and a follow-up for a previous owner is dropped', async () => {
  const { createRefreshGate } = await import('./useChain');
  const gate = createRefreshGate();
  let started = 0;
  const failing = () => {
    started += 1;
    return Promise.reject(new Error('read failed'));
  };
  await assert.rejects(gate('owner', true, failing));
  const ok = () => {
    started += 1;
    return Promise.resolve();
  };
  await gate('owner', false, ok);
  assert.equal(started, 2, 'a new read starts after a failed one');

  let finish!: () => void;
  const slow = () => {
    started += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  };
  const first = gate('owner', true, slow);
  const followUp = gate('owner', false, ok);
  const switched = gate('other owner', true, ok);
  await switched;
  finish();
  await first;
  await followUp;
  assert.equal(started, 4, 'the old owner follow-up does not run after the switch');
});
