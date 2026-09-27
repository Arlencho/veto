// Critic round 1 fixtures for the phone test-request runner (PR 359).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction, type TransactionResponse } from '@solana/web3.js';
import { PROGRAM_ID } from '../../sdk/src/idl';
import { world, paidLog, refusedLog } from '../../sdk/src/testkit';
import { prepareTestRequests, runTestRequests, type TestRequestUpdate } from './testRequests';

function harness(patch = {}) {
  const w = world({ balance: 5_000_000, expiresAt: 9_000_000_000n, ...patch });
  const updates: TestRequestUpdate[] = [];
  const walletTransactions: Transaction[] = [];
  w.connection.getFeeForMessage = async () => ({ context: { slot: 1 }, value: 5000 });
  w.fake.balances.set(w.owner.publicKey.toBase58(), 20_000_000);
  const decisionFor = (): TransactionResponse => {
    const tx = Transaction.from(w.fake.sent.at(-1)!);
    const data = tx.instructions[0].data;
    const amount = data.readBigUInt64LE(8), nonce = data.readBigUInt64LE(16);
    return { meta: { err: null, logMessages: [amount <= 10_000_000n ? paidLog(w.mandate, amount, nonce, amount) : refusedLog(w.mandate, amount, nonce, 5, amount)] } } as unknown as TransactionResponse;
  };
  w.connection.getTransaction = (async () => decisionFor()) as typeof w.connection.getTransaction;
  const options = {
    connection: w.connection, programId: PROGRAM_ID, cluster: 'devnet', address: w.mandate.toBase58(), owner: w.owner.publicKey.toBase58(),
    getAgentPublicKey: async () => w.agent.publicKey,
    signWithAgent: async (transaction: Transaction) => { transaction.sign(w.agent); return transaction; },
    signAndSend: async (transactions: Transaction[]) => { walletTransactions.push(...transactions); return ['top-up-signature']; },
    report: (update: TestRequestUpdate) => updates.push(update),
  };
  return { w, updates, walletTransactions, options, decisionFor };
}

const sentNonces = (h: ReturnType<typeof harness>) =>
  h.w.fake.sent.map(raw => Transaction.from(raw).instructions[0].data.readBigUInt64LE(16));

// R1. A pending owner override (override_nonce above last_nonce) is a one-shot
// authorization at exactly that nonce (programs/veto/src/state.rs:85). The runner
// jumps past it: it pays at override_nonce + 1, which sets last_nonce beyond the
// override, and the program then refuses the override nonce as stale forever
// (programs/veto/src/lib.rs:497). grant_override cannot re-arm it below last_nonce
// (lib.rs:288). The SDK rule the runner is meant to mirror never charges past a
// pending override: nextNonce() returns the override nonce and charge() with
// guardPendingOverride refuses a different amount (sdk/src/agent.ts:463-472, 608-617).
// Expected: no test charge is sent while an override is pending and the owner is
// told why, by fixed text that names the override.
test('critic r1: a pending owner override stops the run before any charge is sent', async () => {
  const h = harness({ lastNonce: 12n, overrideNonce: 30n, overrideAmount: 50_000_000n });
  let plan: Awaited<ReturnType<typeof prepareTestRequests>> | null = null;
  try { plan = await prepareTestRequests(h.options); } catch (error) { h.updates.push({ text: error instanceof Error ? error.message : String(error) }); }
  if (plan) await runTestRequests(h.options, plan);
  assert.deepEqual(sentNonces(h), [], 'the runner charged at nonces above the pending override and buried it');
  assert.equal(h.walletTransactions.length, 0);
  assert.match(h.updates.at(-1)?.text ?? '', /override/i);
});

// R2. After confirmTransaction returns, getTransaction can still answer null on a
// lagging RPC node. The SDK the runner mirrors polls up to eight times
// (sdk/src/agent.ts:1033-1041). The runner reads once (app/lib/testRequests.ts:141-142)
// and aborts: the paid charge has landed, the second request is never sent, and the
// tester is told the transaction "may still land" when it already did.
test('critic r1: one null decision read after a confirmed charge does not abandon the second request', async () => {
  const h = harness();
  let reads = 0;
  h.w.connection.getTransaction = (async () => (reads++ === 0 ? null : h.decisionFor())) as typeof h.w.connection.getTransaction;
  await runTestRequests(h.options, await prepareTestRequests(h.options));
  assert.deepEqual(sentNonces(h), [1n, 2n], 'the run stopped after the paid charge');
  assert.ok(h.updates.some(row => row.text.startsWith('Paid 5000000 base units')));
  assert.ok(h.updates.some(row => row.text.startsWith('Refused 10000001 base units')));
});
