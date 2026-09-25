import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import bs58 from 'bs58';
import { useOwnDatabase } from './db.js';
import { decodeTransaction, type OpenMandate } from '../src/decode/index.js';
import { ingestLocation } from '../src/boundary.js';
import { grade } from '../src/grade.js';

await useOwnDatabase('veto_api_test');
const { pool, transaction } = await import('../src/db/transaction.js');
const { migrate } = await import('../src/db/migrate.js');
const { insertDecision } = await import('../src/ingest.js');
const { createApiServer } = await import('../src/api/index.js');
const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/devnet/${name}`, import.meta.url), 'utf8'));
const records = read('manifest.json').signatures.flatMap(({ signature }: { signature: string }) => decodeTransaction(read(`${signature}.json`)));
const opens = new Map<string, OpenMandate>(records.filter((r): r is OpenMandate => r.kind === 'open_mandate').map(r => [r.mandate, r]));
const selected = [...opens.values()].find(o => records.filter(r => r.mandate === o.mandate).length > 5)!;
let url: string;
let rpcMode = 'ok';
const rpc = createServer(async (req, res) => {
  let text = ''; for await (const part of req) text += part;
  const call = JSON.parse(text);
  assert.equal(req.url, '/?api-key=private-test-key');
  const result = rpcMode === 'missing-time' && call.method === 'getBlockTime' ? null : call.method === 'getSlot' ? 999999999 : call.params[0] === 999999999 ? 1800000000 : 1799999990;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(rpcMode !== 'error' ? { jsonrpc: '2.0', id: call.id, result } : { error: { message: 'private-test-key' } }));
});
const api = createApiServer();
async function get(path: string) {
  const response = await fetch(url + path);
  return { response, body: await response.json() as any };
}
before(async () => {
  await migrate();
  await pool.query('TRUNCATE decisions, decision_keys, deltas, rule_stats, agent_stats, rules, cursors CASCADE');
  for (const o of opens.values()) {
    await pool.query(`INSERT INTO rules (rule, owner, agent, mint, source, merchant, cap, per_tx_max, expires_at, status, opened_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10)`,
    [o.mandate, o.owner, o.agent, o.mint, o.source, o.merchant, String(o.cap), String(o.per_tx_max), new Date(Number(o.expires_at) * 1000), new Date(o.timestamp! * 1000)]);
  }
  for (const r of records) {
    const o = opens.get(r.mandate);
    if (!o || r.kind === 'close_mandate') continue;
    await transaction(tx => insertDecision(tx, {
      ...ingestLocation(r), program_version: 1, rule_kind: 'mandate', rule: r.mandate,
      owner: o.owner, agent: o.agent, kind: ['open_mandate', 'paid', 'refused', 'grant_override', 'revoke_mandate'].indexOf(r.kind),
      reason: 'reason' in r ? r.reason : 0, amount: 'amount' in r ? String(r.amount) : '0',
      nonce: 'nonce' in r ? String(r.nonce) : '0', counterparty: 'counterparty' in r ? r.counterparty : o.merchant,
      suggested_override: 'suggestedOverride' in r ? String(r.suggestedOverride) : null,
      commitment: 'finalized', source: 'backfill',
    }));
  }
  await pool.query("INSERT INTO cursors VALUES ('backfill', 999999900, NULL, 999999890)");
  rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening');
  process.env.VETO_RPC = `http://127.0.0.1:${(rpc.address() as any).port}/?api-key=private-test-key`;
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  url = `http://127.0.0.1:${(api.address() as any).port}`;
});
after(async () => {
  await Promise.all([new Promise<void>(resolve => api.close(() => resolve())), new Promise<void>(resolve => rpc.close(() => resolve()))]);
  await pool.end();
});

test('agent and owner rule lists and rule detail return exact stored limits', async () => {
  const expected = (await pool.query('SELECT * FROM rules WHERE rule = $1', [selected.mandate])).rows[0];
  for (const path of [`/v1/agents/${selected.agent}/rules`, `/v1/owners/${selected.owner}/rules`]) {
    const { response, body } = await get(path);
    assert.equal(response.status, 200);
    const rule = body.rules.find((r: any) => r.rule === selected.mandate);
    assert.equal(rule.cap, expected.cap); assert.equal(rule.per_tx_max, expected.per_tx_max);
  }
  const { body } = await get(`/v1/rules/${selected.mandate}`);
  assert.equal(body.rule, selected.mandate); assert.equal(body.cap, String(selected.cap));
  await pool.query('UPDATE rules SET cap = $2, per_tx_max = $3 WHERE rule = $1', [selected.mandate, '18446744073709551615', '9007199254740993']);
  try {
    const updated = (await get(`/v1/rules/${selected.mandate}`)).body;
    assert.equal(updated.cap, '18446744073709551615'); assert.equal(updated.per_tx_max, '9007199254740993');
  } finally {
    await pool.query('UPDATE rules SET cap = $2, per_tx_max = $3 WHERE rule = $1', [selected.mandate, expected.cap, expected.per_tx_max]);
  }
});

test('rule decisions retain provenance and paginate strictly before a slot', async () => {
  const all = (await pool.query('SELECT * FROM decisions WHERE rule = $1 ORDER BY slot DESC, signature, instruction_index, inner_index', [selected.mandate])).rows;
  const { response, body } = await get(`/v1/rules/${selected.mandate}/decisions?limit=2`);
  assert.equal(response.status, 200); assert.equal(body.decisions.length, 2);
  assert.deepEqual(body.decisions.map((d: any) => d.signature), all.slice(0, 2).map(d => d.signature));
  for (const d of body.decisions) {
    assert.equal(typeof d.amount, 'string'); assert.equal(typeof d.nonce, 'string');
    assert.equal(d.finalized, true); assert.equal(d.source, 'backfill');
    assert.equal(typeof d.instruction_index, 'number'); assert.equal(typeof d.slot, 'string');
  }
  const before = body.decisions[1].slot;
  const page = await get(`/v1/rules/${selected.mandate}/decisions?before=${before}&limit=500`);
  assert.deepEqual(page.body.decisions.map((d: any) => d.signature), all.filter(d => BigInt(d.slot) < BigInt(before)).map(d => d.signature));
  assert.deepEqual((await get(`/v1/rules/${selected.mandate}/decisions?before=0`)).body.decisions, []);
});

test('signature lookup returns all instruction decisions with exact large amounts', async () => {
  const original = (await pool.query('SELECT * FROM decisions WHERE rule = $1 LIMIT 1', [selected.mandate])).rows[0];
  await transaction(tx => insertDecision(tx, { ...original, instruction_index: 999, amount: '18446744073709551615', suggested_override: '9007199254740993', commitment: 'confirmed', source: 'logs' }));
  try {
    const { response, body } = await get(`/v1/decisions/${original.signature}`);
    assert.equal(response.status, 200);
    assert.ok(body.decisions.length >= 2);
    const row = body.decisions.find((d: any) => d.instruction_index === 999);
    assert.equal(row.amount, '18446744073709551615'); assert.equal(row.suggested_override, '9007199254740993');
    assert.equal(row.finalized, false); assert.equal(row.source, 'logs'); assert.equal(row.signature, original.signature);
  } finally {
    const { reverseDecision } = await import('../src/ingest.js');
    await reverseDecision({ ...original, instruction_index: 999 });
  }
});

test('agent record matches grade function, counters and refusal reason tallies', async () => {
  const stats = (await pool.query('SELECT * FROM agent_stats WHERE agent = $1', [selected.agent])).rows[0];
  const expected = grade({ paid: BigInt(stats.paid), outside: BigInt(stats.outside), allowances: BigInt(stats.allowances), declines: BigInt(stats.declines),
    firstOpenTs: stats.first_open_ts ? BigInt(stats.first_open_ts.getTime() / 1000) : null,
    firstTs: stats.first_ts ? BigInt(stats.first_ts.getTime() / 1000) : null }, BigInt(Math.floor(Date.now() / 1000)));
  const { response, body } = await get(`/v1/agents/${selected.agent}/record`);
  assert.equal(response.status, 200);
  assert.deepEqual(body.grade, JSON.parse(JSON.stringify(expected, (_, v) => typeof v === 'bigint' ? String(v) : v)));
  const tallies = (await pool.query('SELECT reason, count(*)::text AS count FROM decisions WHERE agent=$1 AND kind=2 GROUP BY reason', [selected.agent])).rows;
  assert.deepEqual(body.reason_tallies, Object.fromEntries(tallies.map(r => [r.reason, r.count])));
});

test('health reports RPC tip, cursor progress, exact lag, watermark and counts for every source', async () => {
  const { response, body } = await get('/v1/health');
  assert.equal(response.status, 200);
  assert.equal(body.chain_tip_slot, '999999999'); assert.equal(body.last_indexed_slot, '999999900');
  assert.equal(body.lag_slots, '99'); assert.equal(body.lag_ms, '10000'); assert.equal(body.finalized_watermark, '999999890');
  const count = (await pool.query('SELECT count(*)::text AS count FROM decisions')).rows[0].count;
  assert.deepEqual(body.rows_per_source, { grpc: '0', webhook: '0', backfill: count, logs: '0' });
});

test('RPC failures return sanitized service unavailable errors', async () => {
  rpcMode = 'error';
  try {
    const { response, body } = await get('/v1/health');
    assert.equal(response.status, 503); assert.deepEqual(body, { error: 'RPC unavailable' });
  } finally { rpcMode = 'ok'; }
});

test('invalid addresses, signatures and pagination return 400', async () => {
  const bad = ['0bad', '1', bs58.encode(Buffer.alloc(33, 1)), '%ZZ', '%2F', '%00'];
  for (const value of bad) for (const path of [`agents/${value}/rules`, `agents/${value}/record`, `owners/${value}/rules`, `rules/${value}`, `rules/${value}/decisions`, `decisions/${value}`]) {
    assert.equal((await get(`/v1/${path}`)).response.status, 400, path);
  }
  for (const query of ['limit=0', 'limit=501', 'limit=-1', 'limit=1.5', 'limit=1e2', 'limit=', 'limit=1&limit=2', 'before=-1', 'before=1.2', 'before=9223372036854775808', 'before=', 'before=0&before=1', 'other=1']) {
    assert.equal((await get(`/v1/rules/${selected.mandate}/decisions?${query}`)).response.status, 400, query);
  }
});

test('unknown resources return 404 and CORS only allows GET', async () => {
  const key = bs58.encode(Buffer.alloc(32, 7)), signature = bs58.encode(Buffer.alloc(64, 7));
  for (const path of [`agents/${key}/rules`, `agents/${key}/record`, `owners/${key}/rules`, `rules/${key}`, `rules/${key}/decisions`, `decisions/${signature}`, 'missing']) {
    assert.equal((await get(`/v1/${path}`)).response.status, 404, path);
  }
  const response = await fetch(url + '/v1/health', { method: 'POST' });
  assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET');
});


test('missing block times stay null and unfinished sources prevent a finalized watermark', async () => {
  rpcMode = 'missing-time';
  await pool.query("INSERT INTO cursors (source, last_slot) VALUES ('grpc', 999999800)");
  try {
    const { response, body } = await get('/v1/health');
    assert.equal(response.status, 200); assert.equal(body.lag_ms, null);
    assert.equal(body.lag_slots, '99'); assert.equal(body.finalized_watermark, null);
  } finally {
    rpcMode = 'ok';
    await pool.query("DELETE FROM cursors WHERE source = 'grpc'");
  }
});

test('empty index reports unknown lag and known rule agents still have a zero record', async () => {
  await pool.query('TRUNCATE decisions, decision_keys, deltas, rule_stats, agent_stats, cursors CASCADE');
  const health = await get('/v1/health');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { chain_tip_slot: '999999999', last_indexed_slot: null, lag_slots: null, lag_ms: null,
    finalized_watermark: null, rows_per_source: { grpc: '0', webhook: '0', backfill: '0', logs: '0' } });
  const record = await get(`/v1/agents/${selected.agent}/record`);
  assert.equal(record.response.status, 200);
  assert.equal(record.body.grade.id, 'too-new'); assert.equal(record.body.grade.requests, '0');
  assert.deepEqual(record.body.reason_tallies, {});
  const decisions = await get(`/v1/rules/${selected.mandate}/decisions`);
  assert.equal(decisions.response.status, 200); assert.deepEqual(decisions.body.decisions, []);
  await pool.query("INSERT INTO cursors (source, last_slot, finalized_watermark) VALUES ('grpc', 1000000000, 999999900)");
  const ahead = await get('/v1/health');
  assert.equal(ahead.body.lag_slots, '0'); assert.equal(ahead.body.lag_ms, '0');
});
