import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import {
  AccountLayout,
  AccountState,
  createInitializeAccount3Instruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type Connection,
  type Transaction,
} from '@solana/web3.js';

import {
  LEDGER_ACCOUNT_SIZE,
  MANDATE_DISCRIMINATOR,
  OPEN_MANDATE_DISC,
  REVOKE_MANDATE_DISC,
  STATUS_ACTIVE,
  STATUS_REVOKED,
  writeI64Le,
  writeU32Le,
  writeU64Le,
} from './constants';
import type { ChainClient, SignAndSend } from './chain';
import { formatBaseUnits } from './format';
import type { MandateAccount } from './mandate';
import { ledgerPda } from './ring';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
const chainModule = import('./chain');

const ROOT = new URL('..', import.meta.url).pathname;

const TOKEN_RENT = 2_039_280;
const MANDATE_RENT = 3_474_240;
const LEDGER_RENT = 11_349_200;
const SIGNATURE_FEE = 5_000;
const SOL_NEEDED = TOKEN_RENT + MANDATE_RENT + LEDGER_RENT + SIGNATURE_FEE;
const CLOSE_MANDATE_DISC = Buffer.from([117, 87, 189, 5, 254, 125, 248, 180]);

const PROGRAM_ID = Keypair.generate().publicKey;

function read(rel: string): string {
  return readFileSync(`${ROOT}/${rel}`, 'utf8');
}

function client(connection: Record<string, unknown>, mint: PublicKey): ChainClient {
  return {
    config: {
      rpcUrl: 'https://api.devnet.solana.com',
      programId: PROGRAM_ID.toBase58(),
      mint: mint.toBase58(),
      explorerCluster: 'devnet',
      mintDecimals: 6,
    },
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
  };
}

function mintData(decimals: number): Buffer {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  return data;
}

function tokenData(amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return data;
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

function mandate(over: Partial<MandateAccount> = {}): MandateAccount {
  const owner = Keypair.generate().publicKey;
  return {
    address: Keypair.generate().publicKey.toBase58(),
    owner: owner.toBase58(),
    agent: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    source: Keypair.generate().publicKey.toBase58(),
    merchant: Keypair.generate().publicKey.toBase58(),
    mandateId: 42n,
    cap: 200n,
    spent: 20n,
    perTxMax: 60n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'rule account',
    status: STATUS_REVOKED,
    spendCount: 0,
    refusalCount: 0,
    bump: 1,
    ...over,
  };
}

function signerSet(tx: Transaction): string[] {
  const signers = new Set<string>();
  for (const ix of tx.instructions) {
    for (const key of ix.keys) {
      if (key.isSigner) {
        signers.add(key.pubkey.toBase58());
      }
    }
  }
  return [...signers];
}

function openInput(owner: PublicKey, agent: PublicKey, merchant: PublicKey) {
  return {
    owner,
    agent,
    merchant,
    cap: 200n,
    perTxMax: 60n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3_600),
    purpose: 'own account',
  };
}

test('the rule token account address is createWithSeed of veto-rule-<mandate id> from the owner', async () => {
  const mod = (await import('./ruleAccount')) as {
    ruleTokenSeed?: (id: bigint) => string;
    deriveRuleTokenAccount?: (
      owner: PublicKey,
      mandateId: bigint,
      tokenProgram: PublicKey,
    ) => Promise<PublicKey>;
  };
  assert.equal(typeof mod.ruleTokenSeed, 'function');
  assert.equal(typeof mod.deriveRuleTokenAccount, 'function');
  const ruleTokenSeed = mod.ruleTokenSeed!;
  const deriveRuleTokenAccount = mod.deriveRuleTokenAccount!;
  assert.equal(ruleTokenSeed(42n), 'veto-rule-42');
  const maxId = 18446744073709551615n;
  const maxSeed = ruleTokenSeed(maxId);
  assert.equal(maxSeed, 'veto-rule-18446744073709551615');
  assert.ok(maxSeed.length <= 32, `${maxSeed.length} bytes fits the seed limit`);

  const owner = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const first = await deriveRuleTokenAccount(owner, 42n, tokenProgram);
  const again = await deriveRuleTokenAccount(owner, 42n, tokenProgram);
  const second = await deriveRuleTokenAccount(owner, 43n, tokenProgram);
  assert.equal(first.toBase58(), again.toBase58());
  assert.notEqual(first.toBase58(), second.toBase58());
  assert.equal(
    first.toBase58(),
    (await PublicKey.createWithSeed(owner, 'veto-rule-42', tokenProgram)).toBase58(),
  );
  assert.notEqual(
    first.toBase58(),
    (await PublicKey.createWithSeed(owner, 'veto-rule-42', TOKEN_PROGRAM_ID)).toBase58(),
  );
});

test('opening a rule creates its token account, moves the cap in, and opens with that account, signed only by the owner', async () => {
  const { openMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const rentSizes: number[] = [];
  let prompts = 0;
  const signed: Transaction[] = [];
  const stop = new Error('stop before send');
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) {
        return { data: mintData(6), owner: tokenProgram, executable: false, lamports: 1 };
      }
      if (address.equals(ata)) {
        return { data: tokenData(1_000n), owner: tokenProgram, executable: false, lamports: 1 };
      }
      return null;
    },
    getBalance: async () => SOL_NEEDED,
    getMinimumBalanceForRentExemption: async (size: number) => {
      rentSizes.push(size);
      if (size === 165) return TOKEN_RENT;
      if (size === 310) return MANDATE_RENT;
      if (size === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
      throw new Error(`unexpected rent size ${size}`);
    },
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }),
    confirmTransaction: async () => {
      throw new Error('confirm must not be reached');
    },
  };
  const signAndSend: SignAndSend = async (txs) => {
    prompts += 1;
    signed.push(...txs);
    throw stop;
  };

  await assert.rejects(
    () => openMandate(client(connection, mint), signAndSend, openInput(owner, agent, merchant)),
    (err: unknown) => err === stop,
  );

  assert.equal(prompts, 1, 'one wallet prompt');
  assert.equal(signed.length, 1, 'one transaction');
  assert.deepEqual(rentSizes.sort((a, b) => a - b), [165, 310, LEDGER_ACCOUNT_SIZE].sort((a, b) => a - b));
  const tx = signed[0]!;
  assert.equal(tx.feePayer?.toBase58(), owner.toBase58());
  assert.equal(tx.instructions.length, 4);
  assert.deepEqual(signerSet(tx), [owner.toBase58()]);

  const openIx = tx.instructions[3]!;
  assert.ok(openIx.programId.equals(PROGRAM_ID));
  assert.ok(Buffer.from(openIx.data.subarray(0, 8)).equals(OPEN_MANDATE_DISC));
  const mandateId = Buffer.from(openIx.data).readBigUInt64LE(8);
  const seed = `veto-rule-${mandateId.toString()}`;
  const ruleAccount = await PublicKey.createWithSeed(owner, seed, tokenProgram);
  assert.equal(Buffer.from(openIx.data).readBigUInt64LE(80), 200n, 'open_mandate cap is the cap');
  assert.ok(openIx.keys[3]?.pubkey.equals(ruleAccount), 'open_mandate source is the rule account');
  assert.equal(openIx.keys[3]?.isSigner, false, 'the rule account is not a signer');
  assert.equal(openIx.keys[3]?.pubkey.equals(ata), false, 'open_mandate source is not the associated token account');

  const expectedCreate = SystemProgram.createAccountWithSeed({
    fromPubkey: owner,
    basePubkey: owner,
    seed,
    newAccountPubkey: ruleAccount,
    lamports: TOKEN_RENT,
    space: 165,
    programId: tokenProgram,
  });
  assert.ok(tx.instructions[0]?.programId.equals(SystemProgram.programId));
  assert.deepEqual(Buffer.from(tx.instructions[0]!.data), Buffer.from(expectedCreate.data));
  assert.deepEqual(
    tx.instructions[0]!.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    expectedCreate.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
  );

  const expectedInit = createInitializeAccount3Instruction(ruleAccount, mint, owner, tokenProgram);
  assert.deepEqual(Buffer.from(tx.instructions[1]!.data), Buffer.from(expectedInit.data));
  assert.ok(tx.instructions[1]?.programId.equals(tokenProgram));
  assert.deepEqual(
    tx.instructions[1]!.keys.map((key) => key.pubkey.toBase58()),
    expectedInit.keys.map((key) => key.pubkey.toBase58()),
  );

  const expectedTransfer = createTransferCheckedInstruction(
    ata,
    mint,
    ruleAccount,
    owner,
    200n,
    6,
    [],
    tokenProgram,
  );
  assert.deepEqual(Buffer.from(tx.instructions[2]!.data), Buffer.from(expectedTransfer.data));
  assert.ok(tx.instructions[2]?.programId.equals(tokenProgram));
  assert.deepEqual(
    tx.instructions[2]!.keys.map((key) => [key.pubkey.toBase58(), key.isSigner]),
    expectedTransfer.keys.map((key) => [key.pubkey.toBase58(), key.isSigner]),
  );
  assert.ok(
    tx.instructions.every((ix) => ix.keys.every((key) => !key.pubkey.equals(ruleAccount) || !key.isSigner)),
    'the derived account never signs',
  );
});

test('open refuses before the wallet prompt when the associated token account does not hold the cap', async () => {
  const { openMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  let prompts = 0;
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) {
        return { data: mintData(6), owner: tokenProgram, executable: false, lamports: 1 };
      }
      if (address.equals(ata)) {
        return { data: tokenData(50n), owner: tokenProgram, executable: false, lamports: 1 };
      }
      return null;
    },
    getBalance: async () => SOL_NEEDED,
    getMinimumBalanceForRentExemption: async (size: number) => {
      if (size === 165) return TOKEN_RENT;
      if (size === 310) return MANDATE_RENT;
      if (size === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
      throw new Error(`unexpected rent size ${size}`);
    },
    getLatestBlockhash: async () => {
      throw new Error('blockhash must not be fetched when funds are short');
    },
  };
  await assert.rejects(
    () =>
      openMandate(client(connection, mint), async () => {
        prompts += 1;
        return ['sig'];
      }, openInput(owner, agent, merchant)),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(ata.toBase58()));
      assert.match(err.message, /holds 0\.00005/);
      assert.match(err.message, /needs 0\.0002/);
      assert.match(err.message, /Short by 0\.00015/);
      assert.doesNotMatch(err.message, /base units/);
      assert.doesNotMatch(err.message, /lamports/);
      return true;
    },
  );
  assert.equal(prompts, 0);
});

test('open refuses before the wallet prompt when the associated token account does not exist', async () => {
  const { openMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  let prompts = 0;
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) {
        return { data: mintData(6), owner: tokenProgram, executable: false, lamports: 1 };
      }
      return null;
    },
    getBalance: async () => SOL_NEEDED,
    getMinimumBalanceForRentExemption: async (size: number) => {
      if (size === 165) return TOKEN_RENT;
      if (size === 310) return MANDATE_RENT;
      if (size === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
      throw new Error(`unexpected rent size ${size}`);
    },
    getLatestBlockhash: async () => {
      throw new Error('blockhash must not be fetched when funds are short');
    },
  };
  await assert.rejects(
    () =>
      openMandate(
        client(connection, mint),
        async () => {
          prompts += 1;
          return ['sig'];
        },
        openInput(owner, Keypair.generate().publicKey, Keypair.generate().publicKey),
      ),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, new RegExp(mint.toBase58()));
      assert.match(message, /holds none/i);
      assert.match(message, /will not create/i);
      assert.doesNotMatch(message, /base units/);
      return true;
    },
  );
  assert.equal(prompts, 0);
  assert.ok(ata);
});

test('open refuses before the wallet prompt when the wallet cannot pay the rule account, mandate, ledger, and fee', async () => {
  const { openMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const held = SOL_NEEDED - 1;
  let prompts = 0;
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) {
        return { data: mintData(6), owner: tokenProgram, executable: false, lamports: 1 };
      }
      if (address.equals(ata)) {
        return { data: tokenData(1_000n), owner: tokenProgram, executable: false, lamports: 1 };
      }
      return null;
    },
    getBalance: async () => held,
    getMinimumBalanceForRentExemption: async (size: number) => {
      if (size === 165) return TOKEN_RENT;
      if (size === 310) return MANDATE_RENT;
      if (size === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
      throw new Error(`unexpected rent size ${size}`);
    },
    getLatestBlockhash: async () => {
      throw new Error('blockhash must not be fetched when funds are short');
    },
  };
  await assert.rejects(
    () =>
      openMandate(
        client(connection, mint),
        async () => {
          prompts += 1;
          return ['sig'];
        },
        openInput(owner, Keypair.generate().publicKey, Keypair.generate().publicKey),
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(`holds ${held} lamports`));
      assert.match(err.message, new RegExp(`needs ${SOL_NEEDED} lamports`));
      assert.match(err.message, new RegExp(`${TOKEN_RENT} for the rule token account`));
      assert.match(err.message, new RegExp(`${MANDATE_RENT} for the mandate`));
      assert.match(err.message, new RegExp(`${LEDGER_RENT} for the ledger`));
      assert.match(err.message, new RegExp(`${SIGNATURE_FEE} for the fee`));
      assert.match(err.message, /short by 1 lamports/);
      assert.doesNotMatch(err.message, /base units/);
      return true;
    },
  );
  assert.equal(prompts, 0);
});

test('open refuses before the wallet prompt with both the token shortfall and the lamport shortfall', async () => {
  const { openMandate } = await chainModule;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  let prompts = 0;
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) {
        return { data: mintData(6), owner: tokenProgram, executable: false, lamports: 1 };
      }
      if (address.equals(ata)) {
        return { data: tokenData(10n), owner: tokenProgram, executable: false, lamports: 1 };
      }
      return null;
    },
    getBalance: async () => 100,
    getMinimumBalanceForRentExemption: async (size: number) => {
      if (size === 165) return TOKEN_RENT;
      if (size === 310) return MANDATE_RENT;
      if (size === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
      throw new Error(`unexpected rent size ${size}`);
    },
    getLatestBlockhash: async () => {
      throw new Error('blockhash must not be fetched when funds are short');
    },
  };
  await assert.rejects(
    () =>
      openMandate(
        client(connection, mint),
        async () => {
          prompts += 1;
          return ['sig'];
        },
        openInput(owner, Keypair.generate().publicKey, Keypair.generate().publicKey),
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Short by 0\.00019/);
      assert.doesNotMatch(err.message, /base units/);
      assert.match(err.message, new RegExp(`short by ${SOL_NEEDED - 100} lamports`));
      return true;
    },
  );
  assert.equal(prompts, 0);
});

function closeConnection(args: {
  row: MandateAccount;
  tokenProgram: PublicKey;
  sourceAmount: bigint | null;
  ataExists: boolean;
}) {
  const mint = new PublicKey(args.row.mint);
  const source = new PublicKey(args.row.source);
  const owner = new PublicKey(args.row.owner);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, args.tokenProgram);
  const mandateKey = new PublicKey(args.row.address);
  const bytes = encodeMandate(args.row);
  return {
    ata,
    connection: {
      getAccountInfo: async (address: PublicKey) => {
        if (address.equals(mandateKey)) {
          return { data: bytes, owner: PROGRAM_ID, executable: false, lamports: 1 };
        }
        if (address.equals(mint)) {
          return { data: mintData(6), owner: args.tokenProgram, executable: false, lamports: 1 };
        }
        if (address.equals(source)) {
          if (args.sourceAmount === null) return null;
          return {
            data: tokenData(args.sourceAmount),
            owner: args.tokenProgram,
            executable: false,
            lamports: 1,
          };
        }
        if (address.equals(ata) && args.ataExists) {
          return { data: tokenData(0n), owner: args.tokenProgram, executable: false, lamports: 1 };
        }
        return null;
      },
      getBalance: async () => 50_000_000,
      getMinimumBalanceForRentExemption: async (size: number) => {
        if (size === 0) return 890_880;
        if (size === 165) return TOKEN_RENT;
        if (size === 310) return MANDATE_RENT;
        if (size === LEDGER_ACCOUNT_SIZE) return LEDGER_RENT;
        throw new Error(`unexpected rent size ${size}`);
      },
      getLatestBlockhash: async () => ({
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 1,
      }),
      confirmTransaction: async () => {
        throw new Error('confirm must not be reached');
      },
    },
  };
}

async function captureClose(
  row: MandateAccount,
  tokenProgram: PublicKey,
  sourceAmount: bigint | null,
  ataExists: boolean,
): Promise<Transaction> {
  const chain = await chainModule;
  assert.equal(typeof chain.closeMandate, 'function', 'closeMandate is exported');
  const { ata, connection } = closeConnection({ row, tokenProgram, sourceAmount, ataExists });
  const signed: Transaction[] = [];
  const stop = new Error('stop before send');
  await assert.rejects(
    () =>
      chain.closeMandate!(
        client(connection, new PublicKey(row.mint)),
        async (txs) => {
          signed.push(...txs);
          throw stop;
        },
        new PublicKey(row.owner),
        row,
      ),
    (err: unknown) => err === stop,
  );
  assert.equal(signed.length, 1);
  assert.equal(signed[0]?.feePayer?.toBase58(), row.owner);
  assert.deepEqual(signerSet(signed[0]!), [row.owner]);
  return Object.assign(signed[0]!, { ata });
}

test('closing a finished dedicated rule returns the remaining balance and the rule account rent, then closes the mandate', async () => {
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const mandateId = 77n;
  const { deriveRuleTokenAccount } = await import('./ruleAccount');
  const source = await deriveRuleTokenAccount(owner, mandateId, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: source.toBase58(),
    mandateId,
    status: STATUS_REVOKED,
  });
  const tx = await captureClose(row, tokenProgram, 40n, true);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  assert.equal(tx.instructions.length, 3);
  const transfer = tx.instructions[0]!;
  const closeAccount = tx.instructions[1]!;
  const closeMandateIx = tx.instructions[2]!;
  assert.equal(transfer.data[0], 12);
  assert.equal(Buffer.from(transfer.data).readBigUInt64LE(1), 40n);
  assert.ok(transfer.keys[0]?.pubkey.equals(source));
  assert.ok(transfer.keys[2]?.pubkey.equals(ata));
  assert.equal(closeAccount.data[0], 9);
  assert.ok(closeAccount.keys[0]?.pubkey.equals(source));
  assert.ok(closeAccount.keys[1]?.pubkey.equals(owner));
  assert.ok(closeAccount.keys[2]?.pubkey.equals(owner) && closeAccount.keys[2]?.isSigner);
  assert.ok(Buffer.from(closeMandateIx.data).equals(CLOSE_MANDATE_DISC));
  assert.equal(closeMandateIx.keys.length, 3);
  assert.ok(closeMandateIx.keys[0]?.pubkey.equals(owner) && closeMandateIx.keys[0]?.isSigner && closeMandateIx.keys[0]?.isWritable);
  assert.ok(closeMandateIx.keys[1]?.pubkey.equals(new PublicKey(row.address)));
  assert.ok(closeMandateIx.keys[2]?.pubkey.equals(ledgerPda(PROGRAM_ID, new PublicKey(row.address))));
  assert.ok(tx.instructions.every((ix) => ix.data[0] !== 9 || ix.keys[0]?.pubkey.equals(source)));
});

test('closing a dedicated rule that is still active revokes it first in the same transaction', async () => {
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const mandateId = 78n;
  const { deriveRuleTokenAccount } = await import('./ruleAccount');
  const source = await deriveRuleTokenAccount(owner, mandateId, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: source.toBase58(),
    mandateId,
    status: STATUS_ACTIVE,
  });
  const tx = await captureClose(row, tokenProgram, 15n, true);
  assert.equal(tx.instructions.length, 4);
  const revoke = tx.instructions[0]!;
  assert.ok(revoke.programId.equals(PROGRAM_ID));
  assert.ok(Buffer.from(revoke.data).equals(REVOKE_MANDATE_DISC));
  assert.ok(revoke.keys[3]?.pubkey.equals(source));
  assert.equal(tx.instructions[1]?.data[0], 12);
  assert.equal(tx.instructions[2]?.data[0], 9);
  assert.ok(Buffer.from(tx.instructions[3]!.data).equals(CLOSE_MANDATE_DISC));
});

test('closing a dedicated rule with nothing left does not transfer zero, and still closes the rule account', async () => {
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const mandateId = 79n;
  const { deriveRuleTokenAccount } = await import('./ruleAccount');
  const source = await deriveRuleTokenAccount(owner, mandateId, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: source.toBase58(),
    mandateId,
    status: STATUS_REVOKED,
  });
  const tx = await captureClose(row, tokenProgram, 0n, true);
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[0]?.data[0], 9);
  assert.ok(tx.instructions[0]?.keys[0]?.pubkey.equals(source));
  assert.ok(Buffer.from(tx.instructions[1]!.data).equals(CLOSE_MANDATE_DISC));
  assert.ok(tx.instructions.every((ix) => ix.data[0] !== 12));
});

test('closing a dedicated rule creates the associated token account when the remaining balance has nowhere to land', async () => {
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const mandateId = 80n;
  const { deriveRuleTokenAccount } = await import('./ruleAccount');
  const source = await deriveRuleTokenAccount(owner, mandateId, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: source.toBase58(),
    mandateId,
    status: STATUS_REVOKED,
  });
  const tx = await captureClose(row, tokenProgram, 9n, false);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  assert.equal(tx.instructions.length, 4);
  assert.ok(tx.instructions[0]?.keys.some((key) => key.pubkey.equals(ata)));
  assert.equal(tx.instructions[1]?.data[0], 12);
  assert.ok(tx.instructions[1]?.keys[2]?.pubkey.equals(ata));
  assert.equal(tx.instructions[2]?.data[0], 9);
  assert.ok(Buffer.from(tx.instructions[3]!.data).equals(CLOSE_MANDATE_DISC));
});

test('closing refuses before the prompt when the new associated token account would leave the wallet short of rent', async () => {
  const { closeMandate } = await chainModule;
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const mandateId = 83n;
  const { deriveRuleTokenAccount } = await import('./ruleAccount');
  const source = await deriveRuleTokenAccount(owner, mandateId, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: source.toBase58(),
    mandateId,
    status: STATUS_REVOKED,
  });
  const { connection } = closeConnection({ row, tokenProgram, sourceAmount: 9n, ataExists: false });
  const needed = TOKEN_RENT + SIGNATURE_FEE;
  let prompts = 0;
  connection.getBalance = async () => needed - 1;
  await assert.rejects(
    () =>
      closeMandate(
        client(connection, mint),
        async () => {
          prompts += 1;
          return ['sig'];
        },
        owner,
        row,
      ),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /rent/i);
      assert.match(message, /fee/i);
      assert.match(message, new RegExp(String(needed)));
      assert.match(message, new RegExp(`${TOKEN_RENT} for the associated token account`));
      return true;
    },
  );
  assert.equal(prompts, 0);
});

test('closing refuses before the prompt when the new associated token account would leave the wallet above zero and under its rent floor', async () => {
  const { closeMandate } = await chainModule;
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const mandateId = 84n;
  const { deriveRuleTokenAccount } = await import('./ruleAccount');
  const source = await deriveRuleTokenAccount(owner, mandateId, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: source.toBase58(),
    mandateId,
    status: STATUS_REVOKED,
  });
  const { connection } = closeConnection({ row, tokenProgram, sourceAmount: 9n, ataExists: false });
  const needed = TOKEN_RENT + SIGNATURE_FEE;
  const floor = 890_880;
  let prompts = 0;
  connection.getBalance = async () => needed + 1;
  connection.getMinimumBalanceForRentExemption = async (size: number) => {
    if (size === 0) return floor;
    if (size === 165) return TOKEN_RENT;
    throw new Error(`unexpected rent size ${size}`);
  };
  await assert.rejects(
    () =>
      closeMandate(
        client(connection, mint),
        async () => {
          prompts += 1;
          return ['sig'];
        },
        owner,
        row,
      ),
    (err: unknown) => err instanceof Error && /rent floor/i.test(err.message),
  );
  assert.equal(prompts, 0);
});

test('the rule balance is withheld unless the source is a token account of this mint owned by the owner', async () => {
  const { readRuleFunds } = await chainModule;
  const { deriveRuleTokenAccount } = await import('./ruleAccount');
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const source = await deriveRuleTokenAccount(owner, 85n, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: source.toBase58(),
    mandateId: 85n,
  });
  const amount = 4_560_000n;
  const matching = Buffer.alloc(165);
  Buffer.from(mint.toBytes()).copy(matching, 0);
  Buffer.from(owner.toBytes()).copy(matching, 32);
  matching.writeBigUInt64LE(amount, 64);
  const wrongMint = Buffer.from(matching);
  Buffer.from(Keypair.generate().publicKey.toBytes()).copy(wrongMint, 0);
  const wrongOwner = Buffer.from(matching);
  Buffer.from(Keypair.generate().publicKey.toBytes()).copy(wrongOwner, 32);
  const cases: Array<{ data: Buffer; program: PublicKey; expected: bigint | null }> = [
    { data: matching, program: tokenProgram, expected: amount },
    { data: matching, program: Keypair.generate().publicKey, expected: null },
    { data: wrongMint, program: tokenProgram, expected: null },
    { data: wrongOwner, program: tokenProgram, expected: null },
  ];
  for (const item of cases) {
    const connection = {
      getAccountInfo: async (address: PublicKey) => {
        if (address.equals(mint)) {
          return { data: mintData(6), owner: tokenProgram, executable: false, lamports: 1 };
        }
        if (address.equals(source)) {
          return { data: item.data, owner: item.program, executable: false, lamports: 1 };
        }
        return null;
      },
    };
    const funds = await readRuleFunds(client(connection, mint), row);
    assert.equal(funds.balance, item.expected);
    assert.equal(funds.kind, 'dedicated');
  }
});

test('closing a legacy rule whose source is the associated token account does not close that account', async () => {
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: ata.toBase58(),
    mandateId: 81n,
    status: STATUS_REVOKED,
  });
  const tx = await captureClose(row, tokenProgram, 500n, true);
  assert.equal(tx.instructions.length, 1);
  assert.ok(Buffer.from(tx.instructions[0]!.data).equals(CLOSE_MANDATE_DISC));
  assert.ok(tx.instructions.every((ix) => ix.data[0] !== 9 && ix.data[0] !== 12));
  assert.ok(tx.instructions.every((ix) => !ix.keys.some((key) => key.pubkey.equals(ata) && ix.data[0] === 9)));
});

test('closing a legacy rule that is still active revokes it and leaves the associated token account open', async () => {
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: ata.toBase58(),
    mandateId: 82n,
    status: STATUS_ACTIVE,
  });
  const tx = await captureClose(row, tokenProgram, 500n, true);
  assert.equal(tx.instructions.length, 2);
  assert.ok(Buffer.from(tx.instructions[0]!.data).equals(REVOKE_MANDATE_DISC));
  assert.ok(tx.instructions[0]?.keys[3]?.pubkey.equals(ata));
  assert.ok(Buffer.from(tx.instructions[1]!.data).equals(CLOSE_MANDATE_DISC));
  assert.ok(tx.instructions.every((ix) => ix.data[0] !== 9 && ix.data[0] !== 12));
});

test('the rule screen shows each rule balance, where it lives, and close when the rule is not active', async () => {
  const src = read('app/rule/[address].tsx');
  const chain = read('lib/useChain.ts');
  const { budgetLine } = await import('./ruleAccount');
  assert.equal(
    budgetLine('dedicated'),
    "The budget sits in this rule's own account and comes back to you when you close the rule.",
  );
  assert.match(src, /label="Balance"/);
  assert.match(src, /label="Account"/);
  assert.match(src, /value=\{mandate\.source\}/);
  assert.match(src, /budgetLine\(funds\.kind\)/);
  const branchStart = src.indexOf('!isActive(mandate, nowSec)');
  assert.ok(branchStart !== -1);
  const branch = src.slice(branchStart, src.indexOf(': null}', branchStart));
  assert.match(branch, /Hold to close this rule/);
  assert.match(branch, /closeNote\(/);
  assert.match(src, /chain\.close\(/);
  assert.match(chain, /closeMandate\(/);
});

function tokenAccountWithDelegate(amount: bigint, delegate: PublicKey | null): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: PublicKey.default,
      owner: PublicKey.default,
      amount,
      delegateOption: delegate ? 1 : 0,
      delegate: delegate ?? PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

test('the rule screen balance uses the rule mint decimals, so one token of a 9-decimal mint reads as 1', async () => {
  const { readRuleFunds } = await chainModule;
  const { deriveRuleTokenAccount } = await import('./ruleAccount');
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const source = await deriveRuleTokenAccount(owner, 90n, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: source.toBase58(),
    mandateId: 90n,
  });
  const balance = 1_000_000_000n;
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) {
        return { data: mintData(9), owner: tokenProgram, executable: false, lamports: 1 };
      }
      if (address.equals(source)) {
        const data = tokenData(balance);
        Buffer.from(mint.toBytes()).copy(data, 0);
        Buffer.from(owner.toBytes()).copy(data, 32);
        return { data, owner: tokenProgram, executable: false, lamports: 1 };
      }
      return null;
    },
  };
  const funds = await readRuleFunds(client(connection, mint), row);
  assert.equal(funds.decimals, 9);
  assert.equal(funds.balance, balance);
  assert.equal(formatBaseUnits(funds.balance ?? 0n, funds.decimals ?? 6), '1');
  const src = read('app/rule/[address].tsx');
  assert.match(src, /formatBaseUnits\(funds\.balance, funds\.decimals\)/);
});

test('before revoke or close, a legacy rule names the other rule whose delegate the signature clears', async () => {
  const { readRuleFunds } = await chainModule;
  const { otherDelegateWarning, revokeNote } = await import('./ruleAccount');
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const other = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    purpose: 'groceries',
    status: STATUS_ACTIVE,
  });
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: ata.toBase58(),
    mandateId: 91n,
    status: STATUS_ACTIVE,
  });
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) {
        return { data: mintData(6), owner: tokenProgram, executable: false, lamports: 1 };
      }
      if (address.equals(ata)) {
        return {
          data: tokenAccountWithDelegate(500n, new PublicKey(other.address)),
          owner: tokenProgram,
          executable: false,
          lamports: 1,
        };
      }
      if (address.equals(new PublicKey(other.address))) {
        return { data: encodeMandate(other), owner: PROGRAM_ID, executable: false, lamports: 1 };
      }
      return null;
    },
  };
  const funds = await readRuleFunds(client(connection, mint), row);
  assert.equal(funds.kind, 'associated');
  assert.ok(funds.otherRule);
  assert.match(funds.otherRule, /groceries/);
  assert.match(funds.otherRule, new RegExp(other.address));
  const sentence = otherDelegateWarning(funds.otherRule);
  assert.match(sentence, /This signature also clears the delegate another rule depends on/);
  assert.match(sentence, /groceries/);
  assert.match(revokeNote(), /This signature clears that account's single delegate/);
  const src = read('app/rule/[address].tsx');
  const warnAt = src.indexOf('otherDelegateWarning(funds.otherRule)');
  const revokeAt = src.indexOf('Revoke this rule');
  const closeAt = src.indexOf('Hold to close this rule');
  assert.ok(warnAt !== -1 && revokeAt !== -1 && closeAt !== -1);
  assert.ok(warnAt < revokeAt && warnAt < closeAt);
  assert.match(src, /revokeNote\(\)/);
});

test('a legacy rule whose delegate is itself does not name another rule', async () => {
  const { readRuleFunds } = await chainModule;
  const tokenProgram = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const row = mandate({
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    source: ata.toBase58(),
    mandateId: 92n,
    status: STATUS_ACTIVE,
  });
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(mint)) {
        return { data: mintData(6), owner: tokenProgram, executable: false, lamports: 1 };
      }
      if (address.equals(ata)) {
        return {
          data: tokenAccountWithDelegate(500n, new PublicKey(row.address)),
          owner: tokenProgram,
          executable: false,
          lamports: 1,
        };
      }
      return null;
    },
  };
  const funds = await readRuleFunds(client(connection, mint), row);
  assert.equal(funds.otherRule, null);
});
