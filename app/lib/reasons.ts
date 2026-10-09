import { REASON_NOT_ACTIVE, REASON_OVER_PER_TX_MAX, ownerReasonText, reasonText } from './constants';
import { formatTokenAmount } from './tokens';

export { ownerReasonText, reasonText };

export type ReasonView = {
  reason: number;
  text: string;
  overrideLine: string | null;
};

export function renderReason(
  reason: number,
  suggestedOverride: bigint,
  decimals: number,
  mint?: string | null,
): ReasonView {
  const text = ownerReasonText(reason);
  if (reason !== REASON_OVER_PER_TX_MAX) {
    return { reason, text, overrideLine: null };
  }
  if (suggestedOverride > 0n) {
    return {
      reason,
      text,
      overrideLine: `A one-time allowance of ${formatTokenAmount(suggestedOverride, decimals, mint)} would have cleared the per-payment limit. All other checks still apply.`,
    };
  }
  return {
    reason,
    text,
    overrideLine: 'No one-time allowance would have cleared this.',
  };
}

export function refusalWhyLine(args: {
  reason: number;
  amount: bigint;
  suggestedOverride: bigint;
  decimals: number;
  perTxMax?: bigint;
  mint?: string | null;
  unit?: 'payment' | 'trade';
}): string {
  const view = renderReason(args.reason, args.suggestedOverride, args.decimals, args.mint);
  if (args.reason === REASON_OVER_PER_TX_MAX && args.perTxMax != null) {
    const amount = formatTokenAmount(args.amount, args.decimals, args.mint);
    const limit = formatTokenAmount(args.perTxMax, args.decimals, args.mint);
    const extra = view.overrideLine ? ` ${view.overrideLine}` : '';
    const noun = args.unit === 'trade' ? 'per-trade' : 'per-payment';
    return `Asked for ${amount}, over the ${limit} ${noun} maximum.${extra}`;
  }
  const extra = view.overrideLine ? ` ${view.overrideLine}` : '';
  return `${view.text}.${extra}`.trim();
}

export function notActiveHint(): string {
  return `The agent's next charge is refused with reason ${REASON_NOT_ACTIVE} (${reasonText(REASON_NOT_ACTIVE)}) and that refusal is written to the ledger.`;
}
