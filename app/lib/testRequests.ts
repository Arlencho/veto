import { Buffer } from 'buffer';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { payeeLookup, readPayeeTokenAccount } from './agentConnect';
import { CHARGE_IX_DISC, KIND_PAID, KIND_REFUSED, STATUS_EXHAUSTED, writeU64Le, reasonText } from './constants';
import { decodeEventsFromLogs } from './events';
import { decodeMandateAccount, isActive, type MandateAccount } from './mandate';
import { ledgerPda } from './ring';

const U64_MAX = 0xffffffffffffffffn;
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export function testRequestsVisible(rule: MandateAccount | null, agent: string | null, cluster: string | null, now: bigint): boolean {
  return cluster === 'devnet' && rule !== null && !('inMint' in rule) && rule.agent === agent && isActive(rule, now);
}
export function testRequestAmounts(rule: Pick<MandateAccount, 'cap' | 'spent' | 'perTxMax'>) {
  if (rule.perTxMax < 1n || rule.perTxMax >= U64_MAX) throw new Error('This limit cannot be tested with two requests.');
  const remaining = rule.cap > rule.spent ? rule.cap - rule.spent : 0n;
  const half = (remaining < rule.perTxMax ? remaining : rule.perTxMax) / 2n;
  return { paid: remaining === 0n ? null : half > 0n ? half : 1n, refused: rule.perTxMax + 1n };
}
function nextTestNonce(last: bigint, override: bigint): bigint {
  const start = last > override ? last : override;
  if (start >= U64_MAX) throw new Error('This rule has no room for another request nonce.');
  return start + 1n;
}
export function testRequestNonces(last: bigint, override: bigint): [bigint, bigint] {
  // Never consume a pending owner override with the deliberately oversized request.
  const start = last > override ? last : override;
  if (start > U64_MAX - 2n) throw new Error('This rule has no room for two more request nonces.');
  return [start + 1n, start + 2n];
}
export const needsTestFeeTopUp = (lamports: number): boolean => lamports < 5_000_000;

export async function testChargeInstruction(connection: Connection, programId: PublicKey, rule: MandateAccount, amount: bigint, nonce: bigint) {
  const source = new PublicKey(rule.source);
  const info = await connection.getAccountInfo(source, 'confirmed');
  if (!info) throw new Error('The payment account is no longer available.');
  const destination = await readPayeeTokenAccount(payeeLookup(connection), new PublicKey(rule.merchant), new PublicKey(rule.mint), info.owner);
  const mandate = new PublicKey(rule.address);
  const data = Buffer.alloc(24);
  CHARGE_IX_DISC.copy(data);
  writeU64Le(data, 8, amount);
  writeU64Le(data, 16, nonce);
  return new TransactionInstruction({ programId, data, keys: [
    { pubkey: new PublicKey(rule.agent), isSigner: true, isWritable: false },
    { pubkey: mandate, isSigner: false, isWritable: true },
    { pubkey: ledgerPda(programId, mandate), isSigner: false, isWritable: true },
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(rule.mint), isSigner: false, isWritable: false },
    { pubkey: info.owner, isSigner: false, isWritable: false },
  ] });
}

export type TestRequestUpdate = { text: string; signature?: string };
export type TestRequestPlan = { rule: MandateAccount; paid: bigint | null; refused: bigint };
export type TestRequestOptions = {
  connection: Connection; programId: PublicKey; cluster: string; address: string; owner: string;
  getAgentKeypair: () => Promise<Keypair | null>;
  signAndSend: (transactions: Transaction[]) => Promise<string[]>;
  report: (update: TestRequestUpdate) => void;
};

async function liveRule(options: TestRequestOptions, allowExhausted = false): Promise<MandateAccount> {
  if (options.cluster !== 'devnet' || await options.connection.getGenesisHash() !== DEVNET_GENESIS) {
    throw new Error('Test requests are only available on devnet.');
  }
  const info = await options.connection.getAccountInfo(new PublicKey(options.address), 'confirmed');
  if (!info || !info.owner.equals(options.programId)) throw new Error('The rule is closed or unavailable. Refresh your rules.');
  const rule = decodeMandateAccount(options.address, info.data);
  const agent = await options.getAgentKeypair();
  if (!testRequestsVisible(allowExhausted && rule.status === STATUS_EXHAUSTED ? { ...rule, status: 0 } : rule, agent?.publicKey.toBase58() ?? null, options.cluster, BigInt(Math.floor(Date.now() / 1000))) || rule.owner !== options.owner) {
    throw new Error('This rule is no longer active for the owner and test agent on this phone.');
  }
  return rule;
}

export async function prepareTestRequests(options: TestRequestOptions): Promise<TestRequestPlan> {
  const rule = await liveRule(options);
  testRequestNonces(rule.lastNonce, rule.overrideNonce);
  return { rule, ...testRequestAmounts(rule) };
}

/** Errors crossing the device/UI boundary use fixed text, never RPC or key-store payloads. */
export function testRequestFailure(error: unknown): string {
  const text = error instanceof Error ? error.message.toLowerCase() : '';
  if (text === 'wallet fee transfer declined') return 'The wallet declined the fee transfer. No test requests were sent.';
  if (/insufficient|not enough/.test(text)) return 'Not enough SOL for fees. Fund the owner with devnet SOL and try again.';
  if (/(rule|payment account|agent).*(closed|no longer|unavailable|active)/.test(text)) return 'The rule or payment account is no longer available for this test. Refresh your rules.';
  if (/devnet/.test(text)) return 'Test requests are only available on devnet.';
  if (/changed/.test(text)) return 'The rule changed. Review the amounts again before sending.';
  return 'The test could not finish. Check the outcomes and explorer links below, then refresh Decisions before retrying. A submitted transaction may still land.';
}

// Shared by both screen instances; an overlapping run must not spend twice.
const running = new Set<string>();
export async function runTestRequests(options: TestRequestOptions, plan: TestRequestPlan): Promise<void> {
  if (running.has(options.address)) return;
  running.add(options.address);
  const { connection, report } = options;
  try {
    const current = await prepareTestRequests(options);
    if (current.paid !== plan.paid || current.refused !== plan.refused || current.rule.merchant !== plan.rule.merchant || current.rule.mint !== plan.rule.mint || current.rule.agent !== plan.rule.agent) throw new Error('The rule changed.');
    const agent = await options.getAgentKeypair();
    if (!agent || agent.publicKey.toBase58() !== current.rule.agent) throw new Error('Agent no longer available.');
    if (needsTestFeeTopUp(await connection.getBalance(agent.publicKey, 'confirmed'))) {
      report({ text: 'Waiting for the wallet to send 0.01 devnet SOL to the test agent for fees.' });
      const owner = new PublicKey(options.owner);
      const block = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({ ...block, feePayer: owner }).add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent.publicKey, lamports: 10_000_000 }));
      const fee = await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed');
      if (fee.value === null) throw new Error('RPC fee unavailable');
      if (await connection.getBalance(owner, 'confirmed') < 10_000_000 + fee.value) throw new Error('Insufficient owner SOL');
      let signatures: string[];
      try {
        signatures = await options.signAndSend([transaction]); // MWA waits for confirmation.
      } catch (error) {
        if (error instanceof Error && /cancel|declin|reject/i.test(error.message)) {
          throw new Error('Wallet fee transfer declined');
        }
        throw error;
      }
      report({ text: 'Sent 0.01 devnet SOL to the test agent for fees.', signature: signatures[0] });
    }
    let previous = current.rule.lastNonce;
    if (plan.paid === null) report({ text: 'Payment skipped: the remaining cap is zero.' });
    for (const amount of [plan.paid, plan.refused]) {
      if (amount === null) continue;
      const rule = await liveRule(options, amount === plan.refused);
      if (rule.agent !== agent.publicKey.toBase58()) throw new Error('Agent no longer available.');
      // Re-read after each confirmed request; also remain above our previous nonce.
      const nonce = nextTestNonce(rule.lastNonce > previous ? rule.lastNonce : previous, rule.overrideNonce);
      const instruction = await testChargeInstruction(connection, options.programId, rule, amount, nonce);
      const block = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({ ...block, feePayer: agent.publicKey }).add(instruction);
      transaction.sign(agent);
      report({ text: `Sending request for ${amount} base units.` });
      const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
      report({ text: `Request for ${amount} base units submitted; waiting for confirmation.`, signature });
      const confirmation = await connection.confirmTransaction({ ...block, signature }, 'confirmed');
      if (confirmation.value.err) throw new Error('Transaction failed');
      const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err) throw new Error('Decision not yet available');
      const decisions = decodeEventsFromLogs(signature, tx.meta?.logMessages ?? []).filter(row => row.amount === amount && row.nonce === nonce && (row.kind === KIND_PAID || row.kind === KIND_REFUSED));
      if (decisions.length !== 1) throw new Error('Decision not yet available');
      const decision = decisions[0];
      report({ text: decision.kind === KIND_PAID ? `Paid ${amount} base units to the payee.` : `Refused ${amount} base units: ${reasonText(decision.reason)}.`, signature });
      previous = nonce;
    }
  } catch (error) {
    report({ text: testRequestFailure(error) });
  } finally {
    running.delete(options.address);
  }
}
