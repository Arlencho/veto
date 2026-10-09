import { KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import { KIND_OPENED, KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, KIND_REVOKED } from '../../lib/constants';
import { formatBaseUnits } from '../../lib/format';
import { paidAboveLimit } from '../../lib/override';

const BREAKS_STREAK = new Set<number>([KIND_PAID, KIND_OVERRIDE, KIND_ADVISORY_DECLINE]);
const SKIP_STREAK = new Set<number>([KIND_OPENED, KIND_REVOKED]);

export function networkLabel(cluster: string): string {
  if (cluster === 'devnet') {
    return 'Devnet';
  }
  if (cluster === 'testnet') {
    return 'Testnet';
  }
  if (cluster === 'mainnet-beta') {
    return 'Mainnet';
  }
  return cluster;
}

/** Consecutive refusals at the newest end of the ledger. Payments and waivers break the run. */
export function refusalStreak(rows: readonly { kind: number }[]): number {
  let streak = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const kind = rows[index]!.kind;
    if (SKIP_STREAK.has(kind)) {
      continue;
    }
    if (kind !== KIND_REFUSED || BREAKS_STREAK.has(kind)) {
      break;
    }
    streak += 1;
  }
  return streak;
}

export function openedAtSec(rows: readonly { kind: number; ts: bigint }[]): bigint | null {
  let found: bigint | null = null;
  for (const row of rows) {
    if (row.kind !== KIND_OPENED) {
      continue;
    }
    if (found == null || row.ts < found) {
      found = row.ts;
    }
  }
  return found;
}

export function ruleDay(
  openedAt: bigint | null,
  expiresAt: bigint,
  nowSec: bigint,
): { day: number; total: number } | null {
  if (openedAt == null || expiresAt <= openedAt) {
    return null;
  }
  const span = expiresAt - openedAt;
  const total = Number((span + 86399n) / 86400n);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  const elapsed = nowSec <= openedAt ? 0n : nowSec - openedAt;
  let day = Number(elapsed / 86400n) + 1;
  if (day < 1) {
    day = 1;
  }
  if (day > total) {
    day = total;
  }
  return { day, total };
}

/** Integer pair for BlockBar. The ratio matches remaining/cap. The caller speaks the real amounts. */
export function barUnits(remaining: bigint, cap: bigint): { remaining: number; cap: number } {
  const scale = 1000;
  if (cap <= 0n) {
    return { remaining: 0, cap: scale };
  }
  if (remaining >= cap) {
    return { remaining: scale, cap: scale };
  }
  if (remaining <= 0n) {
    return { remaining: 0, cap: scale };
  }
  return { remaining: Number((remaining * BigInt(scale)) / cap), cap: scale };
}

export function wholePayments(cap: bigint, perPayment: bigint): bigint | null {
  if (perPayment <= 0n || cap < 0n) {
    return null;
  }
  return cap / perPayment;
}

const SHARE_CAPTION = /^1 block is one share of (\d+(?:\.\d+)?)(?: ([^\s]+))?$/;
const PER_CAPTION = /^Most per payment: (\d+(?:\.\d+)?)(?: ([^\s]+))?$/;

function parseAmount(text: string): { value: bigint; scale: number } | null {
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    return null;
  }
  const [whole, frac = ''] = text.split('.');
  return { value: BigInt(`${whole || '0'}${frac}`), scale: frac.length };
}

function align(left: { value: bigint; scale: number }, right: { value: bigint; scale: number }): { a: bigint; b: bigint } {
  if (left.scale === right.scale) {
    return { a: left.value, b: right.value };
  }
  if (left.scale > right.scale) {
    return { a: left.value, b: right.value * 10n ** BigInt(left.scale - right.scale) };
  }
  return { a: left.value * 10n ** BigInt(right.scale - left.scale), b: right.value };
}

/** Home passes a share caption. Say what one of the 30 blocks is. */
export function homeBlockCaption(left: string, right: string, blocks = 30): string | null {
  const share = SHARE_CAPTION.exec(left);
  const perMatch = PER_CAPTION.exec(right);
  const capText = share?.[1];
  const perText = perMatch?.[1];
  const token = share?.[2] ?? perMatch?.[2] ?? '';
  const suffix = token ? ` ${token}` : '';
  if (!capText || !perText || blocks <= 0) {
    return null;
  }
  const cap = parseAmount(capText);
  const per = parseAmount(perText);
  if (!cap || !per || per.value === 0n) {
    return null;
  }
  const pair = align(cap, per);
  if (pair.b === 0n) {
    return null;
  }
  if (pair.a / pair.b === BigInt(blocks) && pair.a % pair.b === 0n) {
    return `1 block = 1 payment of ${perText}${suffix}`;
  }
  const slice = cap.value / BigInt(blocks);
  if (cap.value % BigInt(blocks) === 0n) {
    return `1 block is ${formatBaseUnits(slice, cap.scale)}${suffix} of your ${capText}${suffix}`;
  }
  return blocks === 30
    ? `1 block is one thirtieth of your ${capText}${suffix}`
    : `1 block is one share of your ${capText}${suffix}`;
}

export type PaidTileCopy = {
  hint: string;
  accessibilityLabel: string;
};

/**
 * The Overview "Paid by your agent" tile. `paid` is the rule's on-chain payment count;
 * `rows` is the ledger history this screen read. "All within the rule" is said only when
 * every payment is in that history and each one is at or under the per-payment limit.
 */
export function paidTileCopy(
  paid: number,
  rows: readonly { kind: number; amount: bigint }[],
  perTxMax: bigint,
): PaidTileCopy {
  const paidRows = rows.filter((row) => row.kind === KIND_PAID);
  const allowedOnce = Math.min(paid, paidRows.filter((row) => paidAboveLimit(row.amount, perTxMax)).length);
  const complete = paidRows.length >= paid;
  const label = `${paid} ${paid === 1 ? 'payment' : 'payments'} paid by your agent`;
  let hint: string;
  if (allowedOnce > 0) {
    hint = complete
      ? `${allowedOnce} allowed once by you`
      : `${allowedOnce} of the last ${paidRows.length} allowed once by you`;
  } else {
    hint = complete ? 'all within the rule' : 'each checked against the rule';
  }
  return { hint, accessibilityLabel: `${label}, ${hint}` };
}
