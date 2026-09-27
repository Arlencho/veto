import assert from 'node:assert/strict';
import test from 'node:test';
import { testRequestAmounts, testRequestNonces, testRequestsVisible, needsTestFeeTopUp } from './testRequests';
import type { MandateAccount } from './mandate';

const rule = { agent: 'phone', status: 0, expiresAt: 200n, cap: 100n, spent: 0n, perTxMax: 20n } as MandateAccount;
test('only active devnet payment rules belonging to the phone agent show the action', () => {
  assert.equal(testRequestsVisible(rule, 'phone', 'devnet', 100n), true);
  for (const [r, agent, cluster] of [
    [rule, 'other', 'devnet'], [rule, 'phone', 'mainnet-beta'], [rule, 'phone', 'testnet'],
    [{ ...rule, status: 1 }, 'phone', 'devnet'], [{ ...rule, expiresAt: 100n }, 'phone', 'devnet'],
    [{ ...rule, inMint: 'trade' } as MandateAccount, 'phone', 'devnet'], [null, 'phone', 'devnet'],
  ] as const) assert.equal(testRequestsVisible(r, agent, cluster, 100n), false);
});
test('payment uses half the smaller limit with a one-unit minimum and skips an empty cap', () => {
  assert.deepEqual(testRequestAmounts(rule), { paid: 10n, refused: 21n });
  assert.equal(testRequestAmounts({ ...rule, spent: 95n }).paid, 2n);
  assert.equal(testRequestAmounts({ ...rule, spent: 99n }).paid, 1n);
  assert.equal(testRequestAmounts({ ...rule, spent: 100n }).paid, null);
  assert.throws(() => testRequestAmounts({ ...rule, perTxMax: 0xffffffffffffffffn }));
});
test('nonces strictly increase beyond the last request and inactive override nonce', () => {
  assert.deepEqual(testRequestNonces(12n, 0n), [13n, 14n]);
  assert.deepEqual(testRequestNonces(12n, 30n), [31n, 32n]);
  assert.throws(() => testRequestNonces(0xffffffffffffffffn, 0n));
});
test('fee top-up is needed only below 0.005 SOL', () => {
  assert.equal(needsTestFeeTopUp(4_999_999), true);
  assert.equal(needsTestFeeTopUp(5_000_000), false);
  assert.equal(needsTestFeeTopUp(10_000_000), false);
});

import { readFileSync } from 'node:fs';
import { mock } from 'node:test';
import { PublicKey, SystemInstruction, Transaction, type TransactionInstruction, type TransactionResponse } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { VetoAgent } from '../../sdk/src/agent';
import { PROGRAM_ID } from '../../sdk/src/idl';
import { world, paidLog, refusedLog, tokenAccountData } from '../../sdk/src/testkit';
import { decodeMandateAccount } from './mandate';
import { prepareTestRequests, runTestRequests, testChargeInstruction, testRequestFailure, type TestRequestUpdate } from './testRequests';
import { DEVNET_USDC_MINT, tokenSymbol } from './tokens';

for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
  for (const useAta of [false, true]) test(`charge matches SDK accounts and data (${tokenProgram}, ATA ${useAta})`, async () => {
    const w = world({ tokenProgram });
    if (useAta) {
      const ata = getAssociatedTokenAddressSync(w.mint.publicKey, w.merchant.publicKey, true, tokenProgram);
      w.fake.accounts.set(ata.toBase58(), { data: tokenAccountData(w.mint.publicKey, w.merchant.publicKey), owner: tokenProgram, lamports: 1 });
    }
    const mandate = decodeMandateAccount(w.mandate.toBase58(), w.fake.accounts.get(w.mandate.toBase58())!.data);
    const sdk = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
    let sdkIx: TransactionInstruction | undefined;
    Object.defineProperty(sdk, 'submit', { value: async (ix: TransactionInstruction) => { sdkIx = ix; throw new Error('captured'); } });
    await assert.rejects(sdk.charge({ amount: 10n, nonce: 7n }), /captured/);
    const actual = await testChargeInstruction(w.connection, PROGRAM_ID, mandate, 10n, 7n);
    assert.ok(sdkIx);
    const normalize = (ix: TransactionInstruction) => ({ program: ix.programId.toBase58(), data: [...ix.data], keys: ix.keys.map(key => ({ address: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable })) });
    assert.deepEqual(normalize(actual), normalize(sdkIx));
    const idl = JSON.parse(readFileSync(new URL('../../sdk/idl/veto.json', import.meta.url), 'utf8'));
    assert.deepEqual([...actual.data.subarray(0, 8)], idl.instructions.find((ix: { name: string }) => ix.name === 'charge').discriminator);
  });
}

function harness(balance = 5_000_000, patch = {}) {
  const w = world({ balance, expiresAt: 9_000_000_000n, ...patch });
  const updates: TestRequestUpdate[] = [];
  const walletTransactions: Transaction[] = [];
  w.connection.getFeeForMessage = async () => ({ context: { slot: 1 }, value: 5000 });
  w.fake.balances.set(w.owner.publicKey.toBase58(), 20_000_000);
  w.connection.getTransaction = async () => {
    const tx = Transaction.from(w.fake.sent.at(-1)!);
    const data = tx.instructions[0].data;
    const amount = data.readBigUInt64LE(8), nonce = data.readBigUInt64LE(16);
    return { meta: { err: null, logMessages: [amount <= 10_000_000n ? paidLog(w.mandate, amount, nonce, amount) : refusedLog(w.mandate, amount, nonce, 5, amount)] } } as unknown as TransactionResponse;
  };
  const options = {
    connection: w.connection, programId: PROGRAM_ID, cluster: 'devnet', address: w.mandate.toBase58(), owner: w.owner.publicKey.toBase58(),
    getAgentPublicKey: async () => w.agent.publicKey,
    signWithAgent: async (transaction: Transaction) => { transaction.sign(w.agent); return transaction; },
    signAndSend: async (transactions: Transaction[]) => { walletTransactions.push(...transactions); return ['top-up-signature']; },
    report: (update: TestRequestUpdate) => updates.push(update),
  };
  return { w, updates, walletTransactions, options };
}

test('funded phone agent pays then receives the program refusal with only agent signatures', async () => {
  const h = harness();
  await runTestRequests(h.options, await prepareTestRequests(h.options));
  assert.equal(h.walletTransactions.length, 0);
  assert.deepEqual(h.w.fake.sent.map(raw => Transaction.from(raw).instructions[0].data.readBigUInt64LE(16)), [1n, 2n]);
  for (const raw of h.w.fake.sent) {
    const tx = Transaction.from(raw);
    assert.equal(tx.feePayer?.toBase58(), h.w.agent.publicKey.toBase58());
    assert.equal(tx.signatures.length, 1);
    assert.equal(tx.verifySignatures(), true);
  }
  assert.ok(h.updates.some(row => row.text === `Paid 5 ${tokenSymbol(h.w.mint.publicKey.toBase58())} to the payee.` && row.signature));
  assert.ok(h.updates.some(row => row.text === `Refused 10.000001 ${tokenSymbol(h.w.mint.publicKey.toBase58())}: over per-payment maximum.` && row.signature));
});
test('a 6-decimal USDC rule reports every request in USDC', async () => {
  const usdc = new PublicKey(DEVNET_USDC_MINT);
  const h = harness(5_000_000, { mint: usdc, perTxMax: 100_000n });
  const fake = h.w.fake;
  fake.accounts.set(DEVNET_USDC_MINT, fake.accounts.get(h.w.mint.publicKey.toBase58())!);
  fake.accounts.get(h.w.source.publicKey.toBase58())!.data.set(usdc.toBuffer(), 0);
  for (const row of fake.tokenAccounts) { row.mint = DEVNET_USDC_MINT; row.data.set(usdc.toBuffer(), 0); }
  h.w.connection.getTransaction = async () => {
    const data = Transaction.from(fake.sent.at(-1)!).instructions[0].data;
    const amount = data.readBigUInt64LE(8), nonce = data.readBigUInt64LE(16);
    return { meta: { err: null, logMessages: [amount <= 100_000n ? paidLog(h.w.mandate, amount, nonce, amount) : refusedLog(h.w.mandate, amount, nonce, 5, amount)] } } as unknown as TransactionResponse;
  };
  const plan = await prepareTestRequests(h.options);
  assert.equal(plan.decimals, 6);
  await runTestRequests(h.options, plan);
  assert.deepEqual(h.updates.map(row => row.text), [
    'Sending a request for 0.05 USDC.', 'Request for 0.05 USDC submitted; waiting for confirmation.', 'Paid 0.05 USDC to the payee.',
    'Sending a request for 0.100001 USDC.', 'Request for 0.100001 USDC submitted; waiting for confirmation.', 'Refused 0.100001 USDC: over per-payment maximum.',
  ]);
});
test('a missing mint account stops the test before confirmation', async () => {
  const h = harness();
  h.w.fake.accounts.delete(h.w.mint.publicKey.toBase58());
  await assert.rejects(prepareTestRequests(h.options), /token mint of this rule is unavailable/);
});
test('a plan with different mint decimals is treated as a changed rule', async () => {
  const h = harness();
  const plan = await prepareTestRequests(h.options);
  await runTestRequests(h.options, { ...plan, decimals: 9 });
  assert.equal(h.w.fake.sent.length, 0);
  assert.match(h.updates.at(-1)!.text, /rule changed/);
});
test('an overlapping caller gets a clear message while only the original test spends fees', async () => {
  const h = harness(0);
  let finish!: () => void;
  h.options.signAndSend = async transactions => {
    h.walletTransactions.push(...transactions);
    await new Promise<void>(resolve => { finish = resolve; });
    return ['top-up-signature'];
  };
  const plan = await prepareTestRequests(h.options);
  const pending = runTestRequests(h.options, plan);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.w.fake.sent.length, 0);
  const overlappingUpdates: TestRequestUpdate[] = [];
  await runTestRequests({ ...h.options, report: update => overlappingUpdates.push(update) }, plan);
  assert.equal(h.walletTransactions.length, 1);
  const tx = h.walletTransactions[0];
  assert.equal(tx.instructions.length, 1);
  const transfer = SystemInstruction.decodeTransfer(tx.instructions[0]);
  assert.equal(transfer.lamports, 10_000_000n);
  assert.equal(transfer.fromPubkey.toBase58(), h.w.owner.publicKey.toBase58());
  assert.equal(transfer.toPubkey.toBase58(), h.w.agent.publicKey.toBase58());
  finish();
  await pending;
  assert.equal(h.w.fake.sent.length, 2);
  assert.deepEqual(overlappingUpdates, [{ text: 'A test is already running for this rule.' }]);
  h.w.fake.balances.set(h.w.agent.publicKey.toBase58(), 5_000_000);
  await runTestRequests(h.options, await prepareTestRequests(h.options));
  assert.equal(h.w.fake.sent.length, 4);
});
test('wallet decline is visible and stops both charges', async () => {
  const h = harness(0);
  h.options.signAndSend = async () => { throw new Error('User declined'); };
  await runTestRequests(h.options, await prepareTestRequests(h.options));
  assert.equal(h.w.fake.sent.length, 0);
  assert.match(h.updates.at(-1)!.text, /wallet declined/);
});
test('insufficient owner SOL is visible without a wallet signature', async () => {
  const h = harness(0);
  h.w.fake.balances.set(h.w.owner.publicKey.toBase58(), 10_000_000);
  await runTestRequests(h.options, await prepareTestRequests(h.options));
  assert.equal(h.walletTransactions.length, 0);
  assert.equal(h.w.fake.sent.length, 0);
  assert.match(h.updates.at(-1)!.text, /Not enough SOL/);
});
test('closed rule and RPC cluster mismatch are rejected before spending', async () => {
  const h = harness();
  const plan = await prepareTestRequests(h.options);
  h.w.fake.accounts.delete(h.options.address);
  await runTestRequests(h.options, plan);
  assert.match(h.updates.at(-1)!.text, /no longer available/);
  assert.equal(h.w.fake.sent.length, 0);
  h.w.fake.genesisHash = 'mainnet';
  await assert.rejects(prepareTestRequests(h.options), /devnet/);
});
test('empty cap skips payment but still sends the above-limit request', async () => {
  const h = harness(5_000_000, { spent: 300_000_000n });
  await runTestRequests(h.options, await prepareTestRequests(h.options));
  assert.equal(h.w.fake.sent.length, 1);
  assert.ok(h.updates.some(row => row.text === 'Payment skipped: the remaining cap is zero.'));
});
for (const result of ['null', 'error'] as const) test(`unreadable confirmed payment (${result}) polls for 22 seconds and keeps its receipt`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  let reads = 0;
  h.w.connection.getTransaction = async () => {
    reads++;
    if (result === 'error') throw new Error('RPC failed');
    return null;
  };
  const pending = runTestRequests(h.options, await prepareTestRequests(h.options));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  let expectedReads = 1;
  for (const delay of [1000, 1500, 2000, 2500, 3000, 3000, 3000, 3000, 3000]) {
    t.mock.timers.tick(delay - 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, expectedReads);
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, ++expectedReads);
  }
  await pending;
  assert.equal(reads, 10);
  assert.equal(h.w.fake.sent.length, 1);
  assert.match(h.updates.at(-1)!.text, /first request was sent.*result.*not.*read/i);
  assert.doesNotMatch(h.updates.at(-1)!.text, /may still land/);
  assert.equal(h.updates.at(-1)!.signature, h.updates.find(row => row.signature)!.signature);
});
test('a payment result available on the tenth read still allows the refused request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const getTransaction = h.w.connection.getTransaction.bind(h.w.connection);
  let reads = 0;
  h.w.connection.getTransaction = (async (...args: Parameters<typeof getTransaction>) => ++reads < 10 ? null : getTransaction(...args)) as typeof h.w.connection.getTransaction;
  const pending = runTestRequests(h.options, await prepareTestRequests(h.options));
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(3000);
  }
  await pending;
  assert.equal(h.w.fake.sent.length, 2);
  assert.ok(h.updates.some(row => row.text.startsWith('Paid 5 ')));
  assert.ok(h.updates.some(row => row.text.startsWith('Refused 10.000001 ')));
});
test('agent secret never reaches UI updates or logging even in an RPC error', async () => {
  const h = harness();
  const secret = Buffer.from(h.w.agent.secretKey).toString('base64');
  const logs = [mock.method(console, 'log', () => {}), mock.method(console, 'warn', () => {}), mock.method(console, 'error', () => {})];
  try {
    const plan = await prepareTestRequests(h.options);
    h.w.connection.sendRawTransaction = async () => { throw new Error(secret); };
    await runTestRequests(h.options, plan);
    assert.equal(JSON.stringify(h.updates).includes(secret), false);
    assert.equal(testRequestFailure(new Error(secret)).includes(secret), false);
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
    for (const path of ['./testRequests.ts', '../components/TestRequests.tsx']) {
      assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /secretKey|console\.|Clipboard|Sharing|JSON\.stringify/);
    }
  } finally { for (const log of logs) log.mock.restore(); }
});
test('the above-limit request is still sent when the one-unit payment exhausts the rule', async () => {
  const h = harness(5_000_000, { cap: 1n });
  const getTransaction = h.w.connection.getTransaction.bind(h.w.connection);
  h.w.connection.getTransaction = (async (...args: Parameters<typeof getTransaction>) => {
    const tx = await getTransaction(...args);
    const data = h.w.fake.accounts.get(h.options.address)!.data;
    data.writeBigUInt64LE(1n, 184); // spent
    data[236 + data.readUInt32LE(232)] = 2; // exhausted after the payment
    return tx;
  }) as typeof h.w.connection.getTransaction;
  await runTestRequests(h.options, await prepareTestRequests(h.options));
  assert.equal(h.w.fake.sent.length, 2);
  assert.ok(h.updates.some(row => row.text.startsWith('Paid 0.000001 ')));
  assert.ok(h.updates.some(row => row.text.startsWith('Refused 10.000001 ')));
});


test('a waiting one-time approval prevents confirmation and any fee transfer', async () => {
  const h = harness(0, { overrideAmount: 50n, overrideNonce: 30n, lastNonce: 12n });
  await assert.rejects(prepareTestRequests(h.options), /waiting one-time approval.*test would cancel it/);
  assert.equal(h.walletTransactions.length, 0);
  assert.equal(h.w.fake.sent.length, 0);
});
test('an approval added after confirmation stops the test before sending anything', async () => {
  const h = harness(0);
  const plan = await prepareTestRequests(h.options);
  const data = h.w.fake.accounts.get(h.options.address)!.data;
  data.writeBigUInt64LE(50n, 208);
  data.writeBigUInt64LE(30n, 216);
  await runTestRequests(h.options, plan);
  assert.equal(h.walletTransactions.length, 0);
  assert.equal(h.w.fake.sent.length, 0);
  assert.match(h.updates.at(-1)!.text, /waiting one-time approval.*test would cancel it/);
});
test('an approval added after payment stops the oversized request', async () => {
  const h = harness();
  const getTransaction = h.w.connection.getTransaction.bind(h.w.connection);
  h.w.connection.getTransaction = (async (...args: Parameters<typeof getTransaction>) => {
    const tx = await getTransaction(...args);
    const data = h.w.fake.accounts.get(h.options.address)!.data;
    data.writeBigUInt64LE(50n, 208);
    data.writeBigUInt64LE(30n, 216);
    return tx;
  }) as typeof h.w.connection.getTransaction;
  await runTestRequests(h.options, await prepareTestRequests(h.options));
  assert.equal(h.w.fake.sent.length, 1);
  assert.match(h.updates.at(-1)!.text, /waiting one-time approval.*test would cancel it/);
});
test('zero-amount and already-consumed approvals do not block test requests', async () => {
  for (const patch of [{ overrideAmount: 0n, overrideNonce: 30n }, { overrideAmount: 50n, overrideNonce: 12n, lastNonce: 12n }]) {
    const h = harness(5_000_000, patch);
    await runTestRequests(h.options, await prepareTestRequests(h.options));
    assert.equal(h.w.fake.sent.length, 2);
  }
});
