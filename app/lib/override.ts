import {
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  REASON_OVER_CAP,
  REASON_OVER_PER_TX_MAX,
  STATUS_ACTIVE,
  STATUS_EXHAUSTED,
  STATUS_REVOKED,
  ownerReasonText,
  statusName,
} from './constants';
import { formatTokenAmount } from './tokens';
import { isActive, mandateRemaining, type MandateAccount } from './mandate';

export const CAP_OVERRIDE_REFUSAL =
  'A one-time allowance cannot raise the total cap because the program will not accept one.';

export type OverrideSource = {
  kind: number;
  reason: number;
  nonce: bigint;
  amount: bigint;
  suggestedOverride: bigint;
};

export type OverrideOffer =
  | { offer: true; amount: bigint }
  | { offer: false; why: string };

export type OverrideGuard = { ok: true } | { ok: false; why: string };

export type OverrideCommit = {
  title: string;
  amount: string;
  nonce: string;
  paragraphs: string[];
};

export type OverrideAssessment =
  | { status: 'none'; why: string }
  | { status: 'already'; amount: bigint; nonce: bigint; why: string }
  | { status: 'blocked'; why: string }
  | { status: 'ready'; amount: bigint; nonce: bigint; commit: OverrideCommit };

export type OverrideRowView = {
  say: string;
  italic: string;
  why: string;
  amount: string;
};

export type NonceSequence = {
  nonce: bigint;
  asked: bigint | null;
  refused: boolean;
  waived: boolean;
  paid: boolean;
  reason: number | null;
};

// A rule's per-payment max is fixed when the rule opens, and the program only lets a
// payment above it through under the owner's one-time override for that request.
export function paidAboveLimit(amount: bigint, perTxMax: bigint | null | undefined): boolean {
  return perTxMax != null && amount > perTxMax;
}

export function overrideOfferForReason(reason: number, suggestedOverride: bigint): OverrideOffer {
  if (reason === REASON_OVER_CAP) {
    return { offer: false, why: CAP_OVERRIDE_REFUSAL };
  }
  if (reason === REASON_OVER_PER_TX_MAX && suggestedOverride <= 0n) {
    return { offer: false, why: CAP_OVERRIDE_REFUSAL };
  }
  if (reason === REASON_OVER_PER_TX_MAX && suggestedOverride > 0n) {
    return { offer: true, amount: suggestedOverride };
  }
  return {
    offer: false,
    why: `The program records no one-time allowance for this reason (${ownerReasonText(reason)}).`,
  };
}

export function overrideGuard(
  mandate: MandateAccount,
  nonce: bigint,
  amount: bigint,
  nowSec?: bigint,
): OverrideGuard {
  if (nonce === 0n) {
    return { ok: false, why: 'This row has no request number. The program will not accept a one-time allowance.' };
  }
  if (amount === 0n) {
    return {
      ok: false,
      why: 'This row has no allowance amount. The program will not accept a one-time allowance.',
    };
  }
  if (mandate.status === STATUS_REVOKED) {
    return {
      ok: false,
      why: 'This rule is revoked on chain. A one-time allowance cannot be granted.',
    };
  }
  if (mandate.status === STATUS_EXHAUSTED) {
    return {
      ok: false,
      why: `This rule is exhausted on chain. ${CAP_OVERRIDE_REFUSAL}`,
    };
  }
  if (mandate.status !== STATUS_ACTIVE) {
    return {
      ok: false,
      why: `This rule is ${statusName(mandate.status)} on chain. A one-time allowance cannot be granted.`,
    };
  }
  if (nowSec !== undefined && !isActive(mandate, nowSec)) {
    return {
      ok: false,
      why: 'This rule has passed its expiry. This app will not offer a one-time allowance because it cannot make an expired payment valid.',
    };
  }
  if (nonce <= mandate.lastNonce) {
    return {
      ok: false,
      why: 'This request is already settled on chain. A one-time allowance cannot be granted.',
    };
  }
  const remaining = mandateRemaining(mandate);
  if (amount > remaining) {
    return {
      ok: false,
      why: `The remaining cap is now below this amount. ${CAP_OVERRIDE_REFUSAL}`,
    };
  }
  return { ok: true };
}

export function overrideCommitCopy(args: {
  amount: bigint;
  nonce: bigint;
  perTxMax: bigint;
  remaining: bigint;
  cap: bigint;
  decimals: number;
  mint?: string | null;
  pendingOtherNonce?: bigint;
}): OverrideCommit {
  const amount = formatTokenAmount(args.amount, args.decimals, args.mint);
  const perTxMax = formatTokenAmount(args.perTxMax, args.decimals, args.mint);
  const remaining = formatTokenAmount(args.remaining, args.decimals, args.mint);
  const cap = formatTokenAmount(args.cap, args.decimals, args.mint);
  const paragraphs = [
    `You are about to allow this payment once, for ${amount}.`,
    `The per-payment maximum on this rule is ${perTxMax}. It does not change. This one-time allowance covers this one payment of ${amount}, used once, never above the remaining cap (${remaining} remaining of ${cap}). The payee and expiry rules still apply. ${CAP_OVERRIDE_REFUSAL}`,
    'This is written to the ledger as a one-time allowance, a recorded decision. It is not a settings change.',
    'The owner signs once. The agent can then retry this request.',
  ];
  if (args.pendingOtherNonce != null && args.pendingOtherNonce !== 0n) {
    paragraphs.splice(
      2,
      0,
      `This replaces the pending one-time allowance for request ${args.pendingOtherNonce.toString()}.`,
    );
  }
  return {
    title: 'Allow this payment once',
    amount,
    nonce: args.nonce.toString(),
    paragraphs,
  };
}

export function assessOverride(args: {
  row: OverrideSource;
  mandate: MandateAccount;
  decimals: number;
  nowSec?: bigint;
}): OverrideAssessment {
  if (args.row.kind !== KIND_REFUSED) {
    return {
      status: 'none',
      why: 'A one-time allowance is granted from a refused decision, not from this row.',
    };
  }
  const offer = overrideOfferForReason(args.row.reason, args.row.suggestedOverride);
  if (!offer.offer) {
    return { status: 'none', why: offer.why };
  }
  const guard = overrideGuard(args.mandate, args.row.nonce, offer.amount, args.nowSec);
  if (!guard.ok) {
    return { status: 'blocked', why: guard.why };
  }
  if (args.mandate.overrideNonce === args.row.nonce && args.mandate.overrideAmount > 0n) {
    const amount = formatTokenAmount(args.mandate.overrideAmount, args.decimals, args.mandate.mint);
    return {
      status: 'already',
      amount: args.mandate.overrideAmount,
      nonce: args.row.nonce,
      why: `This request already has a one-time allowance of ${amount} on chain. The agent can retry it.`,
    };
  }
  const pending =
    args.mandate.overrideNonce !== 0n && args.mandate.overrideNonce !== args.row.nonce
      ? args.mandate.overrideNonce
      : undefined;
  return {
    status: 'ready',
    amount: offer.amount,
    nonce: args.row.nonce,
    commit: overrideCommitCopy({
      amount: offer.amount,
      nonce: args.row.nonce,
      perTxMax: args.mandate.perTxMax,
      remaining: mandateRemaining(args.mandate),
      cap: args.mandate.cap,
      decimals: args.decimals,
      mint: args.mandate.mint,
      pendingOtherNonce: pending,
    }),
  };
}

export type OverrideProbeRow = {
  ts: bigint;
  kind: number;
  nonce: bigint;
  reason: number;
  suggestedOverride: bigint;
};

export function overrideRowProbeKey(row: OverrideProbeRow): string {
  return `${row.ts.toString()}:${row.kind}:${row.nonce.toString()}:${row.reason}:${row.suggestedOverride.toString()}`;
}

export function overrideMandateProbeKey(mandate: MandateAccount, nowSec?: bigint): string {
  const clock = nowSec === undefined ? '' : isActive(mandate, nowSec) ? 'live' : 'expired';
  return `${mandate.address}:${mandate.status}:${mandate.lastNonce.toString()}:${mandate.overrideNonce.toString()}:${mandate.spent.toString()}:${clock}`;
}

export function overrideProbeKey(
  row: OverrideProbeRow,
  mandate: MandateAccount,
  nowSec?: bigint,
): string {
  return `${overrideRowProbeKey(row)}|${overrideMandateProbeKey(mandate, nowSec)}`;
}

export function overrideProbeIsCurrent(
  currentKey: string | null | undefined,
  nextKey: string,
): boolean {
  return currentKey === nextKey;
}

export function overrideRowView(
  row: OverrideSource,
  decimals: number,
  mint?: string | null,
): OverrideRowView {
  const amount = formatTokenAmount(row.amount, decimals, mint);
  return {
    say: 'Waived',
    italic: 'by the owner',
    why: `You allowed this one payment of ${amount}. This is a recorded decision, not a settings change. It allows this one payment, used once, never above the remaining cap. The per-payment maximum does not change. The total cap is unchanged.`,
    amount,
  };
}

export function nonceSequence<T extends OverrideSource>(
  rows: readonly T[],
  nonce: bigint,
): NonceSequence {
  let asked: bigint | null = null;
  let refused = false;
  let waived = false;
  let paid = false;
  let reason: number | null = null;
  for (const row of rows) {
    if (row.nonce !== nonce) {
      continue;
    }
    if (row.kind === KIND_REFUSED) {
      refused = true;
      asked = row.amount;
      reason = row.reason;
    } else if (row.kind === KIND_OVERRIDE) {
      waived = true;
      if (asked == null) {
        asked = row.amount;
      }
    } else if (row.kind === KIND_PAID) {
      paid = true;
      if (asked == null) {
        asked = row.amount;
      }
    }
  }
  return { nonce, asked, refused, waived, paid, reason };
}

export function sequenceLine(seq: NonceSequence, decimals: number, mint?: string | null): string | null {
  const steps = Number(seq.refused) + Number(seq.waived) + Number(seq.paid);
  if (steps < 2) {
    return null;
  }
  const parts: string[] = [];
  if (seq.asked != null) {
    parts.push(`Asked for ${formatTokenAmount(seq.asked, decimals, mint)}.`);
  }
  if (seq.refused) {
    const why = seq.reason != null ? ` (${ownerReasonText(seq.reason)})` : '';
    parts.push(`Refused${why}.`);
  }
  if (seq.waived) {
    parts.push('Waived by the owner.');
  }
  if (seq.paid) {
    parts.push('Then paid.');
  } else if (seq.waived) {
    parts.push('The agent can retry this request.');
  }
  return parts.join(' ');
}
