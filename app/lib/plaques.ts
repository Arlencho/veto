import { KIND_ADVISORY_DECLINE } from './advisory';
import {
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  KIND_REVOKED,
  REASON_OVER_PER_TX_MAX,
  STATUS_ACTIVE,
  STATUS_EXHAUSTED,
  STATUS_EXPIRED,
  STATUS_REVOKED,
} from './constants';
import { remainingCap } from './format';
import { formatTokenAmount } from './tokens';
import {
  elapsedDays,
  formatWeekdayDate,
  plaqueDateLabel,
  recordReasonTitle,
  ruleTotalDays,
  type GradeDecision,
  type RuleSnapshot,
} from './grade';
import { payeeLabel } from './wallet';

export type PlaqueId = 'first-payment' | 'first-refusal' | 'ten-refusals' | 'thirty-days' | 'rule-ended';

export type Plaque = {
  id: PlaqueId;
  earned: boolean;
  title: string;
  dateLabel: string;
  detail: string;
  atSec: bigint | null;
};

const DAY = 86400n;

function byTime(rows: readonly GradeDecision[]): GradeDecision[] {
  return rows.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function pending(id: PlaqueId, title: string, dateLabel: string, detail: string): Plaque {
  return { id, earned: false, title, dateLabel, detail, atSec: null };
}

function firstPayment(rule: RuleSnapshot): Plaque {
  const title = 'First payment inside the rule';
  // A payment the owner allowed once above the limit was not inside the rule.
  const paid = byTime(rule.classified.paidInside);
  const first = paid[0];
  if (!first) {
    return pending(
      'first-payment',
      title,
      'Not yet',
      'Engraved on the first payment the rule lets through.',
    );
  }
  const day = rule.startedAt == null ? null : elapsedDays(rule.startedAt, first.ts);
  const payee = payeeLabel(rule.merchant);
  return {
    id: 'first-payment',
    earned: true,
    title,
    dateLabel: plaqueDateLabel(day, first.ts),
    detail: `Paid ${formatTokenAmount(first.amount, rule.decimals, rule.mint)} to ${payee}. Limit per payment: ${rule.perTxMaxLabel}.`,
    atSec: first.ts,
  };
}

function firstRefusal(rule: RuleSnapshot): Plaque {
  const title = 'First refusal saved';
  const refused = byTime(rule.classified.refused);
  const first = refused[0];
  if (!first) {
    return pending(
      'first-refusal',
      title,
      'Not yet',
      'Engraved on the first payment the rule refuses. The reason is saved with it.',
    );
  }
  const day = rule.startedAt == null ? null : elapsedDays(rule.startedAt, first.ts);
  const amount = formatTokenAmount(first.amount, rule.decimals, rule.mint);
  const detail =
    first.reason === REASON_OVER_PER_TX_MAX
      ? `Asked ${amount}, the limit is ${rule.perTxMaxLabel}. Nothing moved. Reason saved for anyone to check.`
      : `Asked ${amount}. ${recordReasonTitle(first.reason, rule.perTxMaxLabel)}. Nothing moved. Reason saved for anyone to check.`;
  return {
    id: 'first-refusal',
    earned: true,
    title,
    dateLabel: plaqueDateLabel(day, first.ts),
    detail,
    atSec: first.ts,
  };
}

function tenRefusals(rule: RuleSnapshot): Plaque {
  const title = 'Ten refusals, none allowed';
  const refused = byTime(rule.classified.refused);
  const allowed = rule.classified.allowances.length;
  if (refused.length < 10 || allowed > 0) {
    return pending(
      'ten-refusals',
      title,
      'Not yet',
      `Engraved after 10 refusals with none allowed by you. ${refused.length} refusals so far, ${allowed} allowed.`,
    );
  }
  const tenth = refused[9];
  if (!tenth) {
    return pending('ten-refusals', title, 'Not yet', 'Engraved after 10 refusals with none allowed by you.');
  }
  const day = rule.startedAt == null ? null : elapsedDays(rule.startedAt, tenth.ts);
  return {
    id: 'ten-refusals',
    earned: true,
    title,
    dateLabel: plaqueDateLabel(day, tenth.ts),
    detail: `Your agent asked outside the rule 10 times. Stopped every time. Money moved: ${formatTokenAmount(0n, rule.decimals, rule.mint)}.`,
    atSec: tenth.ts,
  };
}

function countsUntil(rows: readonly GradeDecision[], mark: bigint): { paid: number; refused: number; allowed: number; spent: bigint } {
  let paid = 0;
  let refused = 0;
  let allowed = 0;
  let spent = 0n;
  for (const row of rows) {
    if (row.ts > mark) {
      continue;
    }
    if (row.kind === KIND_PAID) {
      paid += 1;
      spent += row.amount;
    } else if (row.kind === KIND_REFUSED) {
      refused += 1;
    } else if (row.kind === KIND_OVERRIDE) {
      allowed += 1;
    } else if (row.kind === KIND_ADVISORY_DECLINE) {
      continue;
    }
  }
  return { paid, refused, allowed, spent };
}

function thirtyDays(rule: RuleSnapshot, nowSec: bigint): Plaque {
  const title = '30 days inside the rule';
  const started = rule.startedAt;
  if (started == null || elapsedDays(started, nowSec) < 30) {
    const when = started == null ? null : started + 29n * DAY;
    const dateLabel = when == null ? 'Not yet' : `Not yet: ${plaqueDateLabel(30, when)}`;
    return pending(
      'thirty-days',
      title,
      dateLabel,
      'Engraved on day 30 if the rule is still inside its dates.',
    );
  }
  const mark = started + 29n * DAY;
  const counts = countsUntil(rule.rows, mark);
  const left = remainingCap(rule.cap, counts.spent);
  const day = 30;
  return {
    id: 'thirty-days',
    earned: true,
    title,
    dateLabel: plaqueDateLabel(day, mark),
    detail: `${counts.paid} paid, ${counts.refused} refused, ${counts.allowed} allowed after a refusal. ${formatTokenAmount(left, rule.decimals, rule.mint)} of ${rule.capLabel} left that day.`,
    atSec: mark,
  };
}

function revokedBeforeEnd(rule: RuleSnapshot): boolean {
  if (rule.status !== STATUS_REVOKED) {
    return false;
  }
  const revoked = rule.rows.find((row) => row.kind === KIND_REVOKED);
  if (!revoked) {
    return true;
  }
  return revoked.ts < rule.expiresAt;
}

export function ruleEndedInsideCap(rule: RuleSnapshot, nowSec: bigint): boolean {
  if (rule.spent > rule.cap) {
    return false;
  }
  if (revokedBeforeEnd(rule)) {
    return false;
  }
  if (rule.status === STATUS_EXHAUSTED || rule.status === STATUS_EXPIRED) {
    return true;
  }
  if (rule.status === STATUS_REVOKED) {
    const revoked = rule.rows.find((row) => row.kind === KIND_REVOKED);
    return revoked != null && revoked.ts >= rule.expiresAt;
  }
  return rule.status === STATUS_ACTIVE && nowSec >= rule.expiresAt;
}

function ruleEnded(rule: RuleSnapshot, nowSec: bigint): Plaque {
  const title = 'Rule finished, rest returned';
  const total = ruleTotalDays(rule.startedAt, rule.expiresAt);
  const endLabel =
    total == null
      ? `Not yet: ${formatWeekdayDate(rule.expiresAt)}`
      : `Not yet: day ${total}, ${formatWeekdayDate(rule.expiresAt)}`;
  if (!ruleEndedInsideCap(rule, nowSec)) {
    return pending(
      'rule-ended',
      title,
      endLabel,
      'Engraved if the rule runs to its end. Whatever is left goes back to your wallet.',
    );
  }
  const left = remainingCap(rule.cap, rule.spent);
  const at = nowSec >= rule.expiresAt ? rule.expiresAt : nowSec;
  const day = rule.startedAt == null ? null : elapsedDays(rule.startedAt, at);
  const detail =
    left === 0n
      ? `The rule ended with nothing left of ${rule.capLabel}. The cap held.`
      : `The rule ended with ${formatTokenAmount(left, rule.decimals, rule.mint)} of ${rule.capLabel} left in your wallet.`;
  return {
    id: 'rule-ended',
    earned: true,
    title,
    dateLabel: plaqueDateLabel(day, at > 0n ? at - 1n : at),
    detail,
    atSec: at,
  };
}

export function plaquesForRule(rule: RuleSnapshot, nowSec: bigint): Plaque[] {
  return [firstPayment(rule), firstRefusal(rule), tenRefusals(rule), thirtyDays(rule, nowSec), ruleEnded(rule, nowSec)];
}

export function earnedPlaques(plaques: readonly Plaque[]): Plaque[] {
  return plaques
    .filter((plaque) => plaque.earned && plaque.atSec != null)
    .sort((a, b) => ((a.atSec ?? 0n) > (b.atSec ?? 0n) ? -1 : 1));
}

export function plaqueShareText(plaque: Plaque, ruleAddress: string): string {
  return `${plaque.dateLabel}. ${plaque.title}. ${plaque.detail} Rule ${ruleAddress}.`;
}
