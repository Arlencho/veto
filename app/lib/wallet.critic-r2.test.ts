// Critic round 2 fixtures for PR 359 (H1): the agent signing API signs only the
// transaction it is given, refuses one the agent is not a signer of, and never
// hands key material back to the caller.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { PROGRAM_ID } from '../../sdk/src/idl';
import { world } from '../../sdk/src/testkit';
import { decodeMandateAccount } from './mandate';
import { testChargeInstruction } from './testRequests';
import { AGENT_SECRET_STORE_KEY, agentPublicKey, signWithAgent, type WalletStore } from './wallet';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {
  vetoRpc: 'https://api.devnet.solana.com', vetoProgramId: PROGRAM_ID.toBase58(),
} } } });
const REFUSED = 'Agent signing is restricted to a single Veto charge.';

async function charge(agent: Keypair) {
  const w = world();
  const rule = decodeMandateAccount(w.mandate.toBase58(), w.fake.accounts.get(w.mandate.toBase58())!.data);
  rule.agent = agent.publicKey.toBase58();
  const instruction = await testChargeInstruction(w.connection, PROGRAM_ID, rule, 10n, 1n);
  return new Transaction({ feePayer: agent.publicKey, recentBlockhash: BLOCKHASH }).add(instruction);
}

function storeWith(agent: Keypair): WalletStore {
  const data: Record<string, string> = { [AGENT_SECRET_STORE_KEY]: Buffer.from(agent.secretKey).toString('base64') };
  return {
    async getItem(key) { return data[key] ?? null; },
    async setItem(key, value) { data[key] = value; },
    async deleteItem(key) { delete data[key]; },
  };
}
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const transfer = (from: Keypair, to: Keypair, lamports: number) =>
  new Transaction({ feePayer: from.publicKey, recentBlockhash: BLOCKHASH })
    .add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to.publicKey, lamports }));

test('critic r2: signWithAgent signs the given transaction in place and returns no key material', async () => {
  const agent = Keypair.generate();
  const store = storeWith(agent);
  assert.equal((await agentPublicKey(store))?.toBase58(), agent.publicKey.toBase58());
  const other = Keypair.generate();
  const transaction = await charge(agent);
  const bystander = transfer(agent, other, 2);
  const signed = await signWithAgent(store, transaction);
  assert.equal(signed, transaction, 'the same transaction object comes back');
  assert.equal(signed.verifySignatures(), true);
  assert.equal(bystander.signatures.length, 0, 'no other transaction was touched');
  assert.equal(Object.keys(signed).some(key => /secret|keypair/i.test(key)), false, 'no key material on the returned object');
  const seed = Buffer.from(agent.secretKey.subarray(0, 32));
  assert.equal(signed.serialize().includes(seed), false, 'the seed is not in the wire bytes');
  assert.equal(JSON.stringify(signed).includes(Buffer.from(agent.secretKey).toString('base64')), false);
});

test('critic r2: a transaction the agent is not a signer of is refused, not signed, without echoing the secret', async () => {
  const agent = Keypair.generate();
  const store = storeWith(agent);
  const owner = Keypair.generate();
  const transaction = transfer(owner, agent, 1);
  const secret = Buffer.from(agent.secretKey).toString('base64');
  await assert.rejects(signWithAgent(store, transaction), (error: Error) => {
    assert.equal(error.message.includes(secret), false);
    return error.message === REFUSED;
  });
  assert.equal(transaction.signatures.every(row => row.signature === null), true, 'the owner transaction carries no signature');
});

test('critic r2: the runner, the hook and the component never name a keypair or the stored secret', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.doesNotMatch(read('./testRequests.ts'), /Keypair|secretKey|loadAgentKeypair|getAgentKeypair/);
  assert.doesNotMatch(read('./useWallet.ts'), /loadAgentKeypair|getAgentKeypair|secretKey|fromSecretKey|AGENT_SECRET_STORE_KEY/);
  assert.doesNotMatch(read('../components/TestRequests.tsx'), /Keypair|secretKey|getAgentKeypair/);
});

for (const [name, mutate] of [
  ['a plain SOL transfer', (tx: Transaction, agent: Keypair) => {
    tx.instructions = transfer(agent, Keypair.generate(), 1).instructions;
  }],
  ['a charge to another program', (tx: Transaction) => { tx.instructions[0].programId = Keypair.generate().publicKey; }],
  ['two charge instructions', (tx: Transaction) => { tx.add(tx.instructions[0]); }],
  ['a wrong fee payer', (tx: Transaction) => { tx.feePayer = Keypair.generate().publicKey; }],
  ['a missing fee payer', (tx: Transaction) => { tx.feePayer = undefined; }],
  ['no instructions', (tx: Transaction) => { tx.instructions = []; }],
  ['a different discriminator', (tx: Transaction) => { tx.instructions[0].data[0] ^= 0xff; }],
  ['a truncated discriminator', (tx: Transaction) => { tx.instructions[0].data = tx.instructions[0].data.subarray(0, 7); }],
  ['an agent account without signer authority', (tx: Transaction) => { tx.instructions[0].keys[0].isSigner = false; }],
  ['no agent account', (tx: Transaction) => { tx.instructions[0].keys.shift(); }],
] as const) {
  test(`agent signing refuses ${name} without adding a signature`, async () => {
    const agent = Keypair.generate();
    const transaction = await charge(agent);
    mutate(transaction, agent);
    await assert.rejects(signWithAgent(storeWith(agent), transaction), { message: REFUSED });
    assert.deepEqual(transaction.signatures, []);
  });
}
