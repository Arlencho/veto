import { redactRpc } from './rpcPrivacy';
import { KIND_ADVISORY_DECLINE } from './advisory';
import { KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, kindName, statusName } from './constants';
import type { RingEntry } from './ring';

export function formatBaseUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const sign = negative ? '-' : '';
  if (frac === 0n) {
    return `${sign}${whole.toString()}`;
  }
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${whole.toString()}.${fracStr}`;
}

/** Token-aware rounding for display copy; signing and verification use exact values. */
export function roundShownAmounts(text: string): string {
  return text.replace(/-?\d+\.\d{3,}( wrapped SOL)?/g, (token, sol: string | undefined) => {
    const amount = sol ? token.slice(0, -sol.length) : token;
    const decimals = amount.split('.')[1]!.length;
    return formatDisplayAmount(parseBaseUnits(amount, decimals), decimals, sol ? 4 : 2) + (sol ?? '');
  });
}

export function formatDisplayAmount(amount: bigint, decimals: number, precision = 2): string {
  const places = Math.min(decimals, precision);
  const unit = 10n ** BigInt(decimals - places);
  const absolute = amount < 0n ? -amount : amount;
  const rounded = (absolute + unit / 2n) / unit;
  if (absolute > 0n && rounded === 0n) {
    const threshold = formatBaseUnits(1n, places);
    return amount < 0n ? `>-${threshold}` : `<${threshold}`;
  }
  return formatBaseUnits(amount < 0n ? -rounded : rounded, places);
}

export function parseBaseUnits(text: string, decimals: number): bigint {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('amount is empty');
  }
  const negative = trimmed.startsWith('-');
  const raw = negative ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('amount must be a non-negative decimal');
  }
  const [wholeRaw, fracRaw = ''] = raw.split('.');
  if (fracRaw.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimal places`);
  }
  const whole = BigInt(wholeRaw || '0');
  const frac = BigInt(fracRaw.padEnd(decimals, '0') || '0');
  const value = whole * 10n ** BigInt(decimals) + frac;
  return negative ? -value : value;
}

export function remainingCap(cap: bigint, spent: bigint): bigint {
  return cap > spent ? cap - spent : 0n;
}

export function formatTimeLeft(expiresAt: bigint, nowSec: bigint): string {
  if (nowSec >= expiresAt) {
    return 'expired';
  }
  const sec = expiresAt - nowSec;
  const days = sec / 86400n;
  const hours = (sec % 86400n) / 3600n;
  const minutes = (sec % 3600n) / 60n;
  if (days > 0n) {
    return `${days.toString()}d ${hours.toString()}h left`;
  }
  if (hours > 0n) {
    return `${hours.toString()}h ${minutes.toString()}m left`;
  }
  if (minutes > 0n) {
    return `${minutes.toString()}m left`;
  }
  return 'less than a minute left';
}

export function isLocalDay(unixSeconds: bigint, nowMs: number): boolean {
  const then = new Date(Number(unixSeconds) * 1000);
  const now = new Date(nowMs);
  return (
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  );
}

export function isListedDecision(kind: number): boolean {
  return (
    kind === KIND_PAID ||
    kind === KIND_REFUSED ||
    kind === KIND_OVERRIDE ||
    kind === KIND_ADVISORY_DECLINE
  );
}

export function decisionTotals(rows: readonly { kind: number }[]): {
  paid: number;
  refused: number;
  override: number;
} {
  let paid = 0;
  let refused = 0;
  let override = 0;
  for (const row of rows) {
    if (row.kind === KIND_PAID) {
      paid += 1;
    } else if (row.kind === KIND_REFUSED) {
      refused += 1;
    } else if (row.kind === KIND_OVERRIDE) {
      override += 1;
    }
  }
  return { paid, refused, override };
}

export function todaysAgentDecisions<T extends RingEntry>(entries: readonly T[], nowMs: number): T[] {
  const todays = entries.filter((entry) => isListedDecision(entry.kind) && isLocalDay(entry.ts, nowMs));
  return todays.slice().reverse();
}

export function newestFirst<T>(entries: readonly T[]): T[] {
  return entries.slice().reverse();
}

export function explorerTxUrl(
  signature: string,
  cluster: string,
  rpcUrl: string,
): string {
  if (cluster === 'devnet' || cluster === 'testnet' || cluster === 'mainnet-beta') {
    return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
  }
  const custom = encodeURIComponent(redactRpc(rpcUrl));
  return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${custom}`;
}

export function formatKindLabel(kind: number): string {
  const name = kindName(kind);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function formatStatusLabel(status: number): string {
  return statusName(status);
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

export function formatUnix(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    return unixSeconds.toString();
  }
  const year = date.getFullYear().toString().padStart(4, '0');
  return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function formatClock(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    return unixSeconds.toString();
  }
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

const DAY_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function formatDayHeading(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    return unixSeconds.toString();
  }
  return `${date.getDate()} ${DAY_MONTHS[date.getMonth()] ?? ''}`;
}

export function localDayKey(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    return unixSeconds.toString();
  }
  return `${date.getFullYear().toString().padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function groupByLocalDay<T extends { ts: bigint }>(
  rows: readonly T[],
): { key: string; heading: string; rows: T[] }[] {
  const groups: { key: string; heading: string; rows: T[] }[] = [];
  const indexByKey = new Map<string, number>();
  for (const row of rows) {
    const key = localDayKey(row.ts);
    const existing = indexByKey.get(key);
    if (existing != null) {
      groups[existing]!.rows.push(row);
      continue;
    }
    indexByKey.set(key, groups.length);
    groups.push({ key, heading: formatDayHeading(row.ts), rows: [row] });
  }
  return groups;
}

export function timeLeftParts(
  expiresAt: bigint,
  nowSec: bigint,
): { value: string; label: string } {
  if (nowSec >= expiresAt) {
    return { value: '0', label: 'expired' };
  }
  const sec = expiresAt - nowSec;
  const days = sec / 86400n;
  if (days > 0n) {
    return { value: days.toString(), label: days === 1n ? 'day left' : 'days left' };
  }
  const hours = sec / 3600n;
  if (hours > 0n) {
    return { value: hours.toString(), label: hours === 1n ? 'hour left' : 'hours left' };
  }
  const minutes = sec / 60n;
  if (minutes > 0n) {
    return { value: minutes.toString(), label: minutes === 1n ? 'minute left' : 'minutes left' };
  }
  return { value: '1', label: 'minute left' };
}
