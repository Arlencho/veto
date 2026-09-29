#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { dueSlots, msUntil, nextSlot, STALE_AFTER_MS } from "./cadence.js";
import {
  agentRulesSlotSettled,
  chargeAgentRules,
  discoverAgentRules,
  quoteSlotAmount,
  type MandateCoder,
} from "./agentRules.js";
import {
  connect,
  ledgerPda,
  loadKeypair,
  mandatePda,
  openMandate,
  readLastNonce,
  readRecordedCharge,
  recoverSettledCharge,
  submitCharge,
  submitRuleCharge,
} from "./chain.js";
import { keyPath, loadConfig } from "./config.js";
import { EcbFxFeed } from "./fx.js";
import { EnergySpotFeed } from "./feed.js";
import { JsonlJournal, type JournalRow } from "./journal.js";
import { fetchChainDecisions, repairJournalFromChain, type ChainDecision } from "./journalRepair.js";
import {
  hydrateLocalJournal,
  objectUpdatedAt,
  persistRecordedDecision,
  storeFromGsUri,
  type JournalObjectStore,
} from "./journalStore.js";
import { scanHoldVaults } from "./hold.js";
import { logError, logLine } from "./log.js";
import { nonceFromSlot } from "./nonce.js";
import { isRateLimitError, redactRpcUrl, redactRpcUrlsInText } from "./rpc.js";
import { processWindow, sleep, withRpcBackoff, type ProcessResult } from "./run.js";
import { isJournalStale, lastDecisionAt } from "./stale.js";
import { PublicKey } from "@solana/web3.js";

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function command(): string {
  const first = process.argv[2];
  if (first === undefined || first.startsWith("--")) return "run";
  return first;
}

async function persistJournal(
  path: string,
  store: JournalObjectStore | null,
  row: Pick<JournalRow, "decision" | "nonce" | "signature"> | null,
): Promise<void> {
  await persistRecordedDecision(path, store, row);
}

async function withJournalAndFeed(now: Date) {
  const cfg = loadConfig();
  const store = storeFromGsUri(cfg.journalGcsUri);
  if (store !== null) {
    await hydrateLocalJournal(cfg.journalPath, store);
  }
  const journal = new JsonlJournal(cfg.journalPath);
  const feed = new EnergySpotFeed();
  const agent = loadKeypair(keyPath(cfg, "agent"));
  // Repair is the ledger read. It runs for a local journal the same as a
  // remote one, and only when a due slot is missing, so an idle pass does
  // not spend the RPC budget a due slot needs.
  if (dueSlots(now).some((slot) => !journal.hasNonce(nonceFromSlot(slot)))) {
    const { connection, programId } = connect(cfg, agent);
    let entries: ChainDecision[] = [];
    try {
      entries = await withRpcBackoff("journal repair", () =>
        fetchChainDecisions({
          connection,
          programId,
          owner: new PublicKey(cfg.owner),
          mandateId: cfg.mandateId,
          hasNonce: (nonce) => journal.hasNonce(nonce),
        }),
      );
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
    }
    const repaired = repairJournalFromChain(journal, entries);
    if (repaired > 0) {
      logLine(`journal repaired ${repaired} row(s) from chain history`);
      if (store !== null) {
        const rows = journal.load();
        await persistJournal(cfg.journalPath, store, rows[rows.length - 1] ?? null);
      }
    }
  }
  const submit = (amount: bigint, nonce: bigint) => submitCharge({ cfg, agent, amount, nonce });
  const chainLastNonce = () => readLastNonce({ cfg, agent });
  const recoverSettled = (nonce: bigint) => recoverSettledCharge({ cfg, agent, nonce });
  const recordedCharge = (nonce: bigint) => readRecordedCharge({ cfg, agent, nonce });
  const fx = cfg.quoteCurrency === "USD" ? new EcbFxFeed() : undefined;
  return { cfg, journal, feed, submit, agent, store, chainLastNonce, recoverSettled, recordedCharge, fx };
}

async function lastAppendedAfter<T>(
  journal: JsonlJournal,
  fn: () => Promise<T>,
): Promise<{ result: T; row: JournalRow | null }> {
  const prior = journal.load().length;
  const result = await fn();
  const rows = journal.load();
  const last = rows.length > prior ? rows[rows.length - 1] : undefined;
  return { result, row: last === undefined ? null : last };
}

async function processAt(at: Date): Promise<ProcessResult> {
  const { cfg, journal, feed, submit, store, chainLastNonce, recoverSettled, recordedCharge, fx } =
    await withJournalAndFeed(at);
  const { result, row } = await lastAppendedAfter(journal, () =>
    processWindow({
      at,
      feed,
      journal,
      submit,
      kwhMilli: cfg.kwhMilli,
      mintDecimals: cfg.mintDecimals,
      calibration: cfg.calibration,
      quoteCurrency: cfg.quoteCurrency,
      fx,
      reader: {
        chainLastNonce,
        recoverSettled,
        recordedCharge,
      },
    }),
  );
  await persistJournal(cfg.journalPath, store, row);
  return result;
}

type AgentRulesCtx = Pick<Awaited<ReturnType<typeof withJournalAndFeed>>, "cfg" | "agent" | "feed" | "fx">;

// The nonce whose agent-rule pass this process already ran. `run` loops every
// 30 seconds; without this it would re-read every rule on each loop.
let agentRulesDoneNonce: bigint | null = null;

/** Charge every other open rule that names this agent, once for the latest due slot. */
async function chargeOtherAgentRules(
  now: Date,
  ctx: AgentRulesCtx,
): Promise<void> {
  const { cfg, agent, feed, fx } = ctx;
  if (cfg.agentRulesMax === 0) return;
  const slots = dueSlots(now);
  const slot = slots[slots.length - 1];
  if (slot === undefined) return;
  const nonce = nonceFromSlot(slot);
  if (agentRulesDoneNonce === nonce) return;
  try {
    const { connection, program, programId } = connect(cfg, agent);
    const mint = new PublicKey(cfg.mint);
    const destination = new PublicKey(cfg.merchantTokenAccount);
    const summary = await chargeAgentRules({
      slot,
      now,
      agent: agent.publicKey,
      mint,
      merchant: new PublicKey(cfg.merchant),
      configured: mandatePda(programId, new PublicKey(cfg.owner), cfg.mandateId),
      max: cfg.agentRulesMax,
      log: logLine,
      logError,
      deps: {
        quote: (at) =>
          quoteSlotAmount({
            at,
            feed,
            fx,
            kwhMilli: cfg.kwhMilli,
            mintDecimals: cfg.mintDecimals,
            quoteCurrency: cfg.quoteCurrency,
          }),
        discover: () =>
          discoverAgentRules({
            connection,
            programId,
            agent: agent.publicKey,
            coder: program.coder.accounts as unknown as MandateCoder,
            log: logLine,
          }),
        readLedgers: async (rules) => {
          const infos = await connection.getMultipleAccountsInfo(
            rules.map((rule) => ledgerPda(programId, rule.address)),
            "confirmed",
          );
          return infos.map((info) => (info === null ? null : info.data));
        },
        submit: (rule, amount, chargeNonce) =>
          submitRuleCharge({
            connection,
            program,
            programId,
            agent,
            mandate: rule.address,
            source: rule.source,
            destination,
            mint,
            amount,
            nonce: chargeNonce,
          }),
      },
    });
    // A feed or FX outage stays open so a later loop can still charge the slot.
    if (agentRulesSlotSettled(summary)) agentRulesDoneNonce = nonce;
  } catch (err) {
    agentRulesDoneNonce = nonce;
    const message = redactRpcUrlsInText(err instanceof Error ? err.message : String(err));
    logError(`agent rules: pass failed, the configured rule is not affected: ${message}`);
  }
}

async function processDue(
  now: Date,
  announceIdle = false,
): Promise<{ deferred: boolean; agentRulesCtx: AgentRulesCtx }> {
  const { cfg, journal, feed, submit, agent, store, chainLastNonce, recoverSettled, recordedCharge, fx } =
    await withJournalAndFeed(now);
  let acted = false;
  let deferred = false;
  for (const slot of dueSlots(now)) {
    const nonce = nonceFromSlot(slot);
    if (journal.hasNonce(nonce)) continue;
    acted = true;
    const { result, row } = await lastAppendedAfter(journal, () =>
      processWindow({
        at: slot,
        feed,
        journal,
        submit,
        kwhMilli: cfg.kwhMilli,
        mintDecimals: cfg.mintDecimals,
        calibration: cfg.calibration,
        quoteCurrency: cfg.quoteCurrency,
        fx,
        reader: {
          chainLastNonce,
          recoverSettled,
          recordedCharge,
        },
      }),
    );
    await persistJournal(cfg.journalPath, store, row);
    if (result === "deferred") deferred = true;
  }
  if (!acted && announceIdle) {
    logLine("caught up: no due cadence slots left to submit");
  }
  return { deferred, agentRulesCtx: { cfg, agent, feed, fx } };
}

async function scanHolds(now: Date): Promise<void> {
  try {
    await scanHoldVaults({ now });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`hold alerts: ${message}`);
  }
}

async function cmdOnce(): Promise<void> {
  const windowFlag = flag("window");
  if (windowFlag !== undefined) {
    const at = new Date(windowFlag);
    if (Number.isNaN(at.getTime())) {
      throw new Error(`bad --window: ${windowFlag}`);
    }
    if (at.getTime() > Date.now()) {
      throw new Error("refusing a future window: wait for it, do not invent a present");
    }
    const result = await processAt(at);
    if (result === "deferred") {
      logError("once: rpc rate limited on all endpoints");
      process.exitCode = 1;
    }
    await scanHolds(new Date());
    return;
  }
  const now = new Date();
  const { deferred, agentRulesCtx } = await processDue(now, true);
  if (deferred) {
    logError("once: rpc rate limited on all endpoints");
    process.exitCode = 1;
  }
  await scanHolds(new Date());
  // Last, so a slow pass over other rules cannot delay the configured rule or hold alerts.
  await chargeOtherAgentRules(now, agentRulesCtx);
}

async function cmdRun(): Promise<void> {
  const cfg = loadConfig();
  logLine(
    `watcher start rpc=${cfg.rpcs.map((url) => redactRpcUrl(url)).join(",")} mandate_id=${cfg.mandateId.toString()} kwh_milli=${cfg.kwhMilli.toString()} journal=${cfg.journalPath}`,
  );
  let stopping = false;
  const stop = (): void => {
    stopping = true;
    logLine("watcher stopping after the current slot");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const now = new Date();
    const { agentRulesCtx } = await processDue(now);
    if (stopping) break;
    await scanHolds(now);
    if (stopping) break;
    await chargeOtherAgentRules(now, agentRulesCtx);
    if (stopping) break;
    const wait = msUntil(nextSlot(now), new Date());
    const chunk = wait < 30_000 ? wait : 30_000;
    logLine(`idle next=${nextSlot(now).toISOString()} sleep_ms=${chunk}`);
    await sleep(chunk === 0 ? 1_000 : chunk);
  }
}

async function cmdOpenMandate(): Promise<void> {
  const cfg = loadConfig();
  const owner = loadKeypair(keyPath(cfg, "owner"));
  const nowUnix = BigInt(Date.now()) / 1000n;
  const expiresAtUnix = nowUnix + 90n * 24n * 60n * 60n;
  const result = await openMandate({ cfg, owner, expiresAtUnix });
  const programId = new PublicKey(cfg.programId);
  const mandate = mandatePda(programId, owner.publicKey, cfg.mandateId);
  if (result.signature.length === 0) {
    logLine(`mandate already open ${mandate.toBase58()}`);
    return;
  }
  logLine(`mandate opened ${result.mandate} ledger=${result.ledger} sig=${result.signature}`);
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const store = storeFromGsUri(cfg.journalGcsUri);
  if (store !== null) {
    await hydrateLocalJournal(cfg.journalPath, store);
  }
  const journal = new JsonlJournal(cfg.journalPath);
  const counts = journal.counts();
  const rows = journal.load();
  const last = rows[rows.length - 1];
  const backend = cfg.journalGcsUri ?? cfg.journalPath;
  logLine(
    `journal ${backend} total=${counts.total} paid=${counts.paid} refused=${counts.refused} gap=${counts.gap} skipped=${counts.skipped}`,
  );
  if (last !== undefined) {
    logLine(`last decision=${last.decision} reason=${last.reason} nonce=${last.nonce} sig=${last.signature ?? "-"}`);
  }
}

async function cmdStale(): Promise<void> {
  const cfg = loadConfig();
  const store = storeFromGsUri(cfg.journalGcsUri);
  if (store !== null) {
    await hydrateLocalJournal(cfg.journalPath, store);
  }
  const journal = new JsonlJournal(cfg.journalPath);
  const rows = journal.load();
  const emptySince =
    store !== null
      ? await objectUpdatedAt(store)
      : existsSync(cfg.journalPath)
        ? statSync(cfg.journalPath).mtime
        : null;
  const last = lastDecisionAt(rows);
  if (isJournalStale({ rows, now: new Date(), emptySince })) {
    logError(
      `journal stale last=${last?.toISOString() ?? "none"} empty_since=${emptySince?.toISOString() ?? "none"} threshold_ms=${STALE_AFTER_MS}`,
    );
    process.exitCode = 1;
    return;
  }
  logLine(`journal fresh last=${last?.toISOString() ?? "none"} threshold_ms=${STALE_AFTER_MS}`);
}

async function main(): Promise<void> {
  const cmd = command();
  if (hasFlag("help") || cmd === "help") {
    process.stdout.write(
      "veto-watcher <run|once|open-mandate|status|stale> [--window ISO]\n",
    );
    return;
  }
  if (cmd === "once") {
    await cmdOnce();
    return;
  }
  if (cmd === "open-mandate") {
    await cmdOpenMandate();
    return;
  }
  if (cmd === "status") {
    await cmdStatus();
    return;
  }
  if (cmd === "run") {
    await cmdRun();
    return;
  }
  if (cmd === "stale") {
    await cmdStale();
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logError(message);
  process.exitCode = 1;
});
