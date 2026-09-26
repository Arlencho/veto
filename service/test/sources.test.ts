import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import idl from '../../indexer/idl/veto.json' with { type: 'json' };
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { useOwnDatabase } from './db.js';
await useOwnDatabase('veto_sources_test');
const { pool, transaction } = await import('../src/db/transaction.js');
const { migrate } = await import('../src/db/migrate.js');
const { createWebhookServer } = await import('../src/sources/webhook.js');
const { backfill, finalize } = await import('../src/sources/backfill.js');
const { createRpc, ingestTransaction } = await import('../src/sources/shared.js');
const { decodeTransaction } = await import('../src/decode/index.js');
const { insertDecision } = await import('../src/ingest.js');
const { ingestLocation } = await import('../src/boundary.js');
import type { RpcTransaction } from '../src/decode/index.js';
const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/devnet/${name}.json`, import.meta.url), 'utf8'));
const signatures = read('manifest').signatures as { signature: string; slot: number }[];
const fixtures = signatures.map(s => read(s.signature) as RpcTransaction);
const accounts = read('accounts').value as { pubkey: string; account: unknown }[];
let fetched: string[] = [];
let watermark = 0;
const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  if (method === 'getSignaturesForAddress') {
    const options = params[1] as { before?: string; until?: string };
    const start = options.before ? signatures.findIndex(s => s.signature === options.before) + 1 : 0;
    const end = options.until ? signatures.findIndex(s => s.signature === options.until) : signatures.length;
    return signatures.slice(start, Math.min(start + 17, end)) as T;
  }
  if (method === 'getTransaction') { fetched.push(String(params[0])); return read(String(params[0])) as T; }
  if (method === 'getAccountInfo') return { value: accounts.find(a => a.pubkey === params[0])?.account ?? null } as T;
  if (method === 'getSlot') return watermark as T;
  if (method === 'getSignatureStatuses') return { value: (params[0] as string[]).map(signature => {
    const slot = signatures.find(s => s.signature === signature)!.slot;
    return { slot, err: null, confirmationStatus: slot <= watermark ? 'finalized' : 'confirmed' };
  }) } as T;
  throw new Error(`Unexpected method ${method}`);
};
before(() => migrate());
beforeEach(async () => { fetched = []; await pool.query('TRUNCATE decisions, decision_keys, deltas, rules, rule_stats, agent_stats, cursors CASCADE'); });
after(() => pool.end());
async function snapshot(ignoreUpdateTime = false) {
  const result: Record<string, unknown> = {};
  for (const table of ['decisions', 'decision_keys', 'deltas', 'rule_stats', 'agent_stats']) {
    result[table] = (await pool.query(`SELECT * FROM ${table}`)).rows.map(row => {
      if (ignoreUpdateTime) delete row.updated_at;
      return row;
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
test('webhook rejects bad auth and duplicate batches leave rows and counters unchanged', async () => {
  const server = createWebhookServer({ auth: 'shared-secret', rpc });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const send = (auth: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}`, {
      method: 'POST', headers: { authorization: auth }, body: JSON.stringify(body),
    });
    assert.equal((await send('bad', fixtures)).status, 401);
    assert.equal((await pool.query('SELECT * FROM decisions')).rowCount, 0);
    const batch = fixtures;
    assert.equal((await send('shared-secret', batch)).status, 200);
    const once = await snapshot();
    assert.equal((await send('shared-secret', batch)).status, 200);
    assert.deepEqual(await snapshot(), once);
    assert.equal((await send('shared-secret', signatures.map(s => ({ ...s, timestamp: 1 })))).status, 200);
    assert.deepEqual(await snapshot(), once);
    assert.deepEqual((await pool.query('SELECT DISTINCT commitment FROM decisions')).rows, [{ commitment: 'confirmed' }]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('backfill pages all fixtures and matches independently constructed ingest rows', async () => {
  await backfill(rpc);
  assert.equal(fetched.length, fixtures.length);
  const actual = await snapshot(true);
  const cursor = (await pool.query("SELECT * FROM cursors WHERE source = 'backfill'")).rows[0];
  assert.equal(cursor.last_signature, signatures[0].signature);
  await backfill(rpc);
  assert.equal(fetched.length, fixtures.length);
  assert.deepEqual(await snapshot(true), actual);
  await pool.query('TRUNCATE decisions, decision_keys, deltas, rule_stats, agent_stats CASCADE');
  const identities = new Map<string, { owner: string; agent: string }>();
  for (const fixture of fixtures.slice().reverse()) for (const record of decodeTransaction(fixture)) {
    if (record.kind === 'open_mandate') identities.set(record.mandate, { owner: record.owner, agent: record.agent });
    const identity = identities.get(record.mandate)!;
    const charge = record.kind === 'paid' || record.kind === 'refused' || record.kind === 'traded';
    await transaction(tx => insertDecision(tx, {
      ...ingestLocation(record), ...identity, rule: record.mandate, program_version: 1, rule_kind: 'mandate',
      kind: { open_mandate: 0, paid: 1, refused: 2, grant_override: 3, revoke_mandate: 4, close_mandate: 5, traded: 6 }[record.kind],
      reason: charge ? record.reason : 0, amount: 'amount' in record ? String(record.amount) : '0',
      nonce: 'nonce' in record ? String(record.nonce) : '0', counterparty: charge ? record.counterparty : record.kind === 'open_mandate' ? record.merchant : identity.owner,
      suggested_override: charge ? String(record.suggestedOverride) : null, source: 'backfill', commitment: 'confirmed',
    }));
  }
  assert.deepEqual(await snapshot(true), actual);
});
test('finalizer only promotes successful finalized signatures at their stored slots', async () => {
  await backfill(rpc);
  watermark = signatures[Math.floor(signatures.length / 2)].slot;
  await finalize(rpc);
  const rows = (await pool.query('SELECT slot, commitment FROM decisions')).rows;
  assert.ok(rows.some(r => r.commitment === 'finalized'));
  assert.ok(rows.some(r => r.commitment === 'confirmed'));
  for (const row of rows) assert.equal(row.commitment, BigInt(row.slot) <= BigInt(watermark) ? 'finalized' : 'confirmed');
  const once = await snapshot();
  await finalize(rpc);
  assert.deepEqual(await snapshot(), once);
});
test('an unavailable transaction leaves the cursor unchanged and a retry repairs history', async () => {
  let remaining = 20;
  await assert.rejects(backfill(async (method, params) => {
    if (method === 'getTransaction' && --remaining === 0) throw new Error('unavailable');
    return rpc(method, params);
  }));
  assert.equal((await pool.query('SELECT * FROM cursors')).rowCount, 0);
  await backfill(rpc);
  assert.equal((await pool.query('SELECT last_signature FROM cursors')).rows[0].last_signature, signatures[0].signature);
});
test('RPC retries null transactions and transport failures without exposing credentials', async () => {
  const delays: number[] = [];
  let attempts = 0;
  const client = createRpc({ endpoint: 'https://example.invalid/?api-key=secret', sleep: async ms => { delays.push(ms); }, fetch: async () => {
    attempts++;
    if (attempts === 1) throw new Error('https://example.invalid/?api-key=secret');
    return new Response(JSON.stringify({ result: attempts === 2 ? null : fixtures[0] }));
  } });
  assert.deepEqual(await client('getTransaction', ['signature']), fixtures[0]);
  assert.deepEqual(delays, [250, 500]);
  const failing = createRpc({ sleep: async () => {}, fetch: async () => { throw new Error('?api-key=secret'); } });
  await assert.rejects(failing('getSlot', []), error => error instanceof Error && !error.message.includes('secret'));
});
test('finalizer leaves missing, failed and relocated signatures confirmed', async () => {
  await backfill(rpc);
  watermark = Math.max(...signatures.map(s => s.slot));
  const selected = (await pool.query('SELECT DISTINCT signature FROM decisions ORDER BY signature LIMIT 3')).rows.map(r => r.signature);
  await finalize(async <T>(method: string, params: unknown[]): Promise<T> => {
    const result = await rpc<T>(method, params);
    if (method !== 'getSignatureStatuses') return result;
    const statuses = result as { value: ({ slot: number; err: unknown; confirmationStatus: string } | null)[] };
    for (const [index, signature] of (params[0] as string[]).entries()) {
      if (signature === selected[0]) statuses.value[index] = null;
      if (signature === selected[1]) statuses.value[index]!.err = { InstructionError: [0, 'failed'] };
      if (signature === selected[2]) statuses.value[index]!.slot--;
    }
    return result;
  });
  const rows = (await pool.query('SELECT DISTINCT signature, commitment FROM decisions WHERE signature=ANY($1)', [selected])).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.commitment === 'confirmed'));
});
test('webhook requires configuration and rejects malformed or oversized bodies', async () => {
  assert.throws(() => createWebhookServer({ auth: '' }));
  const server = createWebhookServer({ auth: 'secret', rpc });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { authorization: 'secret' } })).status, 405);
    for (const body of ['{', '{}', '[null]']) {
      assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'secret' }, body })).status, 400);
    }
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'secret' }, body: ' '.repeat(8 * 1024 * 1024 + 1) })).status, 413);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const [instruction, event, kind] of [
  ['migrate_hold_vault', 'HoldMigrated', 14],
  ['close_hold_vault', 'HoldClosed', 15],
] as const) {
  test(`${event} persists exact history without live accounts and deduplicates both sources`, async () => {
    const program = '3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV';
    const owner = bs58.encode(Buffer.alloc(32, 21));
    const vault = bs58.encode(Buffer.alloc(32, 22));
    const destination = instruction === 'migrate_hold_vault' ? vault : bs58.encode(Buffer.alloc(32, 23));
    const layout = idl.instructions.find(ix => ix.name === instruction)!;
    const accountKeys = [program, ...layout.accounts.map(a => a.name === 'owner' ? owner : a.name === 'vault' ? vault : destination)];
    const raw = Buffer.alloc(112);
    createHash('sha256').update(`event:${event}`).digest().copy(raw, 0, 0, 8);
    Buffer.from(bs58.decode(vault)).copy(raw, 8);
    Buffer.from(bs58.decode(owner)).copy(raw, 40);
    raw.writeBigUInt64LE(9007199254740993n, 72);
    Buffer.from(bs58.decode(destination)).copy(raw, 80);
    const tx: RpcTransaction = {
      slot: 123, blockTime: 1780000000,
      transaction: { signatures: [event], message: { accountKeys, instructions: [{
        programIdIndex: 0, accounts: layout.accounts.map((_, i) => i + 1), data: bs58.encode(Buffer.from(layout.discriminator)),
      }] } },
      meta: { err: null, logMessages: [`Program ${program} invoke [1]`, `Program data: ${raw.toString('base64')}`, `Program ${program} success`] },
    };
    const noRpc = async <T>(): Promise<T> => { throw new Error('History must not require live accounts'); };
    assert.equal(await ingestTransaction(tx, 'webhook', noRpc), 1);
    assert.deepEqual((await pool.query('SELECT rule_kind, rule, owner, agent, kind, amount, counterparty, instruction_index, inner_index FROM decisions')).rows, [{
      rule_kind: 'hold', rule: vault, owner, agent: owner, kind, amount: '9007199254740993', counterparty: destination, instruction_index: 0, inner_index: -1,
    }]);
    assert.equal(await ingestTransaction(tx, 'backfill', noRpc), 0);
    assert.deepEqual((await pool.query('SELECT requests, paid, outside FROM rule_stats')).rows, [{ requests: '0', paid: '0', outside: '0' }]);
    const missing = structuredClone(tx); missing.meta!.logMessages = [];
    assert.throws(() => decodeTransaction(missing), /Malformed or incomplete/);
    const failed = structuredClone(tx); failed.meta!.err = 'failed';
    assert.equal(await ingestTransaction(failed, 'webhook', noRpc), 0);
  });
}
