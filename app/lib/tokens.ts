import { formatBaseUnits, formatDisplayAmount } from './format';

function shortenMint(mint: string): string {
  if (mint.length <= 8) {
    return mint;
  }
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

/** Devnet demo mint. Name and symbol are the on-chain metadata for this mint. */
export const VTEST_MINT = '2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU';

/** Wrapped SOL, distinct from the native SOL used for fees. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Second devnet mint. The repo records the address and does not give it a symbol,
 * so the app shows the shortened address.
 */
export const SECOND_DEVNET_MINT = 'Dcbba8YzbTXM1HQ9EeHW7M21T1Ce5PiBsY1Bpxx5K3Kq';

export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';

export const VTEST_DEVNET_NOTE = 'VTEST is a devnet test token with no value.';
export const USDC_DEVNET_NOTE = "USDC on devnet is Circle's test token. It has no value.";

export type KnownToken = {
  mint: string;
  symbol: string;
  name: string;
};

export const KNOWN_TOKENS: readonly KnownToken[] = [
  { mint: WSOL_MINT, symbol: 'wrapped SOL', name: 'Wrapped SOL' },
  { mint: VTEST_MINT, symbol: 'VTEST', name: 'Veto test token' },
  { mint: DEVNET_USDC_MINT, symbol: 'USDC', name: 'Devnet USDC' },
  { mint: MAINNET_USDC_MINT, symbol: 'USDC', name: 'USDC' },
  { mint: SKR_MINT, symbol: 'SKR', name: 'SKR' },
];

const byMint = new Map(KNOWN_TOKENS.map((row) => [row.mint, row]));

export function knownToken(mint: string | null | undefined): KnownToken | null {
  const key = mint?.trim() ?? '';
  if (!key) {
    return null;
  }
  return byMint.get(key) ?? null;
}

/** Symbol when the mint is known. Shortened mint otherwise. Never a guessed ticker. */
export function tokenSymbol(mint: string | null | undefined): string {
  const key = mint?.trim() ?? '';
  if (!key) {
    return '';
  }
  const known = byMint.get(key);
  if (known) {
    return known.symbol;
  }
  return shortenMint(key);
}

export function tokenName(mint: string | null | undefined): string | null {
  return knownToken(mint)?.name ?? null;
}

export function withToken(amount: string, mint: string | null | undefined): string {
  const symbol = tokenSymbol(mint);
  if (!symbol || amount.length === 0) {
    return amount;
  }
  if (amount.endsWith(` ${symbol}`)) {
    return amount;
  }
  return `${amount} ${symbol}`;
}

export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  mint: string | null | undefined,
): string {
  return withToken(formatBaseUnits(amount, decimals), mint);
}

export function formatTokenDisplay(
  amount: bigint,
  decimals: number,
  mint: string | null | undefined,
): string {
  return withToken(formatDisplayAmount(amount, decimals, mint?.trim() === WSOL_MINT ? 4 : 2), mint);
}

/** One plain line on devnet, for VTEST or Circle's devnet USDC. Null for every other mint and cluster. */
export function devnetTestTokenNote(
  mint: string | null | undefined,
  cluster: string | null | undefined,
): string | null {
  if ((cluster ?? '').trim() !== 'devnet') {
    return null;
  }
  const key = (mint ?? '').trim();
  if (key === VTEST_MINT) {
    return VTEST_DEVNET_NOTE;
  }
  if (key === DEVNET_USDC_MINT) {
    return USDC_DEVNET_NOTE;
  }
  return null;
}

/** How many rules use each token. Amounts stay on each rule. */
export function rulesTokenSummary(mints: readonly string[]): string | null {
  const present = mints.map((mint) => mint.trim()).filter((mint) => mint.length > 0);
  if (present.length === 0) {
    return null;
  }
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const mint of present) {
    if (!counts.has(mint)) {
      order.push(mint);
    }
    counts.set(mint, (counts.get(mint) ?? 0) + 1);
  }
  if (order.length === 1) {
    const symbol = tokenSymbol(order[0]);
    const count = present.length;
    return count === 1 ? `This rule uses ${symbol}.` : `All ${count} rules use ${symbol}.`;
  }
  const parts = order.map((mint) => {
    const count = counts.get(mint) ?? 0;
    const symbol = tokenSymbol(mint);
    return count === 1 ? `1 rule in ${symbol}` : `${count} rules in ${symbol}`;
  });
  return `${parts.join('. ')}.`;
}


/** Real SKR warning for the contained mainnet preview. */
export function mainnetPreviewNote(
  mint: string | null | undefined,
  cluster: string | null | undefined,
): string | null {
  return mint?.trim() === SKR_MINT && cluster?.trim() === 'mainnet-beta'
    ? 'Mainnet preview. Real SKR. Small caps on purpose.'
    : null;
}
