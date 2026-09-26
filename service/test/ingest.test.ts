import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { pool, transaction } from '../src/db/transaction.js';
import { insertDecision, reverseDecision, type Decision } from '../src/ingest.js';

const row: Decision = {
  signature: 'payment', slot: '20', block_time: '2026-09-01T00:00:00Z',
  instruction_index: 0, inner_index: -1, program_version: 1, rule_kind: 'mandate',
  rule: 'rule', agent: 'agent', owner: 'owner', kind: 1, reason: 0,
  amount: '18446744073709551615', nonce: '1', counterparty: 'merchant',
  suggested_override: null, commitment: 'confirmed', source: 'grpc',
};
before(async () => { await migrate(); await migrate(); });
beforeEach(async () => { await pool.query('TRUNCATE decisions, decision_keys, deltas, rule_stats, agent_stats CASCADE'); });
after(() => pool.end());
async function stats() {
  return (await pool.query('SELECT requests, paid, outside, allowances, declines, first_open_ts, last_ts, last_slot FROM rule_stats WHERE rule = $1', ['rule'])).rows[0];
}
async function add(value: Decision) { return transaction(tx => insertDecision(tx, value)); }

test('duplicate insert changes counters once across sources and months', async () => {
  assert.equal(await add(row), true);
  const once = await stats();
  assert.equal(await add({ ...row, source: 'webhook', block_time: '2026-10-01T00:00:00Z' }), false);
  assert.deepEqual(await stats(), once);
  assert.equal(once.paid, '1');
  assert.equal((await pool.query('SELECT * FROM deltas')).rowCount, 1);
  assert.equal((await pool.query('SELECT amount FROM decisions')).rows[0].amount, row.amount);
  assert.equal((await pool.query('SELECT paid FROM agent_stats')).rows[0].paid, '1');
});
test('reverse restores counters and timestamps exactly with other history present', async () => {
  await add({ ...row, signature: 'open', kind: 0, slot: '1', block_time: '2026-08-01T00:00:00Z' });
  const original = await stats();
  await add(row);
  assert.equal(await reverseDecision(row), true);
  assert.deepEqual(await stats(), original);
  assert.equal(await reverseDecision(row), false);
});
test('late allowances and refusals reclassify their nonce and reverse in any order', async () => {
  const allowance = { ...row, signature: 'allow', kind: 3 };
  const refusal = { ...row, signature: 'refuse', kind: 2 };
  await add(row);
  await add(allowance);
  assert.equal((await stats()).paid, '0');
  assert.equal((await stats()).outside, '1');
  await add(refusal);
  assert.equal((await stats()).outside, '1');
  await reverseDecision(allowance);
  assert.equal((await stats()).paid, '1');
  assert.equal((await stats()).outside, '1');
  await reverseDecision(refusal);
  assert.equal((await stats()).outside, '0');
  await reverseDecision(row);
  assert.equal((await stats()).requests, '0');
  assert.equal((await pool.query('SELECT * FROM deltas')).rowCount, 0);
});
test('caller rollback leaves no decision, delta or counters', async () => {
  await assert.rejects(transaction(async tx => { await insertDecision(tx, row); throw new Error('abort'); }));
  for (const table of ['decisions', 'decision_keys', 'deltas', 'rule_stats', 'agent_stats']) {
    assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
  }
});
test('concurrent duplicate delivery commits one contribution', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => add(row)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await stats()).requests, '1');
});
test('decisions are stored in distinct monthly partitions', async () => {
  await add(row);
  await add({ ...row, signature: 'october', block_time: '2026-10-01T00:00:00Z' });
  const names = (await pool.query('SELECT DISTINCT tableoid::regclass::text AS name FROM decisions')).rows.map(r => r.name).sort();
  assert.deepEqual(names, ['decisions_2026_09', 'decisions_2026_10']);
});

test('every delivery order and reverse order matches app nonce accounting', async () => {
  const { gradeRules } = await import(new URL('../../app/lib/grade.ts', import.meta.url).href);
  function permutations<T>(items: T[]): T[][] {
    return items.length === 0 ? [[]] : items.flatMap((item, i) =>
      permutations(items.filter((_, j) => i !== j)).map(rest => [item, ...rest]));
  }
  const events = [row, { ...row, signature: 'allow1', kind: 3 },
    { ...row, signature: 'allow2', kind: 3 }, { ...row, signature: 'refuse', kind: 2 }];
  for (const order of permutations(events)) {
    const present = new Map<string, Decision>();
    async function check() {
      const expected = gradeRules([{ rows: [...present.values()].map(d => ({
        kind: d.kind, nonce: BigInt(d.nonce), amount: BigInt(d.amount),
        ts: BigInt(new Date(d.block_time).getTime() / 1000), reason: d.reason, counterparty: d.counterparty,
      })) }], 1_900_000_000n);
      for (const table of ['rule_stats', 'agent_stats']) {
        const actual = (await pool.query(`SELECT * FROM ${table}`)).rows[0];
        for (const counter of ['requests', 'paid', 'outside', 'allowances', 'declines']) {
          assert.equal(actual[counter], String(expected[counter]), `${table}.${counter}, order=${order.map(d => d.signature)}`);
        }
      }
    }
    for (const event of order) { await add(event); present.set(event.signature, event); await check(); }
    // Remove in insertion order, so every event can disappear before its siblings.
    for (const event of order) { await reverseDecision(event); present.delete(event.signature); await check(); }
  }
});
test('reverse transaction rollback preserves decisions, deltas and counters', async () => {
  await add(row);
  const original = await stats();
  await assert.rejects(transaction(async tx => { await reverseDecision(tx, row); throw new Error('abort'); }));
  assert.deepEqual(await stats(), original);
  assert.equal((await pool.query('SELECT * FROM decisions')).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM deltas')).rowCount, 1);
});
test('instruction and inner instruction indexes distinguish decisions', async () => {
  await add(row);
  await add({ ...row, instruction_index: 1 });
  await add({ ...row, inner_index: 0 });
  assert.equal((await stats()).paid, '3');
  await reverseDecision({ ...row, inner_index: 0 });
  assert.equal((await stats()).paid, '2');
});

test('Hold history cannot change an existing agent record during ingestion or reversal', async () => {
  await add(row);
  const agentStats = async () => (await pool.query('SELECT requests, paid, outside, allowances, declines, first_open_ts, first_ts, last_ts, last_slot FROM agent_stats WHERE agent = $1', [row.agent])).rows[0];
  const original = await agentStats();
  const hold: Decision = { ...row, signature: 'hold', rule_kind: 'hold', rule: 'vault', owner: row.agent,
    kind: 14, slot: '1', block_time: '2026-08-01T00:00:00Z' };
  await add(hold);
  assert.deepEqual(await agentStats(), original);
  await reverseDecision(hold);
  assert.deepEqual(await agentStats(), original);
});

test('agent extrema rescans ignore surviving Hold history', async () => {
  const hold: Decision = { ...row, signature: 'hold', rule_kind: 'hold', rule: 'vault', owner: row.agent,
    kind: 14, slot: '1', block_time: '2026-08-01T00:00:00Z' };
  await add(hold);
  await add(row);
  await reverseDecision(row);
  const stats = (await pool.query('SELECT first_ts, last_ts, last_slot, requests FROM agent_stats WHERE agent = $1', [row.agent])).rows[0];
  assert.deepEqual(stats, { first_ts: null, last_ts: null, last_slot: null, requests: '0' });
});
