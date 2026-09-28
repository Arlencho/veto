import { redactRpc } from './rpcPrivacy';
import { PublicKey } from '@solana/web3.js';

import { openedAtSec, ruleDay } from '../components/daily/facts';
import { KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, PURPOSE_MAX_LEN } from './constants';
import { formatBaseUnits, parseBaseUnits } from './format';
import { formatTokenAmount, tokenSymbol } from './tokens';
import { formatWeekdayDate } from './grade';
import { isActive, mandateRemaining, type MandateAccount } from './mandate';
import { displayPurpose, formatExpiryDate } from './ruleView';
import type { WalletStore } from './wallet';
import { truncateAddress } from './wallet';

export const RENEWAL_WINDOW_SEC = 7n * 86400n;
export const LET_END_KEY = 'veto.renewal.letEnd';

export const LET_END_NOTE = 'Nothing was signed. This choice costs nothing.';

export type RenewalRow = {
  ts: bigint;
  kind: number;
  amount: bigint;
};

export type NextRuleDraft = {
  merchant: string;
  perTxMax: string;
  cap: string;
  expiryDays: string;
  purpose: string;
  agent: string;
};

export type RenewalEditField = 'merchant' | 'perTxMax' | 'cap' | 'expiryDays' | 'purpose';

export type RenewalView = {
  address: string;
  agentName: string;
  day: number | null;
  total: number | null;
  endsIn: string;
  endsOn: string;
  endsOnShort: string;
  paidCount: number;
  refusedCount: number;
  spentText: string;
  capText: string;
  leftText: string;
  leftUnused: boolean;
  highestAskedText: string;
  highestPaidText: string;
  paidAtLimit: boolean;
  allowedText: string;
  recordNote: string | null;
  baseline: NextRuleDraft;
  letEndDetail: string;
  headline: string;
  ifNothing: string;
  /** Symbol, or the shortened mint, for the amounts on this rule. */
  token: string;
};

export function inRenewalWindow(mandate: MandateAccount, nowSec: bigint): boolean {
  if (!isActive(mandate, nowSec)) {
    return false;
  }
  const left = mandate.expiresAt - nowSec;
  return left > 0n && left <= RENEWAL_WINDOW_SEC;
}

export function endsInPhrase(expiresAt: bigint, nowSec: bigint): string {
  if (nowSec >= expiresAt) {
    return '0 days';
  }
  const sec = expiresAt - nowSec;
  const days = sec / 86400n;
  if (days > 0n) {
    return days === 1n ? '1 day' : `${days.toString()} days`;
  }
  const hours = sec / 3600n;
  if (hours > 0n) {
    return hours === 1n ? '1 hour' : `${hours.toString()} hours`;
  }
  const minutes = sec / 60n;
  if (minutes > 0n) {
    return minutes === 1n ? '1 minute' : `${minutes.toString()} minutes`;
  }
  return 'less than a minute';
}

export function shortDate(unixSeconds: bigint, nowSec: bigint): string {
  const full = formatExpiryDate(unixSeconds);
  const now = formatExpiryDate(nowSec);
  const year = now.slice(-4);
  if (/^\d{4}$/.test(year) && full.endsWith(` ${year}`)) {
    return full.slice(0, -(year.length + 1));
  }
  return full;
}

export function renewalBanner(
  mandate: MandateAccount,
  decimals: number,
  nowSec: bigint,
): { title: string; body: string } | null {
  if (!inRenewalWindow(mandate, nowSec)) {
    return null;
  }
  const left = formatTokenAmount(mandateRemaining(mandate), decimals, mandate.mint);
  const endsIn = endsInPhrase(mandate.expiresAt, nowSec);
  const endsOn = formatWeekdayDate(mandate.expiresAt);
  return {
    title: `Your rule ends in ${endsIn}.`,
    body: `On ${endsOn}. If you do nothing, it ends and the ${left} left goes back to your wallet.`,
  };
}

export function ruleLengthDays(openedAt: bigint | null, expiresAt: bigint): number | null {
  if (openedAt == null || expiresAt <= openedAt) {
    return null;
  }
  const span = expiresAt - openedAt;
  if (span > 86400n * 36500n) {
    return null;
  }
  const total = Number((span + 86399n) / 86400n);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  return total;
}

export function timesPhrase(count: number): string {
  return count === 1 ? '1 time' : `${count.toString()} times`;
}

export function highestAsk(rows: readonly RenewalRow[]): { amount: bigint; refused: boolean } | null {
  let best: { amount: bigint; refused: boolean } | null = null;
  for (const row of rows) {
    if (row.kind !== KIND_PAID && row.kind !== KIND_REFUSED) {
      continue;
    }
    const refused = row.kind === KIND_REFUSED;
    if (!best || row.amount > best.amount || (row.amount === best.amount && refused && !best.refused)) {
      best = { amount: row.amount, refused };
    }
  }
  return best;
}

export function highestPaidAmount(rows: readonly RenewalRow[]): bigint | null {
  let best: bigint | null = null;
  for (const row of rows) {
    if (row.kind !== KIND_PAID) {
      continue;
    }
    if (best == null || row.amount > best) {
      best = row.amount;
    }
  }
  return best;
}

export function overrideCount(rows: readonly RenewalRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (row.kind === KIND_OVERRIDE) {
      count += 1;
    }
  }
  return count;
}

export function highestAskedText(
  rows: readonly RenewalRow[],
  decimals: number,
  mint?: string | null,
): string {
  const ask = highestAsk(rows);
  if (!ask) {
    return 'None yet';
  }
  const amount = formatTokenAmount(ask.amount, decimals, mint);
  return ask.refused ? `${amount}, refused` : `${amount}, paid`;
}

export function highestPaidText(
  rows: readonly RenewalRow[],
  perTxMax: bigint,
  decimals: number,
  mint?: string | null,
): string {
  const paid = highestPaidAmount(rows);
  if (paid == null) {
    return 'None';
  }
  const amount = formatTokenAmount(paid, decimals, mint);
  return paid === perTxMax ? `${amount}, the limit` : amount;
}

export function baselineDraft(
  mandate: MandateAccount,
  rows: readonly RenewalRow[],
  decimals: number,
): NextRuleDraft {
  const days = ruleLengthDays(openedAtSec(rows), mandate.expiresAt);
  return {
    merchant: mandate.merchant,
    perTxMax: formatBaseUnits(mandate.perTxMax, decimals),
    cap: formatBaseUnits(mandate.cap, decimals),
    expiryDays: days == null ? '' : String(days),
    purpose: displayPurpose(mandate.purpose),
    agent: mandate.agent,
  };
}

export function draftsMatch(left: NextRuleDraft, right: NextRuleDraft): boolean {
  return (
    left.merchant.trim() === right.merchant.trim() &&
    left.perTxMax.trim() === right.perTxMax.trim() &&
    left.cap.trim() === right.cap.trim() &&
    left.expiryDays.trim() === right.expiryDays.trim() &&
    left.purpose.trim() === right.purpose.trim() &&
    left.agent.trim() === right.agent.trim()
  );
}

export function runsForLine(expiryDays: string, nowSec: bigint): string | null {
  const trimmed = expiryDays.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const days = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(days) || days <= 0) {
    return null;
  }
  const end = nowSec + BigInt(days) * 86400n;
  return `${days.toString()} days, to ${formatExpiryDate(end)}`;
}

function paidWords(text: string): string {
  return text.endsWith(', the limit') ? text.slice(0, -', the limit'.length) : text;
}

export function becauseLine(args: {
  baseline: NextRuleDraft;
  draft: NextRuleDraft;
  highestPaidText: string;
  leftText: string;
  leftUnused: boolean;
  paidAtLimit: boolean;
}): string {
  const tail = 'Every one of them is yours to change before you sign.';
  if (!draftsMatch(args.baseline, args.draft)) {
    return `You changed the next rule. ${tail}`;
  }
  if (args.leftUnused && args.paidAtLimit && args.highestPaidText !== 'None') {
    return `Same numbers as today, because they held: the highest payment was ${paidWords(args.highestPaidText)} and ${args.leftText} was never needed. ${tail}`;
  }
  if (!args.leftUnused) {
    return `The total set aside was used. ${tail}`;
  }
  if (args.highestPaidText === 'None') {
    return `Same numbers as today. Nothing was paid under this rule, and ${args.leftText} was never needed. ${tail}`;
  }
  return `Same numbers as today. The highest payment was ${paidWords(args.highestPaidText)}, and ${args.leftText} was never needed. ${tail}`;
}

export function renewalDraftError(draft: NextRuleDraft, decimals: number): string | null {
  try {
    const merchant = new PublicKey(draft.merchant.trim());
    if (merchant.toBase58().length === 0) {
      return 'The payee has to be the wallet this rule may pay.';
    }
  } catch {
    return 'The payee has to be the wallet this rule may pay.';
  }
  let cap: bigint;
  let per: bigint;
  try {
    cap = parseBaseUnits(draft.cap, decimals);
    per = parseBaseUnits(draft.perTxMax, decimals);
  } catch (err) {
    return err instanceof Error ? redactRpc(err.message) : 'Enter the amounts for the next rule.';
  }
  if (per <= 0n || cap < 0n) {
    return 'Enter the most per payment and the total set aside.';
  }
  if (per > cap) {
    return 'The most per payment is higher than the total set aside.';
  }
  if (runsForLine(draft.expiryDays, 0n) == null) {
    return 'Enter how many days the next rule runs.';
  }
  const purpose = draft.purpose.trim();
  if (purpose.length === 0) {
    return 'Purpose is required.';
  }
  if (purpose.length > PURPOSE_MAX_LEN) {
    return `Purpose is longer than ${PURPOSE_MAX_LEN.toString()} characters.`;
  }
  return null;
}

export function projectNextRule(
  view: RenewalView,
  draft: NextRuleDraft,
  nowSec: bigint,
  decimals: number,
): { runsFor: string; because: string; error: string | null; merchantShown: string } {
  const runsFor = runsForLine(draft.expiryDays, nowSec) ?? 'Set how many days it runs';
  return {
    runsFor,
    because: becauseLine({
      baseline: view.baseline,
      draft,
      highestPaidText: view.highestPaidText,
      leftText: view.leftText,
      leftUnused: view.leftUnused,
      paidAtLimit: view.paidAtLimit,
    }),
    error: renewalDraftError(draft, decimals),
    merchantShown: truncateAddress(draft.merchant.trim() || draft.merchant),
  };
}

export function buildRenewalView(args: {
  mandate: MandateAccount;
  rows: readonly RenewalRow[];
  decimals: number;
  nowSec: bigint;
  agentName: string;
  ledgerTotal: number | null;
}): RenewalView | null {
  if (!inRenewalWindow(args.mandate, args.nowSec)) {
    return null;
  }
  const left = mandateRemaining(args.mandate);
  const mint = args.mandate.mint;
  const leftText = formatTokenAmount(left, args.decimals, mint);
  const endsIn = endsInPhrase(args.mandate.expiresAt, args.nowSec);
  const endsOn = formatWeekdayDate(args.mandate.expiresAt);
  const endsOnShort = shortDate(args.mandate.expiresAt, args.nowSec);
  const clock = ruleDay(openedAtSec(args.rows), args.mandate.expiresAt, args.nowSec);
  const paid = highestPaidAmount(args.rows);
  const truncated = args.ledgerTotal != null && args.ledgerTotal > args.rows.length;
  return {
    address: args.mandate.address,
    agentName: args.agentName,
    day: clock?.day ?? null,
    total: clock?.total ?? null,
    endsIn,
    endsOn,
    endsOnShort,
    paidCount: args.mandate.spendCount,
    refusedCount: args.mandate.refusalCount,
    spentText: formatTokenAmount(args.mandate.spent, args.decimals, mint),
    capText: formatTokenAmount(args.mandate.cap, args.decimals, mint),
    leftText,
    leftUnused: left > 0n,
    highestAskedText: highestAskedText(args.rows, args.decimals, mint),
    highestPaidText: highestPaidText(args.rows, args.mandate.perTxMax, args.decimals, mint),
    paidAtLimit: paid != null && paid === args.mandate.perTxMax,
    allowedText: timesPhrase(overrideCount(args.rows)),
    recordNote: truncated
      ? 'Payments and refusals are the full count on the rule. The highest amounts and the allowances are from the decisions still stored.'
      : null,
    baseline: baselineDraft(args.mandate, args.rows, args.decimals),
    letEndDetail: `${leftText} goes back to your wallet on ${endsOnShort}. Nothing else happens.`,
    headline: `Your rule ends in ${endsIn}.`,
    ifNothing: `On ${endsOn}. If you do nothing, it ends and the ${leftText} left goes back to your wallet.`,
    token: tokenSymbol(mint),
  };
}

export function renewalSearchParams(
  address: string,
  draft: NextRuleDraft,
): {
  from: string;
  renew: string;
  days: string;
  cap: string;
  per: string;
  payee: string;
  purpose: string;
} {
  // No agent: a renewal always keeps the rule's own agent, so a link cannot swap it.
  return {
    from: address,
    renew: '1',
    days: draft.expiryDays.trim(),
    cap: draft.cap.trim(),
    per: draft.perTxMax.trim(),
    payee: draft.merchant.trim(),
    purpose: draft.purpose.trim(),
  };
}

export function parseLetEnd(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

export async function rememberLetEnd(store: WalletStore, address: string): Promise<void> {
  const current = parseLetEnd(await store.getItem(LET_END_KEY));
  if (!current.includes(address)) {
    current.push(address);
  }
  await store.setItem(LET_END_KEY, JSON.stringify(current));
}
