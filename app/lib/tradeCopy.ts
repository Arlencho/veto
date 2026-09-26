import {
  KIND_PAID,
  KIND_REFUSED,
  REASON_OUTPUT_ACCOUNT_NOT_ALLOWED,
  REASON_OVER_PER_TX_MAX,
  REASON_POOL_NOT_ALLOWED,
  reasonText,
} from './constants';
import { formatTokenAmount, formatTokenDisplay } from './tokens';
import { truncateAddress } from './wallet';

export function tradeWorstCase(dailyLimitLabel: string): string {
  return `At most ${dailyLimitLabel} can go into the pool in a day, at no worse than your floor, until the cap is gone. The bot can still trade badly inside that line.`;
}

export function tradeDecisionDetail(args: {
  amountIn: bigint;
  amountOut?: bigint | null;
  inDecimals: number;
  outDecimals: number;
  inMint: string | null | undefined;
  outMint?: string | null;
  perTradeMax: bigint;
}): string {
  const sold = formatTokenAmount(args.amountIn, args.inDecimals, args.inMint);
  const limit = formatTokenAmount(args.perTradeMax, args.inDecimals, args.inMint);
  if (args.amountOut != null && args.outMint) {
    const bought = formatTokenAmount(args.amountOut, args.outDecimals, args.outMint);
    return `Traded ${sold} for ${bought}, under ${limit} per trade.`;
  }
  return `${sold}, under ${limit} per trade.`;
}

export function tradeDecisionTitle(args: {
  kind: number;
  amountIn: bigint;
  amountOut: bigint;
  inDecimals: number;
  outDecimals: number;
  inMint: string | null | undefined;
  outMint: string | null | undefined;
  reason: number;
  counterparty: string;
  perTradeMax?: bigint;
  amounts?: 'exact' | 'display';
}): string {
  const format = args.amounts === 'display' ? formatTokenDisplay : formatTokenAmount;
  const sold = format(args.amountIn, args.inDecimals, args.inMint);
  const bought = format(args.amountOut, args.outDecimals, args.outMint);
  if (args.kind === KIND_PAID) {
    return `Traded ${sold} for ${bought}`;
  }
  if (args.kind !== KIND_REFUSED) {
    return 'Decision';
  }
  if (
    args.reason === REASON_OUTPUT_ACCOUNT_NOT_ALLOWED ||
    args.reason === REASON_POOL_NOT_ALLOWED
  ) {
    const tried = truncateAddress(args.counterparty);
    const label = args.reason === REASON_POOL_NOT_ALLOWED ? 'pool account not allowed' : reasonText(args.reason);
    return `Refused: ${label} (tried ${tried})`;
  }
  if (args.reason === REASON_OVER_PER_TX_MAX && args.perTradeMax != null) {
    const limit = format(args.perTradeMax, args.inDecimals, args.inMint);
    return `Refused: your agent asked ${sold}, your limit is ${limit} per trade`;
  }
  return `Refused: ${reasonText(args.reason)} (${sold})`;
}
