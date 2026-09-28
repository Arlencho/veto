import { KIND_PAID, KIND_REFUSED } from './constants';
import { encodeDecisionId, parseDecisionId } from './exportRecord';
import { formatTokenAmount } from './tokens';
import { refusalWhyLine } from './reasons';
import { tradeDecisionDetail } from './tradeCopy';
import { paidAboveLimit } from './override';
import { truncateAddress } from './wallet';

/**
 * Minutes between on-device ledger reads. Android WorkManager will not repeat
 * a periodic task sooner than 15 minutes, and it may wait longer. This is not
 * a real-time watch.
 */
export const DECISION_NOTIFY_INTERVAL_MINUTES = 15;

export const PAID_NOTICE_TITLE = 'Paid within rule';
export const PAID_ALLOWED_ONCE_NOTICE_TITLE = 'Paid, allowed once by you';
export const REFUSED_NOTICE_TITLE = 'Refused';

export type NotifyLedgerRow = {
  ts: bigint;
  kind: number;
  nonce: bigint;
  reason: number;
  amount: bigint;
  suggestedOverride: bigint;
  amountOut?: bigint;
  outMint?: string | null;
  outDecimals?: number;
};

export type NotifyMandateLedger = {
  mandate: string;
  merchant: string;
  perTxMax: bigint;
  decimals: number;
  mint?: string | null;
  family?: 'payment' | 'trade';
  rows: readonly NotifyLedgerRow[];
};

export type DecisionNotice = {
  id: string;
  path: string;
  title: string;
  body: string;
};

export type NoticePlan = {
  notices: DecisionNotice[];
  seenByMandate: Map<string, string[]>;
};

export function paidDecisionBody(args: {
  amount: bigint;
  decimals: number;
  perTxMax: bigint;
  merchant: string;
  mint?: string | null;
}): string {
  const amount = formatTokenAmount(args.amount, args.decimals, args.mint);
  const limit = formatTokenAmount(args.perTxMax, args.decimals, args.mint);
  const payee = truncateAddress(args.merchant);
  const within = paidAboveLimit(args.amount, args.perTxMax)
    ? `allowed once by you above your ${limit} per-payment limit`
    : `under ${limit} per payment`;
  return `${amount}, ${within}. The payee for this rule is ${payee}.`;
}

export function seenStorageKey(mandate: string): string {
  return `veto.notify.seen.${mandate}`;
}

function isNotifiable(kind: number): boolean {
  return kind === KIND_PAID || kind === KIND_REFUSED;
}

function tradePaidBody(ledger: NotifyMandateLedger, row: NotifyLedgerRow): string {
  return tradeDecisionDetail({
    amountIn: row.amount,
    amountOut: row.amountOut,
    inDecimals: ledger.decimals,
    outDecimals: row.outDecimals ?? ledger.decimals,
    inMint: ledger.mint,
    outMint: row.outMint,
    perTradeMax: ledger.perTxMax,
  });
}

function noticeFor(ledger: NotifyMandateLedger, row: NotifyLedgerRow, id: string): DecisionNotice {
  const refused = row.kind === KIND_REFUSED;
  const body = refused
    ? refusalWhyLine({
        reason: row.reason,
        amount: row.amount,
        suggestedOverride: row.suggestedOverride,
        decimals: ledger.decimals,
        perTxMax: ledger.perTxMax,
        mint: ledger.mint,
        unit: ledger.family === 'trade' ? 'trade' : 'payment',
      })
    : ledger.family === 'trade'
      ? tradePaidBody(ledger, row)
      : paidDecisionBody({
          amount: row.amount,
          decimals: ledger.decimals,
          perTxMax: ledger.perTxMax,
          merchant: ledger.merchant,
          mint: ledger.mint,
        });
  return {
    id,
    path: `/decision/${encodeURIComponent(id)}`,
    title: refused
      ? REFUSED_NOTICE_TITLE
      : paidAboveLimit(row.amount, ledger.perTxMax)
        ? PAID_ALLOWED_ONCE_NOTICE_TITLE
        : PAID_NOTICE_TITLE,
    body,
  };
}

export function planDecisionNotices(
  ledgers: readonly NotifyMandateLedger[],
  seenByMandate: ReadonlyMap<string, ReadonlySet<string>>,
): NoticePlan {
  const notices: DecisionNotice[] = [];
  const next = new Map<string, string[]>();
  for (const ledger of ledgers) {
    const seen = seenByMandate.get(ledger.mandate) ?? new Set<string>();
    const queued = new Set<string>();
    const retain: string[] = [];
    for (const row of ledger.rows) {
      if (!isNotifiable(row.kind)) {
        continue;
      }
      const id = encodeDecisionId(ledger.mandate, row);
      if (!parseDecisionId(id)) {
        continue;
      }
      if (!retain.includes(id)) {
        retain.push(id);
      }
      if (seen.has(id) || queued.has(id)) {
        continue;
      }
      queued.add(id);
      notices.push(noticeFor(ledger, row, id));
    }
    next.set(ledger.mandate, retain);
  }
  return { notices, seenByMandate: next };
}

export async function deliverDecisionNotices(args: {
  ledgers: readonly NotifyMandateLedger[];
  seenByMandate: ReadonlyMap<string, ReadonlySet<string>>;
  present: (notice: DecisionNotice) => Promise<void>;
  saveSeen: (mandate: string, ids: readonly string[]) => Promise<void>;
}): Promise<void> {
  const plan = planDecisionNotices(args.ledgers, args.seenByMandate);
  const presented = new Set<string>();
  let failure: unknown = null;
  try {
    for (const notice of plan.notices) {
      const mandate = parseDecisionId(notice.id)?.mandate;
      // No stored key: this is the first read after permission was granted,
      // or the first read of a rule added later. Keep the row, do not announce it.
      // An empty set means the key exists, so a later row is announced.
      if (mandate != null && !args.seenByMandate.has(mandate)) {
        continue;
      }
      await args.present(notice);
      presented.add(notice.id);
    }
  } catch (err) {
    failure = err;
  }
  for (const [mandate, target] of plan.seenByMandate) {
    if (!args.seenByMandate.has(mandate)) {
      await args.saveSeen(mandate, target);
      continue;
    }
    const previous = args.seenByMandate.get(mandate) ?? new Set<string>();
    const keep = target.filter((id) => previous.has(id) || presented.has(id));
    await args.saveSeen(mandate, keep);
  }
  if (failure) {
    throw failure;
  }
}

export function serializeSeenIds(mandate: string, ids: readonly string[]): string {
  const prefix = `${mandate}:`;
  const compact: string[] = [];
  for (const id of ids) {
    if (!id.startsWith(prefix)) {
      continue;
    }
    const rest = id.slice(prefix.length);
    if (!parseDecisionId(id)) {
      continue;
    }
    compact.push(rest);
  }
  return JSON.stringify(compact);
}

// A null raw value means nothing is stored and yields an empty set.
// Text that is not a JSON array yields null, so a caller can tell corruption
// apart from a real empty seen set.
export function parseSeenIds(mandate: string, raw: string | null): Set<string> | null {
  if (raw === null) {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'string' || item.length === 0) {
      continue;
    }
    const id = item.startsWith(`${mandate}:`) ? item : `${mandate}:${item}`;
    if (parseDecisionId(id)) {
      out.add(id);
    }
  }
  return out;
}

export function decisionPathFromNoticeData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('decisionId' in data)) {
    return null;
  }
  const id = (data as { decisionId?: unknown }).decisionId;
  if (typeof id !== 'string' || !parseDecisionId(id)) {
    return null;
  }
  return `/decision/${encodeURIComponent(id)}`;
}
