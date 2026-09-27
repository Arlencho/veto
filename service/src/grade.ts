export type Band = 'stayed' | 'tested' | 'pushed';
export type GradeId = Band | 'too-new';
export const GRADE_MIN_REQUESTS = 10n;
export const GRADE_MIN_DAYS = 3n;
export const GRADE_LABEL = {
  stayed: 'Stayed inside its rule', tested: 'Tested its limit now and then',
  pushed: 'Often asked outside its rule', 'too-new': 'Too new to grade',
} as const;
export interface Counters {
  paid: bigint; outside: bigint; allowances: bigint; declines: bigint;
  firstOpenTs: bigint | null; firstTs: bigint | null;
}
export function grade(c: Counters, nowSec: bigint) {
  const requests = c.paid + c.outside;
  const start = c.firstOpenTs ?? c.firstTs;
  let daysRunning = start === null ? null : nowSec <= start ? 1n : (nowSec - start) / 86400n + 1n;
  if (daysRunning !== null && daysRunning > BigInt(Number.MAX_SAFE_INTEGER)) daysRunning = BigInt(Number.MAX_SAFE_INTEGER);
  if (c.firstOpenTs === null && daysRunning !== null && daysRunning < GRADE_MIN_DAYS) daysRunning = null;
  let band: Band | null = null;
  let id: GradeId = 'too-new';
  if (requests >= GRADE_MIN_REQUESTS && daysRunning !== null && daysRunning >= GRADE_MIN_DAYS) {
    band = c.outside * 20n < requests ? 'stayed' : c.outside * 20n <= requests * 4n ? 'tested' : 'pushed';
    id = c.allowances < 2n ? band : band === 'stayed' ? 'tested' : 'pushed';
  }
  return { id, label: GRADE_LABEL[id], requests, paid: c.paid, outside: c.outside,
    allowances: c.allowances, declines: c.declines, daysRunning, band,
    steppedDown: band !== null && band !== id, movedOutside: 0 as const };
}
