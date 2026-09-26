import { transaction, type Tx } from './db/transaction.js';
import { ensureMonth } from './db/partitions.js';

export interface Decision {
  signature: string; slot: string; block_time: string | Date;
  instruction_index: number; inner_index: number; program_version: number;
  rule_kind: 'mandate' | 'hold' | 'trade'; rule: string; agent: string; owner: string;
  kind: number; reason: number; amount: string; nonce: string; counterparty: string;
  suggested_override: string | null; commitment: 'confirmed' | 'finalized';
  source: 'grpc' | 'webhook' | 'backfill' | 'logs';
}
export type DecisionKey = Pick<Decision, 'signature' | 'instruction_index' | 'inner_index'>;
const keys = (row: DecisionKey) => [row.signature, row.instruction_index, row.inner_index];
const whereKey = 'signature = $1 AND instruction_index = $2 AND inner_index = $3';
const counters = ['requests', 'paid', 'outside', 'allowances', 'declines'] as const;
type Delta = Record<typeof counters[number], string> & { rule: string; agent: string };

async function apply(tx: Tx, delta: Delta, sign: bigint, ruleKind: Decision['rule_kind']) {
  for (const [table, key] of [['rule_stats', 'rule'], ['agent_stats', 'agent']] as const) {
    if (key === 'agent' && ruleKind === 'hold') continue;
    await tx.query(`INSERT INTO ${table} (${key}) VALUES ($1) ON CONFLICT DO NOTHING`, [delta[key]]);
    await tx.query(`UPDATE ${table} SET ${counters.map((c, i) => `${c} = ${c} + $${i + 2}`).join(', ')}, updated_at = now() WHERE ${key} = $1`,
      [delta[key], ...counters.map(c => (BigInt(delta[c]) * sign).toString())]);
  }
}

async function recomputeNonce(tx: Tx, rule: string, nonce: string) {
  const { rows } = await tx.query(`SELECT d.*,
    EXISTS (SELECT 1 FROM decisions s WHERE s.rule = d.rule AND s.nonce = d.nonce AND s.kind = 3) AS has_allowance,
    EXISTS (SELECT 1 FROM decisions s WHERE s.rule = d.rule AND s.nonce = d.nonce AND s.kind = 2) AS has_refusal
    FROM decisions d WHERE d.rule = $1 AND d.nonce = $2`, [rule, nonce]);
  for (const row of rows) {
    const paid = row.kind === 1 && !row.has_allowance ? 1 : 0;
    const outside = row.kind === 2 || (row.kind === 3 && !row.has_refusal) ? 1 : 0;
    const next: Delta = { rule, agent: row.agent, requests: String(paid + outside), paid: String(paid),
      outside: String(outside), allowances: row.kind === 3 ? '1' : '0', declines: row.kind === 100 ? '1' : '0' };
    const previous = (await tx.query(`SELECT * FROM deltas WHERE ${whereKey}`, keys(row))).rows[0] as Delta | undefined;
    const difference = { ...next };
    for (const c of counters) difference[c] = (BigInt(next[c]) - BigInt(previous?.[c] ?? '0')).toString();
    await apply(tx, difference, 1n, row.rule_kind);
    await tx.query(`INSERT INTO deltas (signature, instruction_index, inner_index, rule, agent, ${counters.join(', ')})
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (signature, instruction_index, inner_index)
      DO UPDATE SET ${counters.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`,
    [...keys(row), rule, row.agent, ...counters.map(c => next[c])]);
  }
}

async function bumpExtrema(tx: Tx, key: 'rule' | 'agent', value: string, row: Decision) {
  const table = key === 'rule' ? 'rule_stats' : 'agent_stats';
  await tx.query(`UPDATE ${table} SET
    first_open_ts = CASE WHEN $2 = 0 AND $3::timestamptz > '1970-01-01Z' THEN LEAST(first_open_ts, $3::timestamptz) ELSE first_open_ts END,
    first_ts = CASE WHEN $3::timestamptz > '1970-01-01Z' THEN LEAST(first_ts, $3::timestamptz) ELSE first_ts END,
    last_ts = GREATEST(last_ts, $3::timestamptz),
    last_slot = GREATEST(last_slot, $4::bigint), updated_at = now()
    WHERE ${key} = $1`, [value, row.kind, row.block_time, row.slot]);
}

interface RemovedRow { rule_kind: Decision['rule_kind']; nonce: string; kind: number; slot: string; block_time: string | Date }

async function rescanExtrema(tx: Tx, key: 'rule' | 'agent', value: string, removed: RemovedRow) {
  const table = key === 'rule' ? 'rule_stats' : 'agent_stats';
  const stats = (await tx.query(`SELECT first_open_ts, first_ts, last_ts, last_slot FROM ${table} WHERE ${key} = $1`, [value])).rows[0];
  if (!stats) return;
  const removedTs = new Date(removed.block_time).getTime();
  const assignments: string[] = [];
  const agentFilter = key === 'agent' ? " AND rule_kind <> 'hold'" : '';
  if (removed.kind === 0 && stats.first_open_ts instanceof Date && stats.first_open_ts.getTime() === removedTs) {
    assignments.push(`first_open_ts = (SELECT min(block_time) FROM decisions WHERE ${key} = $1${agentFilter} AND kind = 0 AND block_time > '1970-01-01Z')`);
  }
  if (stats.first_ts instanceof Date && stats.first_ts.getTime() === removedTs && removedTs > 0) {
    assignments.push(`first_ts = (SELECT min(block_time) FROM decisions WHERE ${key} = $1${agentFilter} AND block_time > '1970-01-01Z')`);
  }
  if (stats.last_ts instanceof Date && stats.last_ts.getTime() === removedTs) {
    assignments.push(`last_ts = (SELECT max(block_time) FROM decisions WHERE ${key} = $1${agentFilter})`);
  }
  if (stats.last_slot !== null && BigInt(stats.last_slot) === BigInt(removed.slot)) {
    assignments.push(`last_slot = (SELECT max(slot) FROM decisions WHERE ${key} = $1${agentFilter})`);
  }
  await tx.query(`UPDATE ${table} SET ${[...assignments, 'updated_at = now()'].join(', ')} WHERE ${key} = $1`, [value]);
}

/** Caller must supply an active READ COMMITTED transaction, normally via transaction(). */
export async function insertDecision(tx: Tx, row: Decision): Promise<boolean> {
  // Serialize writers until a finer-grained lock protocol is needed. This also
  // protects partition DDL and nonce reclassification across sources and agents.
  await tx.query('SELECT pg_advisory_xact_lock(762042)');
  const inserted = await tx.query(`INSERT INTO decision_keys (signature, instruction_index, inner_index, block_time)
    VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING signature`, [...keys(row), row.block_time]);
  if (!inserted.rowCount) return false;
  await ensureMonth(tx, row.block_time);
  const columns = ['signature', 'slot', 'block_time', 'instruction_index', 'inner_index', 'program_version',
    'rule_kind', 'rule', 'agent', 'owner', 'kind', 'reason', 'amount', 'nonce', 'counterparty',
    'suggested_override', 'commitment', 'source'] as const;
  const decision = await tx.query(`INSERT INTO decisions (${columns.join(', ')})
    VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING RETURNING signature`, columns.map(c => row[c]));
  if (!decision.rowCount) throw new Error('Decision key exists without a newly inserted decision');
  await recomputeNonce(tx, row.rule, row.nonce);
  await bumpExtrema(tx, 'rule', row.rule, row);
  if (row.rule_kind !== 'hold') await bumpExtrema(tx, 'agent', row.agent, row);
  return true;
}

export function reverseDecision(row: DecisionKey): Promise<boolean>;
export function reverseDecision(tx: Tx, row: DecisionKey): Promise<boolean>;
export async function reverseDecision(txOrRow: Tx | DecisionKey, row?: DecisionKey): Promise<boolean> {
  if (!row) return transaction(tx => reverseDecision(tx, txOrRow as DecisionKey));
  const tx = txOrRow as Tx;
  await tx.query('SELECT pg_advisory_xact_lock(762042)');
  const delta = (await tx.query(`SELECT * FROM deltas WHERE ${whereKey}`, keys(row))).rows[0] as Delta | undefined;
  if (!delta) return false;
  const removed = (await tx.query(`SELECT rule_kind, nonce, kind, slot, block_time FROM decisions WHERE ${whereKey}`, keys(row))).rows[0] as RemovedRow | undefined;
  if (!removed) throw new Error('Delta exists without a decision');
  await apply(tx, delta, -1n, removed.rule_kind);
  await tx.query(`DELETE FROM deltas WHERE ${whereKey}`, keys(row));
  await tx.query(`DELETE FROM decisions WHERE ${whereKey}`, keys(row));
  await tx.query(`DELETE FROM decision_keys WHERE ${whereKey}`, keys(row));
  await recomputeNonce(tx, delta.rule, removed.nonce);
  await rescanExtrema(tx, 'rule', delta.rule, removed);
  if (removed.rule_kind !== 'hold') await rescanExtrema(tx, 'agent', delta.agent, removed);
  return true;
}
