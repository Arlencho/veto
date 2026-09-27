// Critic round 3 fixture for PR 359: with no program id in config the agent
// signing guard fails closed with its fixed text, leaking neither config detail nor the secret.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Buffer } from 'buffer';
import { Keypair, Transaction } from '@solana/web3.js';
import { PROGRAM_ID } from '../../sdk/src/idl';
import { world } from '../../sdk/src/testkit';
import { decodeMandateAccount } from './mandate';
import { testChargeInstruction } from './testRequests';
import { AGENT_SECRET_STORE_KEY, signWithAgent, type WalletStore } from './wallet';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: { vetoRpc: 'https://api.devnet.solana.com' } } } });

test('critic r3: a missing program id refuses a valid charge with the fixed text and no detail', async () => {
  delete process.env.EXPO_PUBLIC_VETO_PROGRAM_ID;
  const agent = Keypair.generate();
  const data: Record<string, string> = { [AGENT_SECRET_STORE_KEY]: Buffer.from(agent.secretKey).toString('base64') };
  const store: WalletStore = {
    async getItem(key) { return data[key] ?? null; },
    async setItem(key, value) { data[key] = value; },
    async deleteItem(key) { delete data[key]; },
  };
  const w = world();
  const rule = decodeMandateAccount(w.mandate.toBase58(), w.fake.accounts.get(w.mandate.toBase58())!.data);
  rule.agent = agent.publicKey.toBase58();
  const tx = new Transaction({ feePayer: agent.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(await testChargeInstruction(w.connection, PROGRAM_ID, rule, 10n, 1n));
  await assert.rejects(signWithAgent(store, tx), { message: 'Agent signing is restricted to a single Veto charge.' });
  assert.deepEqual(tx.signatures, []);
});
