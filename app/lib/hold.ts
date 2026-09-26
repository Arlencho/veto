import { PublicKey } from '@solana/web3.js';

import { truncateAddress } from './wallet';
import { formatBaseUnits, parseBaseUnits } from './format';
import { tokenSymbol } from './tokens';

export const HOLD_SHARE_BPS = 2500;
export const HOLD_DAYS = [1, 2, 3] as const;
export type HoldDays = (typeof HOLD_DAYS)[number];

/** A first vault sized for 5 devnet USDC: deposit 5, everyday limit 1, wait 1 day. */
export const HOLD_SUGGESTED_DEPOSIT = '5';
export const HOLD_SUGGESTED_DAILY = '1';
export const HOLD_SUGGESTED_DAYS: HoldDays = 1;

const HOUR = 3600n;
const DAY = 86_400n;

export type HoldWaitReason = 'frozen' | 'new_address' | 'over_daily_limit' | 'over_share';

export type HoldOutlook =
  | { outcome: 'at_once' }
  | { outcome: 'held'; reasons: HoldWaitReason[]; unlockAt: bigint }
  | { outcome: 'refused'; reason: 'insufficient_funds' | 'pending_full' };

export const HOLD_KIND_OPENED = 0;
export const HOLD_KIND_DEPOSITED = 1;
export const HOLD_KIND_PAID = 2;
export const HOLD_KIND_HELD = 3;
export const HOLD_KIND_STOPPED = 4;
export const HOLD_KIND_FROZEN = 5;
export const HOLD_KIND_UNFROZEN = 6;
export const HOLD_KIND_SKIPPED = 7;
export const HOLD_KIND_RECOVERED = 8;
export const HOLD_KIND_CHANGE_PROPOSED = 9;
export const HOLD_KIND_CHANGE_APPLIED = 10;
export const HOLD_KIND_CHANGE_CANCELLED = 11;
export const HOLD_KIND_REFUSED = 12;
export const HOLD_KIND_UNFREEZE_SCHEDULED = 13;
export const HOLD_REASON_INSUFFICIENT_FUNDS = 1;
export const HOLD_REASON_PENDING_FULL = 2;

export function delaySecsForDays(days: HoldDays): bigint {
  return DAY * BigInt(days);
}

export function daysFromDelay(delaySecs: bigint): HoldDays | null {
  if (delaySecs === DAY) return 1;
  if (delaySecs === DAY * 2n) return 2;
  if (delaySecs === DAY * 3n) return 3;
  return null;
}

export function waitLabel(days: HoldDays): string {
  return days === 1 ? '1 day' : `${days} days`;
}

export function holdTokenName(_cluster: string, mint?: string | null): string {
  const named = mint?.trim() ? tokenSymbol(mint) : '';
  if (named) {
    return named;
  }
  return 'tokens';
}

export function holdNetworkPill(cluster: string): string {
  if (cluster === 'devnet') return 'Devnet, a test network';
  if (cluster === 'testnet') return 'Testnet, a test network';
  if (cluster === 'mainnet-beta') return 'Mainnet';
  return cluster;
}

export function formatHoldAmount(amount: bigint, decimals: number): string {
  const raw = formatBaseUnits(amount, decimals);
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  const [whole, frac] = body.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = frac ? `${grouped}.${frac}` : grouped;
  return negative ? `-${text}` : text;
}

export function wholeTokensToBase(text: string, decimals: number): bigint {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Use a whole number of tokens.');
  }
  return BigInt(trimmed) * 10n ** BigInt(decimals);
}

export function amountToBase(text: string, decimals: number): bigint {
  const value = parseBaseUnits(text, decimals);
  if (value <= 0n) {
    throw new Error('The amount has to be more than zero.');
  }
  return value;
}

export function stepWhole(text: string, delta: number): string {
  const current = /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0;
  const next = Math.max(0, current + delta);
  return String(next);
}

export function shortKey(address: string): string {
  return truncateAddress(address, 4);
}

export function isDefaultKey(address: string): boolean {
  try {
    return new PublicKey(address).equals(PublicKey.default);
  } catch {
    return false;
  }
}

export type Countdown = {
  days: number;
  hours: number;
  minutes: number;
  remainingSec: bigint;
  over: boolean;
  accessibilityLabel: string;
};

/** Remaining wait from the blockchain clock. `nowSec` is that clock, not the phone clock. */
export function countdownFromChain(nowSec: bigint, unlockAt: bigint): Countdown {
  if (nowSec >= unlockAt) {
    return {
      days: 0,
      hours: 0,
      minutes: 0,
      remainingSec: 0n,
      over: true,
      accessibilityLabel: 'The wait is over',
    };
  }
  const remaining = unlockAt - nowSec;
  const days = Number(remaining / DAY);
  const hours = Number((remaining % DAY) / HOUR);
  const minutes = Number((remaining % HOUR) / 60n);
  const dayWord = days === 1 ? 'day' : 'days';
  const hourWord = hours === 1 ? 'hour' : 'hours';
  const minuteWord = minutes === 1 ? 'minute' : 'minutes';
  return {
    days,
    hours,
    minutes,
    remainingSec: remaining,
    over: false,
    accessibilityLabel: `${days} ${dayWord}, ${hours} ${hourWord}, ${minutes} ${minuteWord} left`,
  };
}

export function formatChainInstant(unixSec: bigint, timeZone?: string): string {
  return formatChainParts(unixSec, timeZone, true);
}

export function formatChainClock(unixSec: bigint, timeZone?: string): string {
  return formatChainParts(unixSec, timeZone, false);
}

function formatChainParts(unixSec: bigint, timeZone: string | undefined, withDate: boolean): string {
  if (unixSec < 0n || unixSec > 8_640_000_000_000n) {
    return 'a time the phone cannot show';
  }
  const date = new Date(Number(unixSec) * 1000);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const clock = `${get('hour')}:${get('minute')}`;
  if (!withDate) return clock;
  return `${get('weekday')} ${get('day')} ${get('month')}, ${clock}`;
}

export function bigDoorTriggers(dailyLabel: string): readonly string[] {
  return [
    `More than ${dailyLabel} in one day, on its own or added up`,
    'Any amount to an address this vault has never paid',
    'More than a quarter of the vault within 24 hours',
    'Any change that loosens these rules',
  ];
}

export function waitChangeCopy(days: HoldDays): string {
  return `Making the wait longer is instant. Making it shorter later waits ${waitLabel(days)} first.`;
}

export function vaultShareText(amount: bigint, balance: bigint): string {
  if (balance <= 0n) return '0% of your vault';
  if (amount >= balance) return '100% of your vault';
  const bps = (amount * 10_000n) / balance;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const pct =
    frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, '0').replace(/0+$/, '')}`;
  return `${pct}% of your vault`;
}

export function heldReasonChips(args: {
  reasons: readonly HoldWaitReason[];
  amountLabel: string;
  dailyLabel: string;
  shareLabel: string;
}): string[] {
  const lines: string[] = [];
  for (const reason of args.reasons) {
    if (reason === 'over_daily_limit') lines.push(`${args.amountLabel} is over your ${args.dailyLabel} a day`);
    if (reason === 'new_address') lines.push('New address');
    if (reason === 'over_share') lines.push(args.shareLabel);
    if (reason === 'frozen') lines.push('The vault is frozen');
  }
  return lines;
}

export const HOLD_GONE_FALLBACK =
  'This withdrawal is no longer waiting. Nothing moves unless another request is held.';

/**
 * Empty-state line for the held screen when the withdrawal is gone. The chain
 * record for a stop does not say which key stopped it, so the stopped line
 * stays neutral.
 */
export function heldGoneCopy(
  entries: readonly { withdrawalId: bigint; kind: number }[],
  idText: string,
): string {
  if (!idText) return HOLD_GONE_FALLBACK;
  let id: bigint;
  try {
    id = BigInt(idText);
  } catch {
    return HOLD_GONE_FALLBACK;
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.withdrawalId !== id) continue;
    return entry.kind === HOLD_KIND_STOPPED ? 'Stopped. Nothing left the vault.' : HOLD_GONE_FALLBACK;
  }
  return HOLD_GONE_FALLBACK;
}

export function secondSeedVaultAccount(owner: string, accounts: readonly string[]): string | null {
  for (const account of accounts) {
    if (account.length === 0 || account === owner) continue;
    return account;
  }
  return null;
}

export function phoneKeyCopy(owner: string, phoneKey: string | null): {
  title: string;
  detail: string;
  available: boolean;
} {
  if (phoneKey) {
    return {
      title: 'A second key in Seed Vault on this phone',
      detail: `This wallet gave Veto a second account, ${shortKey(phoneKey)}. Quick. Stops a stolen everyday key or a scam signed by mistake. Not a stolen seed phrase.`,
      available: true,
    };
  }
  return {
    title: 'A second key in Seed Vault on this phone',
    detail: `This wallet gave Veto only ${shortKey(owner)}. It did not expose a second account, so a guardian key on this phone is not available. That kind of key would stop a stolen everyday key or a scam signed by mistake. It would not stop someone who has your seed phrase.`,
    available: false,
  };
}

export function seekerKeyCopy(): { title: string; detail: string } {
  return {
    title: 'Your second Seeker',
    detail:
      'A different phone with its own Seed Vault. Also protects you if someone has your seed phrase. Paste that phone\'s address. This app cannot see the other phone until you confirm there.',
  };
}

export function safeAddressCopy(days: HoldDays): string {
  return `Where Recover sends everything, at once. Changing it later waits ${waitLabel(days)}.`;
}

export function guardianRemovalCopy(days: HoldDays): string {
  return `You sign once with Seed Vault on this phone. Your key never leaves the phone. The guardian key does not sign this step. Removing it later waits ${waitLabel(days)}, so a thief cannot remove it first.`;
}

export function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export type HoldRecordLine = {
  time: string;
  title: string;
  detail: string;
  tone: 'bone' | 'stop' | 'good';
};

export function holdRecordLines(args: {
  entries: readonly {
    ts: bigint;
    amount: bigint;
    destination: string;
    kind: number;
    reason: number;
  }[];
  owner: string;
  guardian: string;
  decimals: number;
  tokenName: string;
  timeZone?: string;
}): HoldRecordLine[] {
  const lines: HoldRecordLine[] = [];
  for (let i = args.entries.length - 1; i >= 0 && lines.length < 8; i -= 1) {
    const entry = args.entries[i];
    if (!entry) continue;
    const line = recordLine(entry, args);
    if (line) lines.push(line);
  }
  return lines;
}

function recordLine(
  entry: { ts: bigint; amount: bigint; destination: string; kind: number; reason: number },
  args: {
    owner: string;
    guardian: string;
    decimals: number;
    tokenName: string;
    timeZone?: string;
  },
): HoldRecordLine | null {
  const time = formatChainClock(entry.ts, args.timeZone);
  const amount = formatHoldAmount(entry.amount, args.decimals);
  const dest = shortKey(entry.destination);
  const money = `${amount} ${args.tokenName}`;
  if (entry.kind === HOLD_KIND_HELD) {
    return {
      time,
      title: `Held: ${money} to ${dest}`,
      detail: 'Asked with your key.',
      tone: 'bone',
    };
  }
  if (entry.kind === HOLD_KIND_STOPPED) {
    return {
      time,
      title: 'Stopped',
      detail: 'No money moved. The record does not say which key stopped it.',
      tone: 'stop',
    };
  }
  if (entry.kind === HOLD_KIND_FROZEN) {
    const by =
      entry.destination === args.guardian
        ? 'your guardian key'
        : entry.destination === args.owner
          ? 'your key'
          : shortKey(entry.destination);
    return {
      time,
      title: `Vault frozen by ${by}`,
      detail: 'Every door is closed. Only Recover and Unfreeze remain.',
      tone: 'stop',
    };
  }
  if (entry.kind === HOLD_KIND_RECOVERED) {
    return {
      time,
      title: `Recovered ${money}`,
      detail: 'Sent to your safe address.',
      tone: 'good',
    };
  }
  if (entry.kind === HOLD_KIND_SKIPPED) {
    return {
      time,
      title: 'Released early by both keys',
      detail: `${money} went to ${dest}. That address is now known to this vault.`,
      tone: 'good',
    };
  }
  if (entry.kind === HOLD_KIND_PAID) {
    return {
      time,
      title: `Paid ${money} to ${dest}`,
      detail: 'On the blockchain.',
      tone: 'good',
    };
  }
  if (entry.kind === HOLD_KIND_REFUSED) {
    const why =
      entry.reason === HOLD_REASON_PENDING_FULL
        ? 'The vault was already holding as many withdrawals as it can. This one was refused, not paid.'
        : 'The vault did not hold enough. Nothing was paid.';
    return { time, title: 'Refused', detail: why, tone: 'stop' };
  }
  if (entry.kind === HOLD_KIND_UNFREEZE_SCHEDULED) {
    return {
      time,
      title: 'Unfreeze is waiting',
      detail: 'No guardian key is set, so unfreezing waits the full delay.',
      tone: 'bone',
    };
  }
  if (entry.kind === HOLD_KIND_UNFROZEN) {
    return { time, title: 'Vault unfrozen', detail: 'The doors are open again.', tone: 'good' };
  }
  return null;
}

export function frozenByLine(guardian: string, owner: string, freezer: string | null): string {
  if (!freezer) return 'Frozen';
  if (freezer === guardian && !isDefaultKey(guardian)) return 'By your guardian key';
  if (freezer === owner) return 'By your key';
  return `By ${shortKey(freezer)}`;
}

export function sendPreview(args: {
  outlook: HoldOutlook;
  chips: readonly string[];
  days: HoldDays | null;
  destinationLabel: string;
  createsAccount: boolean;
}): { headline: string; lines: string[] } {
  const lines = [...args.chips];
  if (args.createsAccount) {
    lines.push(`Signing creates the token account for ${args.destinationLabel} if it does not exist yet.`);
  }
  if (args.outlook.outcome === 'at_once') {
    return {
      headline: 'This leaves at once through the everyday door.',
      lines,
    };
  }
  if (args.outlook.outcome === 'refused' && args.outlook.reason === 'insufficient_funds') {
    return { headline: 'The vault does not hold that much.', lines };
  }
  if (args.outlook.outcome === 'refused') {
    return {
      headline: 'The vault is already holding as many withdrawals as it can. This one would be refused, not paid.',
      lines,
    };
  }
  const wait = args.days ? waitLabel(args.days) : 'the wait you chose';
  return {
    headline: `This waits ${wait}. Nothing moves until then, unless you or your guardian key stop it.`,
    lines,
  };
}
