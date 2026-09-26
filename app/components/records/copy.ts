import { KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import { KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX } from '../../lib/constants';
import { formatClock, formatDayHeading, formatUnix, roundShownAmounts } from '../../lib/format';
import { formatTokenAmount } from '../../lib/tokens';
import { overrideRowView } from '../../lib/override';
import { refusalWhyLine } from '../../lib/reasons';
import type { LedgerRow } from '../../lib/ring';
import { tradeDecisionTitle } from '../../lib/tradeCopy';
import { payeeLabel } from '../../lib/wallet';

export type RowTone = 'paid' | 'refused' | 'allowed' | 'advisory';

export type DecisionFace = {
  tone: RowTone;
  badge: string | null;
  title: string;
  detail: string;
  figure: string;
  when: string;
  chainLink: string | null;
};

export type DecisionFaceOptions = {
  payee?: string;
  amounts?: 'screen' | 'exact';
  mint?: string | null;
};

const CHAIN_LINK = 'See it on the blockchain';
const CHAIN_SAVED = 'Saved on the blockchain.';

const DAY_MS = 86_400_000;

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function relativeDay(ts: bigint, nowMs: number | undefined): string {
  if (nowMs == null) {
    return formatDayHeading(ts);
  }
  const then = new Date(Number(ts) * 1000);
  const now = new Date(nowMs);
  if (Number.isNaN(then.getTime()) || Number.isNaN(now.getTime())) {
    return formatDayHeading(ts);
  }
  const days = Math.round((dayStart(now) - dayStart(then)) / DAY_MS);
  if (days === 0) {
    return 'Today';
  }
  if (days === 1) {
    return 'Yesterday';
  }
  return formatDayHeading(ts);
}

export function decisionWhen(ts: bigint, nowMs: number | undefined): string {
  const day = relativeDay(ts, nowMs);
  const clock = formatClock(ts);
  if (day === 'Today') {
    return `Today at ${clock}`;
  }
  if (day === 'Yesterday') {
    return `Yesterday ${clock}`;
  }
  return formatUnix(ts);
}

export function rowWhen(ts: bigint, nowMs: number | undefined): string {
  const day = relativeDay(ts, nowMs);
  const clock = formatClock(ts);
  if (day === 'Today') {
    return clock;
  }
  if (day === 'Yesterday') {
    return `Yesterday ${clock}`;
  }
  return day;
}

export function clusterPillLabel(cluster: string | null | undefined): string {
  const raw = cluster?.trim() || 'devnet';
  if (raw === 'mainnet-beta') {
    return 'Mainnet';
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function refusedTitle(args: {
  amount: bigint;
  decimals: number;
  perTxMax?: bigint;
  reason: number;
  suggestedOverride: bigint;
  mint?: string | null;
}): string {
  if (args.reason === REASON_OVER_PER_TX_MAX && args.perTxMax != null) {
    const asked = formatTokenAmount(args.amount, args.decimals, args.mint);
    const limit = formatTokenAmount(args.perTxMax, args.decimals, args.mint);
    return `Refused: your agent asked ${asked}, your limit is ${limit} per payment`;
  }
  const why = refusalWhyLine({
    reason: args.reason,
    amount: args.amount,
    suggestedOverride: args.suggestedOverride,
    decimals: args.decimals,
    perTxMax: args.perTxMax,
    mint: args.mint,
  }).replace(/\.$/, '');
  return `Refused: ${why}`;
}

function chainCopy(lead: string, signature: string | null | undefined): { detail: string; chainLink: string | null } {
  if (signature) {
    return { detail: lead, chainLink: CHAIN_LINK };
  }
  if (lead.includes('Saved on the blockchain')) {
    return { detail: lead, chainLink: null };
  }
  const detail = lead.length > 0 ? `${lead} ${CHAIN_SAVED}` : CHAIN_SAVED;
  return { detail, chainLink: null };
}

export function decisionFace(
  row: LedgerRow,
  decimals: number,
  perTxMax: bigint | undefined,
  nowMs: number | undefined,
  options?: DecisionFaceOptions,
): DecisionFace {
  const when = rowWhen(row.ts, nowMs);
  const screen = options?.amounts !== 'exact';
  const mint = options?.mint;
  let face: DecisionFace;
  if (row.kind === KIND_ADVISORY_DECLINE) {
    const amount = formatTokenAmount(row.amount, decimals, mint);
    const reason = row.reasonText.trim();
    const chain = chainCopy('Not a refusal by the rule. Your agent signed this note itself.', row.signature);
    face = {
      tone: 'advisory',
      badge: "Your agent's own note",
      title: reason.length > 0 ? `Your agent declined on its own: ${reason}` : 'Your agent declined on its own',
      detail: chain.detail,
      figure: amount,
      when,
      chainLink: chain.chainLink,
    };
  } else if (row.kind === KIND_REFUSED && row.family === 'trade') {
    const chain = chainCopy(
      row.signature ? 'No money moved. Reason saved on the blockchain.' : 'No money moved.',
      row.signature,
    );
    const outDecimals = row.outDecimals ?? decimals;
    face = {
      tone: 'refused',
      badge: null,
      title: tradeDecisionTitle({
        amounts: screen ? 'display' : 'exact',
        kind: row.kind,
        amountIn: row.amount,
        amountOut: row.amountOut ?? 0n,
        inDecimals: decimals,
        outDecimals,
        inMint: mint,
        outMint: row.outMint,
        reason: row.reason,
        counterparty: row.counterparty,
        perTradeMax: perTxMax,
      }),
      detail: chain.detail,
      figure: formatTokenAmount(0n, decimals, mint),
      when,
      chainLink: chain.chainLink,
    };
  } else if (row.kind === KIND_REFUSED) {
    const chain = chainCopy(
      row.signature ? 'No money moved. Reason saved on the blockchain.' : 'No money moved.',
      row.signature,
    );
    face = {
      tone: 'refused',
      badge: null,
      title: refusedTitle({
        amount: row.amount,
        decimals,
        perTxMax,
        reason: row.reason,
        suggestedOverride: row.suggestedOverride,
        mint,
      }),
      detail: chain.detail,
      figure: formatTokenAmount(0n, decimals, mint),
      when,
      chainLink: chain.chainLink,
    };
  } else if (row.kind === KIND_OVERRIDE) {
    const view = overrideRowView(row, decimals, mint);
    const chain = chainCopy(view.why, row.signature);
    face = {
      tone: 'allowed',
      badge: null,
      title: `Allowed once: this payment of ${view.amount}`,
      detail: chain.detail,
      figure: view.amount,
      when,
      chainLink: chain.chainLink,
    };
  } else if (row.kind === KIND_PAID && row.family === 'trade') {
    const outDecimals = row.outDecimals ?? decimals;
    const title = tradeDecisionTitle({
      amounts: screen ? 'display' : 'exact',
      kind: row.kind,
      amountIn: row.amount,
      amountOut: row.amountOut ?? 0n,
      inDecimals: decimals,
      outDecimals,
      inMint: mint,
      outMint: row.outMint,
      reason: row.reason,
      counterparty: row.counterparty,
      perTradeMax: perTxMax,
    });
    const limit = perTxMax != null ? formatTokenAmount(perTxMax, decimals, mint) : null;
    const inside = limit != null ? `Inside your limit of ${limit} per trade.` : 'Inside the rule.';
    const chain = chainCopy(inside, row.signature);
    face = {
      tone: 'paid',
      badge: null,
      title,
      detail: chain.detail,
      figure: `-${formatTokenAmount(row.amount, decimals, mint)}`,
      when,
      chainLink: chain.chainLink,
    };
  } else if (row.kind === KIND_PAID) {
    const amount = formatTokenAmount(row.amount, decimals, mint);
    const payee = payeeLabel(options?.payee);
    const limit = perTxMax != null ? formatTokenAmount(perTxMax, decimals, mint) : null;
    const inside = limit != null ? `Inside your limit of ${limit} per payment.` : 'Inside the rule.';
    const chain = chainCopy(inside, row.signature);
    face = {
      tone: 'paid',
      badge: null,
      title: `Paid ${amount} to ${payee}`,
      detail: chain.detail,
      figure: `-${amount}`,
      when,
      chainLink: chain.chainLink,
    };
  } else {
    face = {
      tone: 'paid',
      badge: null,
      title: 'Decision',
      detail: '',
      figure: '',
      when,
      chainLink: null,
    };
  }
  if (!screen) {
    return face;
  }
  return {
    ...face,
    title: roundShownAmounts(face.title),
    detail: roundShownAmounts(face.detail),
    figure: roundShownAmounts(face.figure),
  };
}

export function refusalBody(args: {
  amount: bigint;
  decimals: number;
  perTxMax?: bigint;
  reason: number;
  suggestedOverride: bigint;
  mint?: string | null;
  unit?: 'payment' | 'trade';
}): string {
  if (args.reason === REASON_OVER_PER_TX_MAX && args.perTxMax != null) {
    const asked = formatTokenAmount(args.amount, args.decimals, args.mint);
    const limit = formatTokenAmount(args.perTxMax, args.decimals, args.mint);
    const verb = args.unit === 'trade' ? 'trade' : 'pay';
    const noun = args.unit === 'trade' ? 'trade' : 'payment';
    return `Your agent asked to ${verb} ${asked}. Your rule allows ${limit} per ${noun}, so the program refused.`;
  }
  return refusalWhyLine({
    reason: args.reason,
    amount: args.amount,
    suggestedOverride: args.suggestedOverride,
    decimals: args.decimals,
    perTxMax: args.perTxMax,
    mint: args.mint,
    unit: args.unit,
  });
}

export function whyRefused(args: {
  reason: number;
  decimals: number;
  perTxMax?: bigint;
  fallback: string;
  mint?: string | null;
  unit?: 'payment' | 'trade';
}): string {
  if (args.reason === REASON_OVER_PER_TX_MAX && args.perTxMax != null) {
    const noun = args.unit === 'trade' ? 'per-trade' : 'per-payment';
    return `Over your ${noun} limit of ${formatTokenAmount(args.perTxMax, args.decimals, args.mint)}`;
  }
  return args.fallback.replace(/\.$/, '');
}

export function barSplit(asked: bigint, limit: bigint): { allowedPct: number; overPct: number } | null {
  if (asked <= 0n || limit < 0n) {
    return null;
  }
  if (asked <= limit) {
    if (limit === 0n) {
      return { allowedPct: 0, overPct: 0 };
    }
    const allowedPct = Number((asked * 1000n) / limit) / 10;
    return { allowedPct, overPct: 0 };
  }
  const allowedPct = Number((limit * 1000n) / asked) / 10;
  const overPct = Math.max(0, Math.round((100 - allowedPct) * 10) / 10);
  return { allowedPct, overPct };
}

export function networkFoot(): string {
  const cluster = process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER?.trim() || 'devnet';
  if (cluster === 'mainnet-beta') {
    return 'You sign in Seed Vault. Veto never sees your key.';
  }
  return `You sign in Seed Vault. Veto never sees your key. This is Solana ${cluster} with no real monetary value.`;
}
