import { KIND_ADVISORY_DECLINE } from './advisory';
import {
  KIND_OPENED,
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  REASON_ACCOUNT_FROZEN,
  REASON_DELEGATE_MISSING,
  REASON_EXPIRED,
  REASON_INSUFFICIENT_FUNDS,
  REASON_MERCHANT_NOT_ALLOWED,
  REASON_NOT_ACTIVE,
  REASON_OVER_CAP,
  REASON_OVER_PER_TX_MAX,
  REASON_STALE_NONCE,
  REASON_QUOTE_BELOW_FLOOR,
  REASON_OUTPUT_ACCOUNT_NOT_ALLOWED,
  REASON_OVER_DAILY_LIMIT,
  REASON_POOL_NOT_ALLOWED,
  REASON_ZERO_AMOUNT,
} from './constants';
import { remainingCap } from './format';
import { formatTokenDisplay } from './tokens';
import { canonicalAddress } from './ruleRequest';
import { truncateAddress } from './wallet';

export const GRADE_MIN_REQUESTS = 10;
export const GRADE_MIN_DAYS = 3;

export const GRADE_LABEL = {
  stayed: 'Stayed inside its rule',
  tested: 'Tested its limit now and then',
  pushed: 'Pushed its limit often',
  'too-new': 'Too new to grade',
} as const;

export const GRADE_RULE = {
  stayed: 'Fewer than 1 request in 20 outside its rule.',
  tested: '1 to 4 requests in 20 outside its rule.',
  pushed: 'More than 4 requests in 20 outside its rule.',
  'too-new':
    'Fewer than 10 requests, or fewer than 3 days running. The facts still show; the label waits.',
} as const;

export type GradeId = 'too-new' | 'stayed' | 'tested' | 'pushed';
export type GradedBand = Exclude<GradeId, 'too-new'>;

export type GradeDecision = {
  kind: number;
  ts: bigint;
  amount: bigint;
  nonce: bigint;
  reason: number;
  counterparty: string;
};

export type RuleFacts = {
  address: string;
  agent: string;
  purpose: string;
  cap: bigint;
  spent: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  status: number;
  decimals: number;
  /** Mandate mint. Amounts name this token. */
  mint?: string;
  /** Payee wallet on the rule. A charge's counterparty is that wallet's token account. */
  merchant?: string;
  rows: readonly GradeDecision[];
};

export type ClassifiedRule = {
  paidInside: GradeDecision[];
  refused: GradeDecision[];
  allowances: GradeDecision[];
  settlements: GradeDecision[];
  declines: GradeDecision[];
  openedAt: bigint | null;
};

export type Grade = {
  id: GradeId;
  label: string;
  requests: number;
  outside: number;
  paid: number;
  allowances: number;
  declines: number;
  daysRunning: number | null;
  band: GradedBand | null;
  steppedDown: boolean;
  /** Always 0. The rule makes money moved outside it impossible, so it is never credit. */
  movedOutside: 0;
};

export type RequestTick = {
  kind: 'paid' | 'refused';
  ts: bigint;
};

export type ReasonTally = {
  reason: number;
  ruleAddress: string;
  label: string;
  count: number;
};

export type RuleSnapshot = RuleFacts & {
  shortAddress: string;
  remainingLabel: string;
  capLabel: string;
  spentLabel: string;
  perTxMaxLabel: string;
  remainingRatio: number;
  day: number | null;
  totalDays: number | null;
  dayLabel: string;
  startedAt: bigint | null;
  classified: ClassifiedRule;
};

export type SpendLine = {
  remainingLabel: string;
  capLabel: string;
  ratio: number;
  sentence: string;
};

export type AgentRecord = {
  agent: string;
  name: string;
  shortAddress: string;
  grade: Grade;
  cardLine: string;
  recordLine: string;
  rules: RuleSnapshot[];
  ticks: RequestTick[];
  tickLabel: string;
  reasons: ReasonTally[];
  spend: SpendLine | null;
  daysValue: string;
  daysCaption: string;
  named: boolean;
};

const BANDS: readonly GradedBand[] = ['stayed', 'tested', 'pushed'];

const RECORD_BAND: Record<GradedBand, string> = {
  stayed: 'fewer than 1 request in 20 outside the rule',
  tested: '1 to 4 requests in 20 outside the rule',
  pushed: 'more than 4 requests in 20 outside the rule',
};

export function elapsedDays(startedAt: bigint, nowSec: bigint): number {
  if (nowSec <= startedAt) {
    return 1;
  }
  const whole = (nowSec - startedAt) / 86400n;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER) - 1n) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(whole) + 1;
}

export function ruleTotalDays(startedAt: bigint | null, expiresAt: bigint): number | null {
  if (startedAt == null || expiresAt <= startedAt) {
    return null;
  }
  const span = expiresAt - startedAt;
  const total = (span + 86399n) / 86400n;
  if (total <= 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(total);
}

export function ruleDayNumber(
  startedAt: bigint | null,
  expiresAt: bigint,
  nowSec: bigint,
): number | null {
  if (startedAt == null) {
    return null;
  }
  const running = elapsedDays(startedAt, nowSec);
  const total = ruleTotalDays(startedAt, expiresAt);
  if (total == null) {
    return running;
  }
  if (nowSec >= expiresAt) {
    return total;
  }
  return Math.min(running, total);
}

export function openedAtOf(rows: readonly GradeDecision[]): bigint | null {
  let opened: bigint | null = null;
  for (const row of rows) {
    if (row.kind !== KIND_OPENED || row.ts <= 0n) {
      continue;
    }
    if (opened == null || row.ts < opened) {
      opened = row.ts;
    }
  }
  return opened;
}

type CountedRule = ClassifiedRule & { outsideFromMissingRefusal: GradeDecision[] };

function countRule(rows: readonly GradeDecision[]): CountedRule {
  const allowances = rows.filter((row) => row.kind === KIND_OVERRIDE);
  const refused = rows.filter((row) => row.kind === KIND_REFUSED);
  const allowanceNonces = new Set(allowances.map((row) => row.nonce));
  const refusalNonces = new Set(refused.map((row) => row.nonce));
  const paidInside: GradeDecision[] = [];
  const settlements: GradeDecision[] = [];
  for (const row of rows) {
    if (row.kind !== KIND_PAID) {
      continue;
    }
    if (allowanceNonces.has(row.nonce)) {
      settlements.push(row);
    } else {
      paidInside.push(row);
    }
  }
  return {
    paidInside,
    refused,
    allowances,
    settlements,
    declines: rows.filter((row) => row.kind === KIND_ADVISORY_DECLINE),
    openedAt: openedAtOf(rows),
    outsideFromMissingRefusal: allowances.filter((row) => !refusalNonces.has(row.nonce)),
  };
}

export function classifyRule(rows: readonly GradeDecision[]): ClassifiedRule {
  const counted = countRule(rows);
  return {
    paidInside: counted.paidInside,
    refused: counted.refused,
    allowances: counted.allowances,
    settlements: counted.settlements,
    declines: counted.declines,
    openedAt: counted.openedAt,
  };
}

export function daysForRules(rules: readonly { rows: readonly GradeDecision[] }[], nowSec: bigint): number | null {
  let earliestOpen: bigint | null = null;
  let earliestStamp: bigint | null = null;
  for (const rule of rules) {
    const opened = openedAtOf(rule.rows);
    if (opened != null && (earliestOpen == null || opened < earliestOpen)) {
      earliestOpen = opened;
    }
    for (const row of rule.rows) {
      if (row.ts <= 0n) {
        continue;
      }
      if (earliestStamp == null || row.ts < earliestStamp) {
        earliestStamp = row.ts;
      }
    }
  }
  if (earliestOpen != null) {
    return elapsedDays(earliestOpen, nowSec);
  }
  if (earliestStamp == null) {
    return null;
  }
  const span = elapsedDays(earliestStamp, nowSec);
  return span >= GRADE_MIN_DAYS ? span : null;
}

function bandFor(outside: number, requests: number): GradedBand {
  if (outside * 20 < requests) {
    return 'stayed';
  }
  if (outside * 20 <= requests * 4) {
    return 'tested';
  }
  return 'pushed';
}

function stepDown(band: GradedBand, allowances: number): { id: GradedBand; steppedDown: boolean } {
  if (allowances < 2) {
    return { id: band, steppedDown: false };
  }
  const index = BANDS.indexOf(band);
  const next = BANDS[Math.min(index + 1, BANDS.length - 1)] ?? band;
  return { id: next, steppedDown: next !== band };
}

export function gradeRules(rules: readonly { rows: readonly GradeDecision[] }[], nowSec: bigint): Grade {
  let paid = 0;
  let outside = 0;
  let allowances = 0;
  let declines = 0;
  for (const rule of rules) {
    const facts = countRule(rule.rows);
    paid += facts.paidInside.length;
    outside += facts.refused.length + facts.outsideFromMissingRefusal.length;
    allowances += facts.allowances.length;
    declines += facts.declines.length;
  }
  const requests = paid + outside;
  const daysRunning = daysForRules(rules, nowSec);
  const movedOutside = 0 as const;
  if (requests < GRADE_MIN_REQUESTS || daysRunning == null || daysRunning < GRADE_MIN_DAYS) {
    return {
      id: 'too-new',
      label: GRADE_LABEL['too-new'],
      requests,
      outside,
      paid,
      allowances,
      declines,
      daysRunning,
      band: null,
      steppedDown: false,
      movedOutside,
    };
  }
  const band = bandFor(outside, requests);
  const stepped = stepDown(band, allowances);
  return {
    id: stepped.id,
    label: GRADE_LABEL[stepped.id],
    requests,
    outside,
    paid,
    allowances,
    declines,
    daysRunning,
    band,
    steppedDown: stepped.steppedDown,
    movedOutside,
  };
}

export function gradeCardLine(grade: Grade): string {
  if (grade.id === 'too-new') {
    const requests = `${grade.requests} of the 10 requests needed`;
    const days =
      grade.daysRunning == null
        ? 'the start is not on the record, so the day count waits'
        : `day ${grade.daysRunning} of the 3 needed`;
    return `${requests}, ${days}.`;
  }
  const head = `${grade.outside} of its ${grade.requests} requests outside its rule.`;
  if (grade.outside === 0 && grade.allowances === 0) {
    return head;
  }
  let tail = 'All refused.';
  if (grade.allowances === 1) {
    tail = 'Allowed once.';
  } else if (grade.allowances > 1) {
    tail = `Allowed ${grade.allowances} times.`;
  }
  if (grade.steppedDown) {
    tail = `${tail} The allowances move the grade one step lower.`;
  }
  return `${head} ${tail}`;
}

export function gradeRecordLine(grade: Grade): string {
  if (grade.id === 'too-new') {
    return `${gradeCardLine(grade)} The facts still show; the label waits.`;
  }
  const rule = RECORD_BAND[grade.id];
  let tail = `, all ${grade.outside} refused`;
  if (grade.allowances === 1) {
    tail = ', allowed once';
  } else if (grade.allowances > 1) {
    tail = `, allowed ${grade.allowances} times`;
  } else if (grade.outside === 0) {
    tail = '';
  }
  const step = grade.steppedDown ? ' Two or more allowances move it one step lower.' : '';
  return `Its rule: ${rule}. This agent: ${grade.outside} of ${grade.requests}${tail}.${step}`;
}

export function requestTicks(rows: readonly GradeDecision[]): RequestTick[] {
  const facts = countRule(rows);
  const ticks: RequestTick[] = [
    ...facts.paidInside.map((row) => ({ kind: 'paid' as const, ts: row.ts })),
    ...facts.refused.map((row) => ({ kind: 'refused' as const, ts: row.ts })),
    ...facts.outsideFromMissingRefusal.map((row) => ({ kind: 'refused' as const, ts: row.ts })),
  ];
  ticks.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return ticks;
}

export function tickLabel(ticks: readonly RequestTick[]): string {
  if (ticks.length === 0) {
    return 'No requests on the record yet.';
  }
  const words = ticks.map((tick) => (tick.kind === 'paid' ? 'paid' : 'refused')).join(', ');
  return `${ticks.length} requests, oldest to newest: ${words}.`;
}

export function recordReasonTitle(reason: number, perTxMaxLabel: string): string {
  switch (reason) {
    case REASON_OVER_PER_TX_MAX:
      return `Over your limit of ${perTxMaxLabel} per payment`;
    case REASON_OVER_CAP:
      return 'Over what this rule has left';
    case REASON_MERCHANT_NOT_ALLOWED:
      return 'A payee this rule does not name';
    case REASON_EXPIRED:
      return 'After this rule ended';
    case REASON_NOT_ACTIVE:
      return 'While this rule was not active';
    case REASON_STALE_NONCE:
      return 'A payment already settled';
    case REASON_DELEGATE_MISSING:
      return 'After the permission was withdrawn';
    case REASON_INSUFFICIENT_FUNDS:
      return 'More than the wallet could pay';
    case REASON_ZERO_AMOUNT:
      return 'A payment of nothing';
    case REASON_ACCOUNT_FROZEN:
      return 'While an account was frozen';
    case REASON_OUTPUT_ACCOUNT_NOT_ALLOWED:
      return 'An output account this rule does not allow';
    case REASON_POOL_NOT_ALLOWED:
      return 'A pool account this rule does not allow';
    case REASON_OVER_DAILY_LIMIT:
      return 'Over the daily limit';
    case REASON_QUOTE_BELOW_FLOOR:
      return 'Below the price floor';
    default:
      return 'A reason saved on the record';
  }
}

export function weekReasonTitle(reason: number, perTxMaxLabel: string): string {
  switch (reason) {
    case REASON_OVER_PER_TX_MAX:
      return `Asked more than ${perTxMaxLabel} per payment`;
    case REASON_OVER_CAP:
      return 'Asked more than this rule has left';
    case REASON_MERCHANT_NOT_ALLOWED:
      return 'Asked a payee this rule does not name';
    case REASON_EXPIRED:
      return 'Asked after this rule ended';
    case REASON_NOT_ACTIVE:
      return 'Asked while this rule was not active';
    case REASON_STALE_NONCE:
      return 'Asked to repeat a payment already settled';
    case REASON_DELEGATE_MISSING:
      return 'Asked after the permission was withdrawn';
    case REASON_INSUFFICIENT_FUNDS:
      return 'Asked more than the wallet could pay';
    case REASON_ZERO_AMOUNT:
      return 'Asked to pay nothing';
    case REASON_ACCOUNT_FROZEN:
      return 'Asked while an account was frozen';
    case REASON_OUTPUT_ACCOUNT_NOT_ALLOWED:
      return 'Asked for an output account this rule does not allow';
    case REASON_POOL_NOT_ALLOWED:
      return 'Asked for a pool account this rule does not allow';
    case REASON_OVER_DAILY_LIMIT:
      return 'Asked more than the daily limit';
    case REASON_QUOTE_BELOW_FLOOR:
      return 'Asked below the price floor';
    default:
      return 'Refused, and the reason is on the record';
  }
}

function ratio(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) {
    return 0;
  }
  if (part >= whole) {
    return 1;
  }
  return Number((part * 10000n) / whole) / 10000;
}

export function snapshotRule(rule: RuleFacts, nowSec: bigint): RuleSnapshot {
  const startedAt = openedAtOf(rule.rows);
  const day = ruleDayNumber(startedAt, rule.expiresAt, nowSec);
  const totalDays = ruleTotalDays(startedAt, rule.expiresAt);
  const remaining = remainingCap(rule.cap, rule.spent);
  const mint = rule.mint;
  const remainingLabel = formatTokenDisplay(remaining, rule.decimals, mint, 'floor');
  const capLabel = formatTokenDisplay(rule.cap, rule.decimals, mint);
  const facts = countRule(rule.rows);
  const dayLabel =
    day != null && totalDays != null
      ? `Day ${day} of ${totalDays}`
      : day != null
        ? `Day ${day}`
        : 'The start is not on the record';
  return {
    ...rule,
    shortAddress: truncateAddress(rule.address),
    remainingLabel,
    capLabel,
    spentLabel: formatTokenDisplay(rule.spent, rule.decimals, mint),
    perTxMaxLabel: formatTokenDisplay(rule.perTxMax, rule.decimals, mint),
    remainingRatio: ratio(remaining, rule.cap),
    day,
    totalDays,
    dayLabel,
    startedAt,
    classified: {
      paidInside: facts.paidInside,
      refused: facts.refused,
      allowances: facts.allowances,
      settlements: facts.settlements,
      declines: facts.declines,
      openedAt: facts.openedAt,
    },
  };
}

export const UNNAMED_AGENT = 'Unnamed agent';

export function agentName(agent: string, names: Record<string, string>): string {
  const key = canonicalAddress(agent);
  if (key && names[key]) {
    return names[key];
  }
  return UNNAMED_AGENT;
}

export function agentsHeading(records: readonly AgentRecord[]): string {
  const rules = records.reduce((count, record) => count + record.rules.length, 0);
  if (records.length === 1 && rules === 1) {
    return '1 running, under one rule';
  }
  if (records.length === rules) {
    return `${records.length} running, each under one rule`;
  }
  return `${records.length} running, across ${rules} rules`;
}

export function liveRulesLabel(count: number): string {
  if (count === 0) {
    return 'No rule live';
  }
  if (count === 1) {
    return '1 rule live';
  }
  return `${count} rules live`;
}

function reasonTallies(rules: readonly RuleSnapshot[]): ReasonTally[] {
  const tallies: ReasonTally[] = [];
  for (const rule of rules) {
    const counts = new Map<number, number>();
    for (const row of rule.classified.refused) {
      counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
    }
    const reasons = [...counts.keys()].sort((a, b) => a - b);
    for (const reason of reasons) {
      tallies.push({
        reason,
        ruleAddress: rule.address,
        label: recordReasonTitle(reason, rule.perTxMaxLabel),
        count: counts.get(reason) ?? 0,
      });
    }
  }
  return tallies;
}

function latestTs(rows: readonly GradeDecision[]): bigint {
  let latest = 0n;
  for (const row of rows) {
    if (row.ts > latest) {
      latest = row.ts;
    }
  }
  return latest;
}

export function buildAgentRecords(
  rules: readonly RuleFacts[],
  names: Record<string, string>,
  nowSec: bigint,
): AgentRecord[] {
  const byAgent = new Map<string, RuleFacts[]>();
  for (const rule of rules) {
    const list = byAgent.get(rule.agent);
    if (list) {
      list.push(rule);
    } else {
      byAgent.set(rule.agent, [rule]);
    }
  }
  const records: AgentRecord[] = [];
  for (const [agent, agentRules] of byAgent) {
    const snapshots = agentRules
      .map((rule) => snapshotRule(rule, nowSec))
      .sort((a, b) => (a.purpose < b.purpose ? -1 : a.purpose > b.purpose ? 1 : 0));
    const grade = gradeRules(snapshots, nowSec);
    const ticks = snapshots
      .flatMap((rule) => requestTicks(rule.rows))
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const nameKey = canonicalAddress(agent);
    const storedName = nameKey ? names[nameKey] : undefined;
    const named = Boolean(storedName);
    const savedName = storedName || UNNAMED_AGENT;
    const one = snapshots.length === 1 ? snapshots[0] : null;
    const spend: SpendLine | null = one
      ? {
          remainingLabel: one.remainingLabel,
          capLabel: one.capLabel,
          ratio: one.remainingRatio,
          sentence: `Can still spend ${one.remainingLabel} of your ${one.capLabel}`,
        }
      : null;
    const daysValue = one
      ? one.day != null && one.totalDays != null
        ? `${one.day} of ${one.totalDays}`
        : one.day != null
          ? String(one.day)
          : 'not on record'
      : `${snapshots.length}`;
    records.push({
      agent,
      name: savedName,
      named,
      shortAddress: truncateAddress(agent),
      grade,
      cardLine: gradeCardLine(grade),
      recordLine: gradeRecordLine(grade),
      rules: snapshots,
      ticks,
      tickLabel: tickLabel(ticks),
      reasons: reasonTallies(snapshots),
      spend,
      daysValue,
      daysCaption: one ? 'days running' : 'rules',
    });
  }
  records.sort((a, b) => {
    const aTs = a.rules.reduce((max, rule) => {
      const ts = latestTs(rule.rows);
      return ts > max ? ts : max;
    }, 0n);
    const bTs = b.rules.reduce((max, rule) => {
      const ts = latestTs(rule.rows);
      return ts > max ? ts : max;
    }, 0n);
    if (aTs !== bTs) {
      return aTs > bTs ? -1 : 1;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return records;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const NARROW_WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type LocalDate = {
  year: number;
  month: number;
  day: number;
  weekday: number;
};

export function localDate(sec: bigint): LocalDate | null {
  const date = new Date(Number(sec) * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    weekday: date.getDay(),
  };
}

function utcStamp(date: LocalDate): number {
  return Date.UTC(date.year, date.month, date.day);
}

export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(utcStamp(date) + days * 86400000);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth(),
    day: next.getUTCDate(),
    weekday: next.getUTCDay(),
  };
}

export function localDayDelta(from: LocalDate, to: LocalDate): number {
  return Math.round((utcStamp(to) - utcStamp(from)) / 86400000);
}

export function localDayKey(date: LocalDate): string {
  const month = String(date.month + 1).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

export function formatWeekdayDate(sec: bigint): string {
  const date = localDate(sec);
  if (!date) {
    return sec.toString();
  }
  return `${WEEKDAY[date.weekday]} ${date.day} ${MONTH[date.month]}`;
}

export function formatWeekdayDateYear(sec: bigint): string {
  const date = localDate(sec);
  if (!date) {
    return sec.toString();
  }
  return `${formatWeekdayDate(sec)} ${date.year}`;
}

export function narrowWeekday(date: LocalDate): string {
  return NARROW_WEEKDAY[date.weekday] ?? '';
}

export function plaqueDateLabel(day: number | null, atSec: bigint): string {
  const when = formatWeekdayDate(atSec);
  if (day == null) {
    return when;
  }
  return `Day ${day}, ${when}`;
}

export function networkBadge(cluster: string, _place: 'name' | 'tokens' | 'card'): string {
  const name =
    cluster === 'devnet'
      ? 'Devnet'
      : cluster === 'testnet'
        ? 'Testnet'
        : cluster === 'mainnet-beta'
          ? 'Mainnet'
          : cluster;
  return name;
}
