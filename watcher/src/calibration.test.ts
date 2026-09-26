import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { nextSlot, zonedLocalToDate } from "./cadence.js";
import { JsonlJournal } from "./journal.js";
import { processWindow } from "./run.js";

const identities = {
  VETO_RPC: "http://rpc.test", VETO_PROGRAM_ID: "Program", VETO_MINT: "Mint",
  VETO_OWNER: "Owner", VETO_OWNER_TOKEN: "Source", VETO_MERCHANT: "Merchant",
  VETO_MERCHANT_TOKEN: "Destination", VETO_AGENT: "Agent",
};
const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({ ...identities, ...env }, { envFiles: [] });

async function day(prices: string[], env: NodeJS.ProcessEnv = { VETO_DEMO_CALIBRATION: "1" }) {
  const dir = mkdtempSync(join(tmpdir(), "veto-calibration-"));
  const journal = new JsonlJournal(join(dir, "decisions.jsonl"));
  const cfg = config(env);
  const requests: bigint[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const at = zonedLocalToDate(2026, 9, 26, i * 6, 0);
      const args = {
        at, journal, kwhMilli: cfg.kwhMilli, mintDecimals: cfg.mintDecimals,
        calibration: cfg.calibration,
        feed: { async getWindow() { return { timeStart: at.toISOString(), timeEnd: new Date(+at + 900000).toISOString(), sekPerKwh: prices[i]! }; } },
        submit: async (amount: bigint) => {
          requests.push(amount);
          const refused = amount > 500000n;
          return { decision: refused ? "refused" as const : "paid" as const,
            reason: refused ? "over per-payment maximum" : "ok", reasonCode: refused ? 5 : 0,
            suggestedOverride: refused ? amount : null, signature: `tx-${i}` };
        }, log: () => {}, feedAttempts: 1,
      };
      await processWindow(args);
      assert.equal(await processWindow(args), "skipped");
    }
    return { rows: journal.load(), requests };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a positive-price day records two payments and two reason-5 refusals, once per slot", async () => {
  const { rows, requests } = await day(["0.16326", "0.43085", "0.15807", "1.27877"]);
  assert.deepEqual(rows.map(r => r.reason_code), [0, 5, 0, 5]);
  assert.equal(requests.length, 4);
  assert(requests[0]! > requests[2]!);
  assert(requests[3]! > requests[1]!);
  for (const amount of requests) assert(amount > 0n && amount < 620000n);
});

test("calibration is opt-in and the existing spot arithmetic remains the default", async () => {
  assert.equal(config().calibration, undefined);
  assert.equal(config().kwhMilli, 50000n);
  const { requests } = await day(["0.001", "0.002", "0.003", "0.004"], {});
  assert.deepEqual(requests, [50000n, 100000n, 150000n, 200000n]);
});

test("zero and negative prices never become scheduled refusal requests", async () => {
  const { requests, rows } = await day(["0", "-1", "0", "-0.01"]);
  assert.deepEqual(requests, []);
  assert(rows.every(row => row.decision === "skipped"));
});

test("calibration rejects invalid switches, limits, lifetimes and refusal hours", () => {
  for (const env of [
    { VETO_DEMO_CALIBRATION: "yes" },
    { VETO_DEMO_CAP: "-1" }, { VETO_DEMO_CAP: "500001" },
    { VETO_DEMO_PER_TX_MAX: "0" }, { VETO_DEMO_DAYS: "0" },
    { VETO_DEMO_DAYS: "40x" }, { VETO_DEMO_REFUSAL_HOURS: "3" },
    { VETO_DEMO_REFUSAL_HOURS: "0,6,12,18" }, { VETO_DEMO_REFUSAL_HOURS: "6,6" },
  ]) assert.throws(() => config({ VETO_DEMO_CALIBRATION: "1", ...env }), /calibration/);
});

test("forty days across either clock change leave cap room for every refusal, even at extreme prices", async () => {
  const { calibrateAmount } = await import("./calibration.js");
  for (const month of [3, 10]) {
    const cfg = config({ VETO_DEMO_CALIBRATION: "1" }).calibration!;
    const start = zonedLocalToDate(2026, month, 1, 0, 0);
    const end = +start + 40 * 86400000;
    let spent = 0n;
    let refusals = 0;
    for (let at = start; +at < end; at = nextSlot(at)) {
      const amount = calibrateAmount(10n ** 30n, at, cfg);
      assert(amount <= 20000000n - spent);
      if (amount > 500000n) refusals++;
      else spent += amount;
    }
    assert(refusals >= 79 && refusals <= 81);
    assert(spent > 0n && spent < 10000000n);
  }
});

test("configured hours and limits change the schedule without allowing off-cadence requests", async () => {
  const { calibrateAmount } = await import("./calibration.js");
  const cfg = config({ VETO_DEMO_CALIBRATION: "1", VETO_DEMO_REFUSAL_HOURS: "12",
    VETO_DEMO_CAP: "10000000", VETO_DEMO_PER_TX_MAX: "250000", VETO_DEMO_DAYS: "80" }).calibration!;
  assert(calibrateAmount(100000n, zonedLocalToDate(2026, 9, 26, 12, 0), cfg) > 250000n);
  assert(calibrateAmount(100000n, zonedLocalToDate(2026, 9, 26, 6, 0), cfg) < 250000n);
  assert.throws(() => calibrateAmount(100000n, zonedLocalToDate(2026, 9, 26, 6, 15), cfg), /cadence/);
});
