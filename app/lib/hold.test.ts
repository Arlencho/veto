import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

import { dueHoldAlerts, futureHoldAlerts, holdAlertPlan } from './holdAlerts';
import {
  INIT_VAULT_DISC,
  HOLD_VAULT_DISC,
  STOP_DISC,
} from './holdIdl';
import {
  bigDoorTriggers,
  countdownFromChain,
  delaySecsForDays,
  formatChainInstant,
  formatHoldAmount,
  heldGoneCopy,
  heldReasonChips,
  holdNetworkPill,
  holdRecordLines,
  holdTokenName,
  HOLD_KIND_FROZEN,
  HOLD_KIND_PAID,
  HOLD_KIND_STOPPED,
  HOLD_SHARE_BPS,
  HOLD_SUGGESTED_DAILY,
  HOLD_SUGGESTED_DAYS,
  HOLD_SUGGESTED_DEPOSIT,
  phoneKeyCopy,
  secondSeedVaultAccount,
  stepWhole,
  vaultShareText,
} from './hold';
import { DEVNET_USDC_MINT, MAINNET_USDC_MINT, VTEST_MINT } from './tokens';
import {
  decodeHoldVault,
  holdLedgerPda,
  holdTokenPda,
  holdVaultPda,
  holdWithdrawalOutlook,
  HOLD_VAULT_LEN,
  readI64,
  readU64,
  writeI64,
  writeU64,
} from './holdRead';
import { initVaultInstruction, stopInstruction } from './holdTx';
import type { MwaWallet } from './wallet';

type SdkIdl = {
  HOLD_VAULT_DISCRIMINATOR: Buffer;
  INIT_VAULT_DISCRIMINATOR: Buffer;
  STOP_DISCRIMINATOR: Buffer;
};

type SdkHold = {
  decodeHoldVault: typeof decodeHoldVault;
  holdLedgerPda: typeof holdLedgerPda;
  holdTokenPda: typeof holdTokenPda;
  holdVaultPda: typeof holdVaultPda;
  withdrawalOutlook: typeof holdWithdrawalOutlook;
};

function sdkModule(name: string): string {
  return `../../sdk/src/${name}.js`;
}

async function loadSdk(): Promise<{ hold: SdkHold; idl: SdkIdl }> {
  const importer = new Function('spec', 'return import(spec)') as (spec: string) => Promise<unknown>;
  return {
    hold: (await importer(sdkModule('hold'))) as SdkHold,
    idl: (await importer(sdkModule('idl'))) as SdkIdl,
  };
}

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

const DAY = 86_400n;
const CREATED = 1_700_000_000n;

test('hold names the token from the table and the pill says the cluster is a test network', () => {
  assert.equal(holdTokenName('devnet', DEVNET_USDC_MINT), 'USDC');
  assert.equal(holdTokenName('devnet', VTEST_MINT), 'VTEST');
  assert.equal(holdTokenName('mainnet-beta', MAINNET_USDC_MINT), 'USDC');
  assert.equal(holdTokenName('devnet', null), 'tokens');
  assert.equal(holdTokenName('devnet', ''), 'tokens');
  assert.equal(holdNetworkPill('devnet'), 'Devnet, a test network');
  assert.equal(holdNetworkPill('testnet'), 'Testnet, a test network');
  assert.equal(holdNetworkPill('mainnet-beta'), 'Mainnet');
});

test('a new vault suggests a deposit of 5, a daily limit of 1, a 1 day wait, and a quarter share', () => {
  assert.equal(HOLD_SUGGESTED_DEPOSIT, '5');
  assert.equal(HOLD_SUGGESTED_DAILY, '1');
  assert.equal(HOLD_SUGGESTED_DAYS, 1);
  assert.equal(HOLD_SHARE_BPS, 2500);
  const layout = readFileSync(new URL('../app/hold/_layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /useState\(HOLD_SUGGESTED_DEPOSIT\)/);
  assert.match(layout, /useState\(HOLD_SUGGESTED_DAILY\)/);
  assert.match(layout, /useState<HoldDays>\(HOLD_SUGGESTED_DAYS\)/);
});

test('a Hold wait is 1, 2 or 3 days on the blockchain clock', () => {
  assert.equal(delaySecsForDays(1), DAY);
  assert.equal(delaySecsForDays(2), DAY * 2n);
  assert.equal(delaySecsForDays(3), DAY * 3n);
});

test('the countdown is the chain clock minus the unlock time', () => {
  const unlock = CREATED + DAY * 2n;
  const now = unlock - (DAY + 23n * 3_600n + 41n * 60n);
  const left = countdownFromChain(now, unlock);
  assert.equal(left.over, false);
  assert.equal(left.days, 1);
  assert.equal(left.hours, 23);
  assert.equal(left.minutes, 41);
  assert.equal(left.accessibilityLabel, '1 day, 23 hours, 41 minutes left');
  assert.equal(countdownFromChain(unlock, unlock).over, true);
  assert.equal(countdownFromChain(unlock, unlock).accessibilityLabel, 'The wait is over');
});

test('a chain instant is the blockchain time shown for a chosen zone', () => {
  assert.equal(formatChainInstant(CREATED, 'UTC'), 'Tue 14 Nov, 22:13');
});

test('amounts say how many tokens, with thousands grouped', () => {
  assert.equal(formatHoldAmount(1_000_000_000n, 6), '1,000');
  assert.equal(formatHoldAmount(50_000_000n, 6), '50');
});

test('the four big-door triggers name the everyday limit and the quarter share', () => {
  const lines = bigDoorTriggers('50');
  assert.equal(lines[0], 'More than 50 in one day, on its own or added up');
  assert.match(lines[1] ?? '', /never paid/);
  assert.match(lines[2] ?? '', /quarter/);
  assert.match(lines[3] ?? '', /loosens/);
});

test('held reasons name the amount, the daily limit, and the share of this vault', () => {
  assert.deepEqual(
    heldReasonChips({
      reasons: ['over_daily_limit', 'new_address', 'over_share'],
      amountLabel: '1,000 USDC',
      dailyLabel: '50 USDC',
      shareLabel: vaultShareText(1_000n, 1_000n),
    }),
    ['1,000 USDC is over your 50 USDC a day', 'New address', '100% of your vault'],
  );
});

test('the held screen empty state says a stop plainly and stays neutral about the key', () => {
  const stopped = { withdrawalId: 7n, kind: HOLD_KIND_STOPPED };
  const paid = { withdrawalId: 8n, kind: HOLD_KIND_PAID };
  assert.equal(heldGoneCopy([stopped], '7'), 'Stopped. Nothing left the vault.');
  assert.equal(
    heldGoneCopy([paid], '8'),
    'This withdrawal is no longer waiting. Nothing moves unless another request is held.',
  );
  assert.equal(
    heldGoneCopy([stopped], '9'),
    'This withdrawal is no longer waiting. Nothing moves unless another request is held.',
  );
  assert.equal(
    heldGoneCopy([stopped], ''),
    'This withdrawal is no longer waiting. Nothing moves unless another request is held.',
  );
  assert.equal(
    heldGoneCopy([stopped], 'not-a-number'),
    'This withdrawal is no longer waiting. Nothing moves unless another request is held.',
  );
});

test('a second Seed Vault account is used only when the wallet exposes one', () => {
  assert.equal(secondSeedVaultAccount('owner', ['owner']), null);
  assert.equal(secondSeedVaultAccount('owner', ['owner', 'second']), 'second');
  assert.match(phoneKeyCopy('ownerkey111', null).detail, /did not expose a second account/);
  assert.equal(phoneKeyCopy('ownerkey111', null).available, false);
  const offered = phoneKeyCopy('ownerkey111', '4mKpxxxxxxxxR2vd');
  assert.equal(offered.available, true);
  assert.match(offered.detail, /4mKp\.\.\.R2vd/);
  assert.match(offered.detail, /Not a stolen seed phrase/);
});

test('the everyday limit steps by one whole token and does not go below zero', () => {
  assert.equal(stepWhole('50', 1), '51');
  assert.equal(stepWhole('0', -1), '0');
});

test('a freeze record names the guardian key when that key froze the vault', () => {
  const lines = holdRecordLines({
    entries: [
      {
        ts: CREATED,
        amount: 0n,
        destination: 'guardian',
        kind: HOLD_KIND_FROZEN,
        reason: 0,
      },
    ],
    owner: 'owner',
    guardian: 'guardian',
    decimals: 6,
    tokenName: 'test tokens',
    timeZone: 'UTC',
  });
  assert.equal(lines[0]?.title, 'Vault frozen by your guardian key');
  assert.equal(lines[0]?.time, '22:13');
});

test('hold alerts follow the watcher marks for a 2 day wait', () => {
  const unlock = CREATED + DAY * 2n;
  const plan = holdAlertPlan({
    vault: 'vault',
    withdrawalId: '4',
    amountLabel: '1,000 test tokens',
    destinationLabel: '8xQf...Tz9A',
    createdAt: CREATED,
    unlockAt: unlock,
    newAddress: true,
    timeZone: 'UTC',
  });
  assert.deepEqual(
    plan.map((alert) => alert.name),
    ['created', '1h', '12h', 'every_12h', 'every_12h', '6h_before', '1h_before', 'end'],
  );
  assert.equal(plan[0]?.at, CREATED);
  assert.equal(plan[1]?.at, CREATED + 3_600n);
  assert.equal(plan[2]?.at, CREATED + 12n * 3_600n);
  assert.equal(plan[3]?.at, CREATED + 24n * 3_600n);
  assert.equal(plan[3]?.row, 'Reminder, 1 day left.');
  assert.equal(plan[4]?.at, CREATED + 36n * 3_600n);
  assert.equal(plan[5]?.at, unlock - 6n * 3_600n);
  assert.equal(plan[6]?.at, unlock - 3_600n);
  assert.equal(plan[7]?.at, unlock);
  assert.match(plan[0]?.title ?? '', /Held: 1,000 test tokens to a new address/);
  assert.match(plan[0]?.body ?? '', /unless you stop it/);
  const seen = new Set<string>();
  const due = dueHoldAlerts(plan, CREATED + 3_600n, seen);
  assert.deepEqual(due.map((alert) => alert.name), ['created', '1h']);
  assert.equal(futureHoldAlerts(plan, CREATED + 3_600n)[0]?.name, '12h');
});

test('the phone reads the same vault bytes as the vault client', async () => {
  const { hold: sdk, idl } = await loadSdk();
  const {
    decodeHoldVault: sdkDecodeHoldVault,
    holdLedgerPda: sdkHoldLedgerPda,
    holdTokenPda: sdkHoldTokenPda,
    holdVaultPda: sdkHoldVaultPda,
    withdrawalOutlook,
  } = sdk;
  const { HOLD_VAULT_DISCRIMINATOR, INIT_VAULT_DISCRIMINATOR, STOP_DISCRIMINATOR } = idl;
  assert.ok(HOLD_VAULT_DISC.equals(HOLD_VAULT_DISCRIMINATOR));
  assert.ok(INIT_VAULT_DISC.equals(INIT_VAULT_DISCRIMINATOR));
  assert.ok(STOP_DISC.equals(STOP_DISCRIMINATOR));

  const program = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const vaultId = 7n;
  assert.equal(
    holdVaultPda(program, owner, vaultId).toBase58(),
    sdkHoldVaultPda(program, owner, vaultId).toBase58(),
  );
  const vault = holdVaultPda(program, owner, vaultId);
  assert.equal(holdLedgerPda(program, vault).toBase58(), sdkHoldLedgerPda(program, vault).toBase58());
  assert.equal(holdTokenPda(program, vault).toBase58(), sdkHoldTokenPda(program, vault).toBase58());

  const data = Buffer.alloc(HOLD_VAULT_LEN);
  HOLD_VAULT_DISCRIMINATOR.copy(data, 0);
  const guardian = Keypair.generate().publicKey;
  const safe = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const token = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  owner.toBuffer().copy(data, 8);
  guardian.toBuffer().copy(data, 40);
  safe.toBuffer().copy(data, 72);
  mint.toBuffer().copy(data, 104);
  token.toBuffer().copy(data, 136);
  writeU64(data, 168, vaultId);
  writeU64(data, 176, 50n);
  writeI64(data, 200, DAY);
  data.writeUInt16LE(10_000, 224);
  data.writeUInt8(1, 227);
  destination.toBuffer().copy(data, 231);
  writeU64(data, 743, 4n);
  writeU64(data, 751, 40n);
  destination.toBuffer().copy(data, 759);
  writeI64(data, 791, CREATED + DAY);
  data.writeUInt8(1, 743 + 56);

  const address = Keypair.generate().publicKey;
  const app = decodeHoldVault(data, address);
  const fromClient = sdkDecodeHoldVault(data, address);
  assert.equal(app.owner.toBase58(), fromClient.owner.toBase58());
  assert.equal(app.guardian.toBase58(), fromClient.guardian.toBase58());
  assert.equal(app.dailyLimit, fromClient.dailyLimit);
  assert.equal(app.delaySecs, fromClient.delaySecs);
  assert.equal(app.bigShareBps, fromClient.bigShareBps);
  assert.equal(app.known[0]?.toBase58(), fromClient.known[0]?.toBase58());
  assert.equal(app.pending[0]?.id, fromClient.pending[0]?.id);
  assert.equal(app.pending[0]?.amount, fromClient.pending[0]?.amount);
  assert.equal(app.pending[0]?.unlockAt, fromClient.pending[0]?.unlockAt);

  const now = CREATED;
  const atOnce = holdWithdrawalOutlook(app, {
    amount: 40n,
    destination,
    balance: 1_000n,
    now,
  });
  assert.deepEqual(atOnce, withdrawalOutlook(fromClient, { amount: 40n, destination, balance: 1_000n, now }));
  assert.equal(atOnce.outcome, 'at_once');

  const over = holdWithdrawalOutlook(app, { amount: 60n, destination, balance: 1_000n, now });
  assert.deepEqual(over, withdrawalOutlook(fromClient, { amount: 60n, destination, balance: 1_000n, now }));
  assert.equal(over.outcome, 'held');

  const fresh = Keypair.generate().publicKey;
  const unseen = holdWithdrawalOutlook(app, { amount: 10n, destination: fresh, balance: 1_000n, now });
  assert.deepEqual(
    unseen,
    withdrawalOutlook(fromClient, { amount: 10n, destination: fresh, balance: 1_000n, now }),
  );
  if (unseen.outcome === 'held') assert.deepEqual(unseen.reasons, ['new_address']);

  const poor = holdWithdrawalOutlook(app, { amount: 2_000n, destination, balance: 1_000n, now });
  assert.deepEqual(poor, { outcome: 'refused', reason: 'insufficient_funds' });
});

test('opening a vault and stopping a withdrawal use the vault client instruction bytes', async () => {
  const { idl } = await loadSdk();
  const { INIT_VAULT_DISCRIMINATOR, STOP_DISCRIMINATOR } = idl;
  const program = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const guardian = Keypair.generate().publicKey;
  const safe = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const opened = initVaultInstruction({
    programId: program,
    owner,
    vaultId: 3n,
    guardian,
    safeAddress: safe,
    dailyLimit: 50n,
    delaySecs: DAY * 2n,
    bigShareBps: 2500,
    mint,
  });
  assert.ok(opened.data.subarray(0, 8).equals(INIT_VAULT_DISCRIMINATOR));
  assert.equal(readU64(opened.data, 8), 3n);
  assert.equal(new PublicKey(opened.data.subarray(16, 48)).toBase58(), guardian.toBase58());
  assert.equal(new PublicKey(opened.data.subarray(48, 80)).toBase58(), safe.toBase58());
  assert.equal(readU64(opened.data, 80), 50n);
  assert.equal(readI64(opened.data, 88), DAY * 2n);
  assert.equal(opened.data.readUInt16LE(96), 2500);
  assert.equal(opened.keys[0]?.pubkey.toBase58(), owner.toBase58());
  assert.equal(opened.keys[0]?.isSigner, true);
  assert.equal(opened.keys[0]?.isWritable, true);
  assert.equal(opened.keys[1]?.pubkey.toBase58(), holdVaultPda(program, owner, 3n).toBase58());

  const stopped = stopInstruction({
    programId: program,
    authority: guardian,
    owner,
    vaultId: 3n,
    id: 9n,
  });
  assert.ok(stopped.data.subarray(0, 8).equals(STOP_DISCRIMINATOR));
  assert.equal(readU64(stopped.data, 8), 9n);
  assert.equal(stopped.keys[0]?.pubkey.toBase58(), guardian.toBase58());
  assert.equal(stopped.keys[0]?.isSigner, true);
});

test('a partial signature can be read again on the other phone', async () => {
  const { signHoldPartial } = await import('./holdSign');
  const owner = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  const store = {
    getItem: async () => null,
    setItem: async () => undefined,
    deleteItem: async () => undefined,
  };
  const payload = await signHoldPartial(
    async (callback) =>
      callback({
        authorize: async () => ({
          accounts: [{ address: 'ignored', publicKey: owner.publicKey.toBytes() }],
          auth_token: 'token',
        }),
        deauthorize: async () => undefined,
        signTransactions: async () => [tx],
      } as MwaWallet),
    store,
    tx,
  );
  const again = Transaction.from(Buffer.from(payload, 'base64'));
  assert.equal(again.feePayer?.toBase58(), owner.publicKey.toBase58());

  await assert.rejects(
    signHoldPartial(
      async (callback) =>
        callback({
          authorize: async () => ({
            accounts: [{ address: 'ignored', publicKey: owner.publicKey.toBytes() }],
            auth_token: 'token',
          }),
          deauthorize: async () => undefined,
        } as MwaWallet),
      store,
      tx,
    ),
    /Both keys have to be on this phone/,
  );
});
