import { CADENCE_HOURS, dueSlots, STOCKHOLM } from "./cadence.js";

export type DemoCalibration = {
  cap: bigint;
  perTxMax: bigint;
  days: bigint;
  refusalHours: number[];
  paymentBudget: bigint;
};

/** Explicit opt-in. Limits describe the existing rule; they never change it. */
export function loadCalibration(lookup: (key: string) => string | undefined): DemoCalibration | undefined {
  const enabled = lookup("VETO_DEMO_CALIBRATION") ?? "0";
  if (enabled === "0") return undefined;
  if (enabled !== "1") throw new Error("calibration: VETO_DEMO_CALIBRATION must be 0 or 1");
  const positive = (key: string, fallback: string): bigint => {
    const raw = lookup(key) ?? fallback;
    if (!/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n || BigInt(raw) > 18446744073709551615n) {
      throw new Error(`calibration: ${key} must be a positive u64 integer`);
    }
    return BigInt(raw);
  };
  const cap = positive("VETO_DEMO_CAP", "20000000");
  const perTxMax = positive("VETO_DEMO_PER_TX_MAX", "500000");
  const days = positive("VETO_DEMO_DAYS", "40");
  const hours = (lookup("VETO_DEMO_REFUSAL_HOURS") ?? "6,18").split(",");
  const refusalHours = hours.map(Number);
  if (hours.some(h => !/^(0|6|12|18)$/.test(h)) || new Set(refusalHours).size !== hours.length || hours.length >= 4) {
    throw new Error("calibration: refusal hours must select one to three distinct cadence hours (0,6,12,18)");
  }
  // Include a boundary day for partial days and clock changes. Reserve the
  // largest refusal even if every possible slot before it had paid.
  const slots = BigInt(CADENCE_HOURS.length) * (days + 1n);
  const budget = (cap - perTxMax - 1n) / (slots + 1n);
  const paymentBudget = budget < perTxMax ? budget : perTxMax;
  if (paymentBudget < 1n) throw new Error("calibration: cap must leave room for lifetime payments and a refusal");
  return { cap, perTxMax, days, refusalHours, paymentBudget };
}

/** A bounded increasing function of the original spot/FX amount, in base units. */
export function calibrateAmount(raw: bigint, at: Date, cfg: DemoCalibration): bigint {
  if (!dueSlots(at).some(slot => +slot === +at)) {
    throw new Error("calibration: requests must use an exact Stockholm cadence slot");
  }
  if (raw <= 0n) return 0n;
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: STOCKHOLM, hour: "2-digit", hourCycle: "h23",
  }).format(at));
  const bounded = raw * cfg.paymentBudget / (raw + cfg.paymentBudget);
  const indexed = bounded > 0n ? bounded : 1n;
  return cfg.refusalHours.includes(hour) ? cfg.perTxMax + 1n + indexed : indexed;
}
