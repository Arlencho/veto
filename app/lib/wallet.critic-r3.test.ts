// Critic round 3 fixtures for PR 359: the runner's real charge transactions
// pass the agent signing guard, and every refusal keeps the secret out of its text.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import { Keypair, SystemProgram, Transaction, type TransactionResponse } from '@solana/web3.js';
import { PROGRAM_ID } from '../../sdk/src/idl';
import { world, paidLog, refusedLog } from '../../sdk/src/testkit';
import { decodeMandateAccount } from './mandate';
import { prepareTestRequests, runTestRequests, testChargeInstruction, type TestRequestUpdate } from './testRequests';
import { AGENT_SECRET_STORE_KEY, signWithAgent, type WalletStore } from './wallet';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {
  vetoRpc: 'https://api.devnet.solana.com', vetoProgramId: PROGRAM_ID.toBase58(),
} } } });
const REFUSED = 'Agent signing is restricted to a single Veto charge.';

function storeWith(agent: Keypair): WalletStore {
  const data: Record<string, string> = { [AGENT_SECRET_STORE_KEY]: Buffer.from(agent.secretKey).toString('base64') };
  return {
    async getItem(key) { return data[key] ?? null; },
    async setItem(key, value) { data[key] = value; },
    async deleteItem(key) { delete data[key]; },
  };
}

test('critic r3: the runner still signs and lands both test charges through the real agent signing guard', async () => {
  const w = world({ balance: 5_000_000, expiresAt: 9_000_000_000n });
  const updates: TestRequestUpdate[] = [];
  const walletTransactions: Transaction[] = [];
  w.connection.getFeeForMessage = async () => ({ context: { slot: 1 }, value: 5000 });
  w.connection.getTransaction = async () => {
    const tx = Transaction.from(w.fake.sent.at(-1)!);
    const data = tx.instructions[0].data;
    const amount = data.readBigUInt64LE(8), nonce = data.readBigUInt64LE(16);
    return { meta: { err: null, logMessages: [amount <= 10_000_000n ? paidLog(w.mandate, amount, nonce, amount) : refusedLog(w.mandate, amount, nonce, 5, amount)] } } as unknown as TransactionResponse;
  };
  const store = storeWith(w.agent);
  const options = {
    connection: w.connection, programId: PROGRAM_ID, cluster: 'devnet', address: w.mandate.toBase58(), owner: w.owner.publicKey.toBase58(),
    getAgentPublicKey: async () => w.agent.publicKey,
    signWithAgent: (transaction: Transaction) => signWithAgent(store, transaction),
    signAndSend: async (transactions: Transaction[]) => { walletTransactions.push(...transactions); return ['top-up-signature']; },
    report: (update: TestRequestUpdate) => updates.push(update),
  };
  await runTestRequests(options, await prepareTestRequests(options));
  assert.equal(walletTransactions.length, 0, 'no wallet transaction was needed');
  assert.deepEqual(w.fake.sent.map(raw => Transaction.from(raw).instructions[0].data.readBigUInt64LE(16)), [1n, 2n], 'both charges were sent');
  for (const raw of w.fake.sent) {
    const tx = Transaction.from(raw);
    assert.equal(tx.feePayer?.toBase58(), w.agent.publicKey.toBase58());
    assert.equal(tx.signatures.length, 1);
    assert.equal(tx.verifySignatures(), true);
  }
  assert.ok(updates.some(row => row.text === 'Paid 5000000 base units to the payee.' && row.signature));
  assert.ok(updates.some(row => row.text === 'Refused 10000001 base units: over per-payment maximum.' && row.signature));
  assert.equal(updates.some(row => row.text === REFUSED || /could not finish/.test(row.text)), false, 'the guard never fired on the runner');
});

test('critic r3: no refusal text carries the stored secret, and a refused transaction stays unsigned', async () => {
  const agent = Keypair.generate();
  const store = storeWith(agent);
  const secret = Buffer.from(agent.secretKey).toString('base64');
  const secretHex = Buffer.from(agent.secretKey).toString('hex');
  const w = world();
  const rule = decodeMandateAccount(w.mandate.toBase58(), w.fake.accounts.get(w.mandate.toBase58())!.data);
  rule.agent = agent.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const charge = async () => new Transaction({ feePayer: agent.publicKey, recentBlockhash: blockhash })
    .add(await testChargeInstruction(w.connection, PROGRAM_ID, rule, 10n, 1n));
  const shapes: Array<[string, (tx: Transaction) => void]> = [
    ['plain transfer', tx => { tx.instructions = [SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })]; }],
    ['foreign program id', tx => { tx.instructions[0].programId = Keypair.generate().publicKey; }],
    ['two instructions', tx => { tx.add(tx.instructions[0]); }],
    ['wrong fee payer', tx => { tx.feePayer = Keypair.generate().publicKey; }],
  ];
  for (const [name, mutate] of shapes) {
    const tx = await charge();
    mutate(tx);
    await assert.rejects(signWithAgent(store, tx), (error: Error) => {
      assert.equal(error.message, REFUSED, name);
      assert.equal(error.message.includes(secret), false, name);
      assert.equal(error.message.includes(secretHex), false, name);
      assert.equal(error.stack?.includes(secret) ?? false, false, name);
      return true;
    });
    assert.deepEqual(tx.signatures, [], name);
  }
  const good = await charge();
  await signWithAgent(store, good);
  assert.equal(good.verifySignatures(), true, 'the untouched charge still signs');
});
