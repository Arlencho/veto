import { setTimeout as delay } from 'node:timers/promises';
import { PublicKey } from '@solana/web3.js';
import idl from '../../../indexer/idl/veto.json' with { type: 'json' };
import { decodeTransaction, PROGRAM_ID, type RpcTransaction } from '../decode/index.js';
import { ingestLocation } from '../boundary.js';
import { transaction, type Tx } from '../db/transaction.js';
import { insertDecision, type Decision } from '../ingest.js';

export type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
export function createRpc(options: { endpoint?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<unknown> } = {}): Rpc {
  const endpoint = options.endpoint ?? process.env.VETO_RPC ?? 'https://api.devnet.solana.com';
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const response = await (options.fetch ?? fetch)(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) {
          const body = await response.json() as { result?: T; error?: unknown };
          if (!body.error && body.result !== undefined && !(method === 'getTransaction' && body.result === null)) return body.result;
        }
      } catch { /* Transport errors and RPC bodies can contain credentials. Never expose them. */ }
      if (attempt < 5) await (options.sleep ?? delay)(250 * 2 ** attempt);
    }
    throw new Error('RPC request failed after 6 attempts');
  };
}
export async function fetchTransaction(rpc: Rpc, signature: string): Promise<RpcTransaction> {
  const tx = await rpc<RpcTransaction | null>('getTransaction', [signature, {
    commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0,
  }]);
  if (!tx || tx.transaction.signatures[0] !== signature) throw new Error('Transaction unavailable or signature mismatch');
  return tx;
}

/** Both sources use this adapter and the same atomic, idempotent ingest writer. */
export async function ingestTransaction(raw: RpcTransaction, source: 'webhook' | 'backfill', rpc: Rpc): Promise<number> {
  if (!Number.isSafeInteger(raw.slot) || raw.slot < 0 || !raw.meta) throw new Error('Incomplete transaction');
  const records = decodeTransaction(raw);
  if (!records.length) return 0;
  const slotTime = raw.blockTime ?? await rpc<number | null>('getBlockTime', [raw.slot]);
  return transaction(async tx => {
    let count = 0;
    for (const record of records) {
      const location = ingestLocation(record, slotTime);
      // Do not require account history again for a duplicate, including closed accounts.
      if ((await tx.query('SELECT 1 FROM decision_keys WHERE signature=$1 AND instruction_index=$2 AND inner_index=$3',
        [location.signature, location.instruction_index, location.inner_index])).rowCount) continue;
      const hold = record.kind === 'hold_migrated' || record.kind === 'hold_closed';
      // Hold has no agent. Attribute lifecycle history to its owner without
      // fetching a vault that may already have been closed.
      const identity = hold ? { owner: record.owner, agent: record.owner }
        : record.kind === 'open_mandate' ? record : await ruleIdentity(tx, record.mandate, rpc);
      const charge = record.kind === 'paid' || record.kind === 'refused' || record.kind === 'traded';
      const row: Decision = {
        ...location, owner: identity.owner, agent: identity.agent, rule: record.mandate, rule_kind: hold ? 'hold' : 'mandate', program_version: 1,
        kind: { open_mandate: 0, paid: 1, refused: 2, grant_override: 3, revoke_mandate: 4, close_mandate: 5, traded: 6, hold_migrated: 14, hold_closed: 15 }[record.kind],
        reason: charge ? record.reason : 0, amount: 'amount' in record ? String(record.amount) : '0',
        nonce: 'nonce' in record ? String(record.nonce) : '0',
        counterparty: hold ? record.destination : charge ? record.counterparty : record.kind === 'open_mandate' ? record.merchant : identity.owner,
        suggested_override: charge ? String(record.suggestedOverride) : null, commitment: 'confirmed', source,
      };
      if (await insertDecision(tx, row)) count++;
    }
    return count;
  });
}
async function ruleIdentity(tx: Tx, rule: string, rpc: Rpc): Promise<{ owner: string; agent: string }> {
  const known = (await tx.query('SELECT owner, agent FROM decisions WHERE rule=$1 LIMIT 1', [rule])).rows[0]
    ?? (await tx.query('SELECT owner, agent FROM rules WHERE rule=$1', [rule])).rows[0];
  if (known) return known;
  const { value } = await rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [rule, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!value || value.owner !== PROGRAM_ID || value.data[1] !== 'base64') throw new Error('Mandate identity unavailable; backfill its opening transaction first');
  const data = Buffer.from(value.data[0], 'base64');
  const discriminator = Buffer.from(idl.accounts.find(a => a.name === 'Mandate')!.discriminator);
  if (data.length < 72 || !data.subarray(0, 8).equals(discriminator)) throw new Error('Invalid mandate account');
  return { owner: new PublicKey(data.subarray(8, 40)).toBase58(), agent: new PublicKey(data.subarray(40, 72)).toBase58() };
}
