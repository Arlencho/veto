import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

import { FREEZE_DISC, HOLD_VAULT_DISC, RECOVER_DISC, STOP_DISC } from './holdIdl';
import { HOLD_VAULT_LEN, holdVaultPda, readU64, writeI64, writeU64 } from './holdRead';
import { DEVNET_USDC_MINT } from './tokens';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
mock.module('expo-secure-store', {
  namedExports: {
    getItemAsync: async () => null,
    setItemAsync: async () => undefined,
    deleteItemAsync: async () => undefined,
  },
});
mock.module('@solana-mobile/mobile-wallet-adapter-protocol-web3js', {
  namedExports: {
    transact: async () => {
      throw new Error('wallet');
    },
  },
});
mock.module('expo-notifications', {
  namedExports: {
    AndroidImportance: { HIGH: 4, DEFAULT: 3 },
    SchedulableTriggerInputTypes: { DATE: 'date' },
    setNotificationChannelAsync: async () => undefined,
    scheduleNotificationAsync: async () => undefined,
    cancelScheduledNotificationAsync: async () => undefined,
    getPermissionsAsync: async () => ({ granted: false }),
  },
});

const DAY = 86_400n;
const CREATED = 1_700_000_000n;
const PROGRAM = Keypair.generate().publicKey;
const OWNER = Keypair.generate().publicKey;
const GUARDIAN = Keypair.generate().publicKey;
const SAFE = Keypair.generate().publicKey;
const MINT = new PublicKey(DEVNET_USDC_MINT);

type Pending = { id: bigint; amount: bigint; destination: PublicKey; unlockAt: bigint };

function vaultBytes(args: {
  vaultId?: bigint;
  guardian?: PublicKey;
  frozen?: boolean;
  pending?: Pending[];
  change?: { fields: number; dailyLimit: bigint; effectiveAt: bigint };
}): Buffer {
  const data = Buffer.alloc(HOLD_VAULT_LEN);
  HOLD_VAULT_DISC.copy(data, 0);
  OWNER.toBuffer().copy(data, 8);
  (args.guardian ?? GUARDIAN).toBuffer().copy(data, 40);
  SAFE.toBuffer().copy(data, 72);
  MINT.toBuffer().copy(data, 104);
  Keypair.generate().publicKey.toBuffer().copy(data, 136);
  writeU64(data, 168, args.vaultId ?? 1n);
  writeU64(data, 176, 50_000_000n);
  writeI64(data, 200, DAY * 2n);
  data.writeUInt16LE(2500, 224);
  data.writeUInt8(args.frozen ? 1 : 0, 226);
  (args.pending ?? []).forEach((row, index) => {
    const off = 743 + index * 57;
    writeU64(data, off, row.id);
    writeU64(data, off + 8, row.amount);
    row.destination.toBuffer().copy(data, off + 16);
    writeI64(data, off + 48, row.unlockAt);
    data.writeUInt8(1, off + 56);
  });
  if (args.change) {
    data.writeUInt8(1, 1199);
    data.writeUInt8(args.change.fields, 1200);
    data.writeUInt16LE(2500, 1201);
    writeU64(data, 1203, args.change.dailyLimit);
    writeI64(data, 1211, DAY * 2n);
    GUARDIAN.toBuffer().copy(data, 1219);
    SAFE.toBuffer().copy(data, 1251);
    writeI64(data, 1283, args.change.effectiveAt);
  }
  return data;
}

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      map.set(key, value);
    },
    deleteItem: async (key: string) => {
      map.delete(key);
    },
  };
}

type Filters = { dataSize?: number; memcmp?: { offset: number; bytes: string } }[];

function fakeClient(accounts: () => { pubkey: PublicKey; data: Buffer }[], over: Record<string, unknown> = {}) {
  const calls: { offset: number | undefined; bytes: string | undefined; dataSize: number | undefined }[] = [];
  const connection = {
    getProgramAccounts: async (_program: PublicKey, opts: { filters: Filters }) => {
      const memcmp = opts.filters.find((item) => item.memcmp && item.memcmp.offset !== 0)?.memcmp;
      calls.push({
        offset: memcmp?.offset,
        bytes: memcmp?.bytes,
        dataSize: opts.filters.find((item) => item.dataSize)?.dataSize,
      });
      return accounts()
        .filter((row) => {
          if (!memcmp) return true;
          const field = new PublicKey(row.data.subarray(memcmp.offset, memcmp.offset + 32));
          return field.toBase58() === memcmp.bytes;
        })
        .map((row) => ({ pubkey: row.pubkey, account: { data: row.data } }));
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((key) => {
        const row = accounts().find((item) => item.pubkey.equals(key));
        return row ? { data: row.data } : null;
      }),
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 10,
    }),
    ...over,
  };
  return {
    calls,
    client: {
      programId: PROGRAM,
      connection,
      config: { explorerCluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com' },
    } as never,
  };
}

test('a guardian finds the vaults it guards by the guardian field and remembers them', async () => {
  const { listGuardedVaults, listHoldVaults } = await import('./holdChain');
  const { discoverGuardedVaults, rememberedGuardedVaults } = await import('./holdGuard');
  const guarded = holdVaultPda(PROGRAM, OWNER, 1n);
  const other = Keypair.generate().publicKey;
  const rows = [
    { pubkey: guarded, data: vaultBytes({ vaultId: 1n }) },
    { pubkey: other, data: vaultBytes({ vaultId: 2n, guardian: Keypair.generate().publicKey }) },
  ];
  const { client, calls } = fakeClient(() => rows);

  const found = await listGuardedVaults(client, GUARDIAN);
  assert.deepEqual(
    found.map((vault) => vault.address.toBase58()),
    [guarded.toBase58()],
  );
  assert.deepEqual(calls[0], { offset: 40, bytes: GUARDIAN.toBase58(), dataSize: undefined });

  const owned = await listHoldVaults(client, GUARDIAN);
  assert.equal(owned.length, 0, 'a guarded vault is not listed as the guardian\'s own vault');
  assert.equal(calls[1]?.offset, 8);

  const store = memoryStore();
  const discovered = await discoverGuardedVaults({ client, store, guardian: GUARDIAN });
  assert.equal(discovered.length, 1);
  assert.deepEqual(await rememberedGuardedVaults(store, GUARDIAN), [guarded.toBase58()]);
  assert.deepEqual(await rememberedGuardedVaults(store, OWNER), [], 'another wallet does not reuse the list');
});

test('a busy node is retried, and a failed search falls back to the remembered vaults', async () => {
  const { ledgerBodyFetch } = await import('./chain');
  const { discoverGuardedVaults, rememberGuardedVaults } = await import('./holdGuard');
  const sleep = mock.method(ledgerBodyFetch, 'sleep', async () => undefined);
  const guarded = holdVaultPda(PROGRAM, OWNER, 1n);
  const rows = [{ pubkey: guarded, data: vaultBytes({}) }];

  let tries = 0;
  const flaky = fakeClient(() => rows);
  const search = flaky.client as unknown as { connection: Record<string, unknown> };
  const real = search.connection.getProgramAccounts as (...args: unknown[]) => Promise<unknown>;
  search.connection.getProgramAccounts = async (...args: unknown[]) => {
    tries += 1;
    if (tries === 1) throw new Error('429 Too Many Requests');
    return real(...args);
  };
  const store = memoryStore();
  const found = await discoverGuardedVaults({ client: flaky.client, store, guardian: GUARDIAN });
  assert.equal(found.length, 1);
  assert.equal(tries, 2);

  const down = fakeClient(() => rows, {
    getProgramAccounts: async () => {
      throw new Error('getProgramAccounts is disabled on this node');
    },
  });
  const fallbackStore = memoryStore();
  await rememberGuardedVaults(fallbackStore, GUARDIAN, [guarded.toBase58()]);
  const remembered = await discoverGuardedVaults({ client: down.client, store: fallbackStore, guardian: GUARDIAN });
  assert.deepEqual(
    remembered.map((vault) => vault.address.toBase58()),
    [guarded.toBase58()],
  );
  assert.deepEqual(
    await discoverGuardedVaults({ client: down.client, store: memoryStore(), guardian: GUARDIAN }),
    [],
  );
  sleep.mock.restore();
});

test('the guardian phone alerts once for each held withdrawal and each proposed change', async () => {
  const { raiseGuardAlerts, GUARD_SEEN_KEY } = await import('./holdGuard');
  const guarded = holdVaultPda(PROGRAM, OWNER, 1n);
  const destination = new PublicKey(Buffer.alloc(32, 7));
  const first: Pending = { id: 4n, amount: 1_000_000_000n, destination, unlockAt: CREATED + DAY * 2n };
  let pending = [first];
  let change: { fields: number; dailyLimit: bigint; effectiveAt: bigint } | undefined;
  const { client } = fakeClient(() => [{ pubkey: guarded, data: vaultBytes({ pending, change }) }]);
  const store = memoryStore();
  const shown: { title: string; body: string; key: string; withdrawalId: string | null }[] = [];
  const run = () =>
    raiseGuardAlerts({
      client,
      store,
      guardian: GUARDIAN,
      present: async (alert) => {
        shown.push(alert);
      },
      decimalsOf: async () => 6,
      timeZone: 'UTC',
    });

  const once = await run();
  assert.equal(once.length, 1);
  assert.equal(shown[0]?.title, `Held: 1,000 USDC to ${destination.toBase58().slice(0, 4)}...${destination.toBase58().slice(-4)}`);
  assert.equal(
    shown[0]?.body,
    'Waits until Thu 16 Nov, 22:13. You guard this vault. Tap to stop it or freeze the vault.',
  );
  assert.equal(shown[0]?.withdrawalId, '4');

  assert.deepEqual(await run(), [], 'the same withdrawal is never announced twice');
  assert.equal(shown.length, 1);

  pending = [first, { id: 5n, amount: 2_500_000n, destination, unlockAt: CREATED + DAY * 3n }];
  change = { fields: 1, dailyLimit: 500_000_000n, effectiveAt: CREATED + DAY };
  const next = await run();
  assert.equal(next.length, 2);
  assert.match(shown[1]?.title ?? '', /^Held: 2\.5 USDC to /);
  assert.equal(shown[2]?.title, 'A settings change was proposed for a vault you guard');
  assert.equal(
    shown[2]?.body,
    'The everyday limit goes up from 50 USDC to 500 USDC a day. Applies Wed 15 Nov, 22:13. Tap to freeze the vault or move everything to the safe address.',
  );
  assert.deepEqual(await run(), []);
  const seen = JSON.parse(store.map.get(GUARD_SEEN_KEY) ?? '[]') as string[];
  assert.equal(seen.length, 3);
});

test('a guardian notice opens the guardian screen, an owner notice still opens the held screen', async () => {
  const { holdPathFromNoticeData } = await import('./holdNotify');
  assert.equal(
    holdPathFromNoticeData({ holdVault: 'V1', holdWithdrawal: '4', holdGuard: true }),
    '/hold/guard?vault=V1&id=4',
  );
  assert.equal(holdPathFromNoticeData({ holdVault: 'V1', holdWithdrawal: '', holdGuard: true }), '/hold/guard?vault=V1');
  assert.equal(holdPathFromNoticeData({ holdVault: 'V1', holdWithdrawal: '4' }), '/hold/held?vault=V1&id=4');
});

test('the vault state reads normal, item waiting, or frozen', async () => {
  const { guardState, guardStateLabel } = await import('./holdGuard');
  const { decodeHoldVault } = await import('./holdRead');
  const address = Keypair.generate().publicKey;
  const destination = new PublicKey(Buffer.alloc(32, 7));
  const calm = decodeHoldVault(vaultBytes({}), address);
  assert.equal(guardState(calm), 'normal');
  assert.equal(guardStateLabel(calm, 6, 'USDC'), 'Normal. Nothing is waiting.');
  const waiting = decodeHoldVault(
    vaultBytes({ pending: [{ id: 1n, amount: 3_000_000n, destination, unlockAt: CREATED }] }),
    address,
  );
  assert.equal(guardState(waiting), 'waiting');
  assert.match(guardStateLabel(waiting, 6, 'USDC'), /^Waiting: 3 USDC to /);
  const frozen = decodeHoldVault(vaultBytes({ frozen: true }), address);
  assert.equal(guardState(frozen), 'frozen');
  assert.equal(guardStateLabel(frozen, 6, 'USDC'), 'Frozen. Nothing can leave.');
});

test('stop, freeze and recover are built with the guardian key as the signer', async () => {
  const { guardBrake } = await import('./holdGuard');
  const { decodeHoldVault } = await import('./holdRead');
  const address = holdVaultPda(PROGRAM, OWNER, 1n);
  const destination = new PublicKey(Buffer.alloc(32, 7));
  const account = decodeHoldVault(
    vaultBytes({ pending: [{ id: 9n, amount: 1_000_000n, destination, unlockAt: CREATED }] }),
    address,
  );
  const bundle = {
    account,
    ledger: { address, vault: address, total: 0, head: 0, bump: 0, entries: [] },
    balance: 5_000_000n,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const { client } = fakeClient(() => []);
  const sent: Transaction[] = [];
  const signAndSend = async (txs: Transaction[]) => {
    sent.push(...txs);
    return ['sig'];
  };

  const holdIx = (tx: Transaction) => {
    const found = tx.instructions.find((item) => item.programId.equals(PROGRAM));
    assert.ok(found);
    return found;
  };

  assert.equal(await guardBrake({ kind: 'stop', client, signAndSend, guardian: GUARDIAN, bundle, withdrawalId: 9n }), 'sig');
  const stop = sent[0];
  assert.ok(stop);
  assert.equal(stop.feePayer?.toBase58(), GUARDIAN.toBase58());
  assert.ok(holdIx(stop).data.subarray(0, 8).equals(STOP_DISC));
  assert.equal(readU64(holdIx(stop).data, 8), 9n);
  assert.equal(holdIx(stop).keys[0]?.pubkey.toBase58(), GUARDIAN.toBase58());
  assert.equal(holdIx(stop).keys[0]?.isSigner, true);
  assert.equal(holdIx(stop).keys[1]?.pubkey.toBase58(), address.toBase58());

  await guardBrake({ kind: 'freeze', client, signAndSend, guardian: GUARDIAN, bundle });
  const freeze = sent[1];
  assert.ok(freeze);
  assert.equal(freeze.feePayer?.toBase58(), GUARDIAN.toBase58());
  assert.ok(holdIx(freeze).data.equals(FREEZE_DISC));
  assert.equal(holdIx(freeze).keys[0]?.pubkey.toBase58(), GUARDIAN.toBase58());
  assert.equal(holdIx(freeze).keys[0]?.isSigner, true);

  await guardBrake({ kind: 'recover', client, signAndSend, guardian: GUARDIAN, bundle });
  const recover = sent[2];
  assert.ok(recover);
  assert.equal(recover.feePayer?.toBase58(), GUARDIAN.toBase58());
  assert.ok(holdIx(recover).data.equals(RECOVER_DISC));
  assert.equal(holdIx(recover).keys[0]?.pubkey.toBase58(), GUARDIAN.toBase58());
  assert.equal(holdIx(recover).keys[0]?.isSigner, true);
  assert.equal(
    holdIx(recover).keys[4]?.pubkey.toBase58(),
    getAssociatedTokenAddressSync(MINT, SAFE, false, TOKEN_PROGRAM_ID).toBase58(),
    'recover only pays the safe address',
  );

  const stranger = Keypair.generate().publicKey;
  await assert.rejects(
    guardBrake({ kind: 'freeze', client, signAndSend, guardian: stranger, bundle }),
    /not the guardian of this vault/,
  );
  assert.equal(sent.length, 3, 'the wallet is not opened for a key that is not the guardian');
});

test('the owner can discover a legacy vault that still holds funds', async () => {
  const { listHoldVaults } = await import('./holdChain');
  const address = holdVaultPda(PROGRAM, OWNER, 1n);
  const { client } = fakeClient(() => [{ pubkey: address, data: vaultBytes({ vaultId: 1n }).subarray(0, 1291) }]);
  const rows = await listHoldVaults(client, OWNER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.address.toBase58(), address.toBase58());
  assert.equal(rows[0]?.migrationRequired, true);
});
