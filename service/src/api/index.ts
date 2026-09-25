import { createServer, type ServerResponse } from 'node:http';
import bs58 from 'bs58';
import { pool } from '../db/transaction.js';
import { grade } from '../grade.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const decisionColumns = `signature, slot::text, block_time, instruction_index, inner_index,
  program_version, rule_kind, rule, agent, owner, kind, reason, amount::text, nonce::text,
  counterparty, suggested_override::text, commitment, commitment = 'finalized' AS finalized, source`;
const ruleColumns = `rule, owner, agent, mint, source, merchant, cap::text, per_tx_max::text,
  expires_at, status, opened_at, closed_at`;
const order = 'slot DESC, signature, instruction_index, inner_index';

function address(value: string, bytes = 32): string {
  try {
    value = decodeURIComponent(value);
    if (value.length > (bytes === 32 ? 44 : 88) || bs58.decode(value).length !== bytes) throw new Error();
    return value;
  } catch { throw new HttpError(400, bytes === 32 ? 'Invalid public key' : 'Invalid signature'); }
}
function integer(value: string, max: bigint, min = 0n): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 19 || BigInt(value) < min || BigInt(value) > max) {
    throw new HttpError(400, 'Invalid pagination');
  }
  return value;
}
function queryParams(url: URL, allowed: string[] = []) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, 'Invalid query parameters');
  }
}
function found<T>(value: T | undefined): T {
  if (value === undefined) throw new HttpError(404, 'Not found');
  return value;
}

async function rpc(method: string, params: unknown[]): Promise<number | null> {
  try {
    const endpoint = process.env.VETO_RPC;
    if (!endpoint) throw new Error();
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error();
    const body = await response.json() as { result?: unknown; error?: unknown };
    if (body.error || (body.result !== null && (!Number.isSafeInteger(body.result) || (body.result as number) < 0))) throw new Error();
    if (method === 'getSlot' && body.result === null) throw new Error();
    return body.result as number | null;
  } catch {
    // Never propagate transport errors: they can contain the credentialed URL.
    throw new HttpError(503, 'RPC unavailable');
  }
}

async function health() {
  const tip = BigInt((await rpc('getSlot', [{ commitment: 'confirmed' }]))!);
  const { rows: [state] } = await pool.query(`SELECT
    GREATEST((SELECT max(last_slot) FROM cursors), (SELECT max(slot) FROM decisions))::text AS last_indexed_slot,
    (SELECT CASE WHEN count(*) = count(finalized_watermark) THEN min(finalized_watermark) END FROM cursors)::text AS finalized_watermark,
    (SELECT jsonb_object_agg(source, total) FROM (SELECT source, count(*)::text AS total FROM decisions GROUP BY source) counts) AS rows_per_source`);
  const indexed = state.last_indexed_slot === null ? null : BigInt(state.last_indexed_slot);
  const lag = indexed === null ? null : tip > indexed ? tip - indexed : 0n;
  let lagMs: bigint | null = null;
  if (lag === 0n) lagMs = 0n;
  else if (indexed !== null && indexed <= BigInt(Number.MAX_SAFE_INTEGER)) {
    const [tipTime, indexedTime] = await Promise.all([rpc('getBlockTime', [Number(tip)]), rpc('getBlockTime', [Number(indexed)])]);
    if (tipTime !== null && indexedTime !== null) lagMs = BigInt(Math.max(0, tipTime - indexedTime)) * 1000n;
  }
  return { chain_tip_slot: tip, last_indexed_slot: indexed, lag_slots: lag, lag_ms: lagMs,
    finalized_watermark: state.finalized_watermark,
    rows_per_source: { grpc: '0', webhook: '0', backfill: '0', logs: '0', ...state.rows_per_source } };
}

async function record(agent: string) {
  // One statement keeps the aggregate and reason tallies on the same snapshot.
  const { rows } = await pool.query(`SELECT s.*,
    (SELECT jsonb_object_agg(reason, total) FROM
      (SELECT reason, count(*)::text AS total FROM decisions WHERE agent = $1 AND kind = 2 GROUP BY reason) reasons) AS reason_tallies
    FROM (SELECT $1::text AS identity) a LEFT JOIN agent_stats s ON s.agent = a.identity
    WHERE s.agent IS NOT NULL OR EXISTS (SELECT 1 FROM rules WHERE agent = $1)`, [agent]);
  const s = found(rows[0]);
  const seconds = (date: Date | null) => date ? BigInt(Math.floor(date.getTime() / 1000)) : null;
  const result = grade({ paid: BigInt(s.paid ?? '0'), outside: BigInt(s.outside ?? '0'),
    allowances: BigInt(s.allowances ?? '0'), declines: BigInt(s.declines ?? '0'),
    firstOpenTs: seconds(s.first_open_ts), firstTs: seconds(s.first_ts) }, BigInt(Math.floor(Date.now() / 1000)));
  return { agent, grade: result, reason_tallies: s.reason_tallies ?? {} };
}

async function route(url: URL) {
  const path = url.pathname;
  try { decodeURIComponent(path); }
  catch { throw new HttpError(400, 'Invalid path encoding'); }
  if (path === '/v1/health') { queryParams(url); return health(); }
  let match = /^\/v1\/(agents|owners)\/([^/]+)\/(rules|record)$/.exec(path);
  if (match && (match[1] === 'agents' || match[3] === 'rules')) {
    queryParams(url);
    const key = address(match[2]);
    if (match[3] === 'record') return record(key);
    const column = match[1] === 'agents' ? 'agent' : 'owner';
    const { rows } = await pool.query(`SELECT ${ruleColumns} FROM rules WHERE ${column} = $1 ORDER BY rule`, [key]);
    if (!rows.length) {
      found((await pool.query(`SELECT 1 FROM decisions WHERE ${column} = $1 LIMIT 1`, [key])).rows[0]);
    }
    return { rules: rows };
  }
  match = /^\/v1\/rules\/([^/]+)(\/decisions)?$/.exec(path);
  if (match) {
    const rule = address(match[1]);
    queryParams(url, match[2] ? ['before', 'limit'] : []);
    if (!match[2]) return found((await pool.query(`SELECT ${ruleColumns} FROM rules WHERE rule = $1`, [rule])).rows[0]);
    const before = url.searchParams.has('before') ? integer(url.searchParams.get('before')!, 9223372036854775807n) : null;
    const limit = integer(url.searchParams.get('limit') ?? '100', 500n, 1n);
    found((await pool.query('SELECT 1 FROM rules WHERE rule = $1 UNION ALL SELECT 1 FROM decisions WHERE rule = $1 LIMIT 1', [rule])).rows[0]);
    const { rows } = await pool.query(`SELECT ${decisionColumns} FROM decisions
      WHERE rule = $1 AND ($2::bigint IS NULL OR slot < $2::bigint) ORDER BY ${order} LIMIT $3::integer`, [rule, before, limit]);
    return { decisions: rows };
  }
  match = /^\/v1\/decisions\/([^/]+)$/.exec(path);
  if (match) {
    queryParams(url);
    const { rows } = await pool.query(`SELECT ${decisionColumns} FROM decisions WHERE signature = $1 ORDER BY ${order}`, [address(match[1], 64)]);
    found(rows[0]);
    return { decisions: rows };
  }
  throw new HttpError(404, 'Not found');
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body, (_, value) => typeof value === 'bigint' ? value.toString() : value));
}

export function createApiServer() {
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new HttpError(405, 'Method not allowed');
      }
      const result = await route(new URL(req.url ?? '/', 'http://localhost'));
      send(res, 200, result);
    } catch (error) {
      send(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'Internal server error' });
    }
  });
}
