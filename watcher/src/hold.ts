import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type Connection } from "@solana/web3.js";
import { connect, loadKeypair } from "./chain.js";
import { keyPath, loadConfig, type LoadConfigOpts, type WatcherConfig } from "./config.js";
import { hydrateLocalJournal, parseGsUri, persistLocalJournal, storeFromGsUri } from "./journalStore.js";
import { logError, logLine } from "./log.js";

const HOUR = 3_600n;
const HOLD_PENDING_CAPACITY = 8;
const HOLD_LEDGER_CAPACITY = 32;
const VAULT_LEN = 1691;
const LEDGER_LEN = 2096;
const PENDING_SIZE = 57;
const ENTRY_SIZE = 64;
const OFF_DELAY = 200;
const OFF_PENDING = 743;
const ENTRY_BASE = 48;
const WITHDRAWAL_PENDING = 1;
const KIND_PAID = 2;
const KIND_HELD = 3;
const KIND_STOPPED = 4;
const KIND_SKIPPED = 7;
const KIND_RECOVERED = 8;

export type HoldAlertName =
  | "created"
  | "1h"
  | "12h"
  | "every_12h"
  | "6h_before"
  | "1h_before"
  | "paid"
  | "stopped"
  | "recovered"
  | "skipped";

export type HoldAlertEvent = {
  key: string;
  vault: string;
  withdrawalId: string;
  alert: HoldAlertName;
  mark: string;
  amount: string;
  destination: string;
  unlockAt: string;
  createdAt: string;
};

export type HoldAlertRow = HoldAlertEvent & { ts: string };

export type HoldPending = {
  id: bigint;
  amount: bigint;
  destination: PublicKey;
  unlockAt: bigint;
};

export type HoldLedgerEntry = {
  ts: bigint;
  amount: bigint;
  destination: PublicKey;
  withdrawalId: bigint;
  kind: number;
};

export type HoldWatch = {
  address: PublicKey;
  delaySecs: bigint;
  pending: HoldPending[];
  entries: HoldLedgerEntry[];
};

export type HoldAlertLog = {
  has(key: string): boolean;
  append(row: HoldAlertRow): void;
};

type NamedDisc = { name: string; discriminator: number[] };

function accountDisc(name: string): Buffer {
  const path = fileURLToPath(new URL("../idl/veto.json", import.meta.url));
  const idl = JSON.parse(readFileSync(path, "utf8")) as { accounts: NamedDisc[] };
  const found = idl.accounts.find((item) => item.name === name);
  if (!found) throw new Error(`idl: missing ${name}`);
  return Buffer.from(found.discriminator);
}

const VAULT_DISC = accountDisc("HoldVault");
const LEDGER_DISC = accountDisc("HoldLedger");

export function holdAlertJournalPath(decisionsPath: string): string {
  return join(dirname(decisionsPath), "hold-alerts.jsonl");
}

export function holdAlertGcsUri(decisionsUri: string | null): string | null {
  if (decisionsUri === null) return null;
  const loc = parseGsUri(decisionsUri);
  const slash = loc.object.lastIndexOf("/");
  const dir = slash >= 0 ? loc.object.slice(0, slash + 1) : "";
  return `gs://${loc.bucket}/${dir}hold-alerts.jsonl`;
}

export class HoldAlertJournal implements HoldAlertLog {
  constructor(readonly path: string) {}

  load(): HoldAlertRow[] {
    if (!existsSync(this.path)) return [];
    const rows: HoldAlertRow[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as HoldAlertRow;
        if (typeof parsed.key === "string") rows.push(parsed);
      } catch {
        // A torn line is skipped so a crash mid-write cannot brick the process.
      }
    }
    return rows;
  }

  has(key: string): boolean {
    return this.load().some((row) => row.key === key);
  }

  append(row: HoldAlertRow): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, "utf8");
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function timeText(sec: bigint): string {
  if (sec <= 0n) return "0";
  return new Date(Number(sec) * 1000).toISOString();
}

function makeEvent(
  vault: string,
  id: bigint,
  alert: HoldAlertName,
  mark: string,
  amount: bigint,
  destination: PublicKey,
  unlockAt: bigint,
  created: bigint,
): HoldAlertEvent {
  const withdrawalId = id.toString();
  return {
    key: `${vault}:${withdrawalId}:${alert}:${mark}`,
    vault,
    withdrawalId,
    alert,
    mark,
    amount: amount.toString(),
    destination: destination.toBase58(),
    unlockAt: timeText(unlockAt),
    createdAt: timeText(created),
  };
}

function specificEnd(kind: number): "paid" | "stopped" | "skipped" | null {
  if (kind === KIND_PAID) return "paid";
  if (kind === KIND_STOPPED) return "stopped";
  if (kind === KIND_SKIPPED) return "skipped";
  return null;
}

function createdFromEntries(entries: readonly HoldLedgerEntry[], id: bigint): bigint | null {
  let ts: bigint | null = null;
  for (const entry of entries) {
    if (entry.kind === KIND_HELD && entry.withdrawalId === id) ts = entry.ts;
  }
  return ts;
}

function createdAt(vault: HoldWatch, row: HoldPending): bigint {
  const recorded = createdFromEntries(vault.entries, row.id);
  if (recorded !== null) return recorded;
  if (row.unlockAt >= vault.delaySecs) return row.unlockAt - vault.delaySecs;
  return row.unlockAt;
}

function cadence(vault: string, row: HoldPending, created: bigint, nowSec: bigint): HoldAlertEvent[] {
  const out: HoldAlertEvent[] = [];
  const push = (alert: HoldAlertName, mark: string): void => {
    out.push(makeEvent(vault, row.id, alert, mark, row.amount, row.destination, row.unlockAt, created));
  };
  push("created", "created");
  if (nowSec >= created + HOUR) push("1h", "1");
  if (nowSec >= created + 12n * HOUR) push("12h", "12");
  if (nowSec > created) {
    const elapsedHours = (nowSec - created) / HOUR;
    const last = (elapsedHours / 12n) * 12n;
    if (last >= 24n) {
      let start = 24n;
      const count = (last - 24n) / 12n + 1n;
      if (count > 200n) start = last - 199n * 12n;
      for (let hours = start; hours <= last; hours += 12n) {
        push("every_12h", hours.toString());
      }
    }
  }
  const unlock = row.unlockAt;
  if (unlock > created + 6n * HOUR && nowSec >= unlock - 6n * HOUR) push("6h_before", "6");
  if (unlock > created + HOUR && nowSec >= unlock - HOUR) push("1h_before", "1");
  return out;
}

function alertsForVault(vault: HoldWatch, nowSec: bigint): HoldAlertEvent[] {
  const address = vault.address.toBase58();
  const ends = new Map<string, HoldLedgerEntry>();
  let recovered: HoldLedgerEntry | null = null;
  for (const entry of vault.entries) {
    if (entry.kind === KIND_RECOVERED) recovered = entry;
    if (entry.withdrawalId === 0n || specificEnd(entry.kind) === null) continue;
    ends.set(entry.withdrawalId.toString(), entry);
  }

  const pendingIds = new Set<string>();
  const events: HoldAlertEvent[] = [];
  for (const row of vault.pending) {
    const id = row.id.toString();
    pendingIds.add(id);
    const created = createdAt(vault, row);
    const specific = ends.get(id);
    if (specific) {
      const name = specificEnd(specific.kind);
      if (name === null) continue;
      events.push(makeEvent(address, row.id, name, name, specific.amount, specific.destination, row.unlockAt, created));
      continue;
    }
    if (recovered !== null && recovered.ts >= created) {
      events.push(makeEvent(
        address,
        row.id,
        "recovered",
        "recovered",
        row.amount,
        row.destination,
        row.unlockAt,
        created,
      ));
      continue;
    }
    events.push(...cadence(address, row, created, nowSec));
  }

  for (const entry of ends.values()) {
    const id = entry.withdrawalId.toString();
    if (pendingIds.has(id)) continue;
    const created = createdFromEntries(vault.entries, entry.withdrawalId) ?? entry.ts;
    const name = specificEnd(entry.kind);
    if (name === null) continue;
    events.push(makeEvent(address, entry.withdrawalId, name, name, entry.amount, entry.destination, 0n, created));
  }
  return events;
}

/** Records each due alert once and hands it to notify. */
export function raiseHoldAlerts(args: {
  now: Date;
  vaults: readonly HoldWatch[];
  journal: HoldAlertLog;
  notify: (event: HoldAlertEvent) => void;
}): HoldAlertEvent[] {
  const nowSec = BigInt(Math.floor(args.now.getTime() / 1000));
  const ts = args.now.toISOString();
  const raised: HoldAlertEvent[] = [];
  for (const vault of args.vaults) {
    for (const event of alertsForVault(vault, nowSec)) {
      if (args.journal.has(event.key)) continue;
      args.journal.append({ ...event, ts });
      args.notify(event);
      raised.push(event);
    }
  }
  return raised;
}

export function formatHoldAlert(event: HoldAlertEvent): string {
  const mark = event.alert === "every_12h" ? ` mark=${event.mark}` : "";
  return `hold alert vault=${event.vault} id=${event.withdrawalId} alert=${event.alert}${mark} amount=${event.amount} destination=${event.destination} unlock_at=${event.unlockAt}`;
}

function requireDisc(data: Buffer, expected: Buffer, what: string): void {
  if (data.length < expected.length || !data.subarray(0, expected.length).equals(expected)) {
    throw new Error(`${what} account discriminator mismatch`);
  }
}

async function owned(
  connection: Connection,
  address: PublicKey,
  programId: PublicKey,
  what: string,
): Promise<Buffer> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`${what} not found: ${address.toBase58()}`);
  if (!info.owner.equals(programId)) {
    throw new Error(`${what} ${address.toBase58()} is not owned by the program`);
  }
  return Buffer.from(info.data);
}

function readPending(data: Buffer): HoldPending[] {
  requireDisc(data, VAULT_DISC, "hold vault");
  // Pending rows keep their offsets across the owner-signed layout migration.
  if (data.length !== 1291 && data.length < VAULT_LEN) throw new Error(`hold vault account is ${data.length} bytes, need ${VAULT_LEN}`);
  const pending: HoldPending[] = [];
  for (let i = 0; i < HOLD_PENDING_CAPACITY; i += 1) {
    const off = OFF_PENDING + i * PENDING_SIZE;
    const status = data.readUInt8(off + 56);
    if (status !== WITHDRAWAL_PENDING) continue;
    pending.push({
      id: data.readBigUInt64LE(off),
      amount: data.readBigUInt64LE(off + 8),
      destination: new PublicKey(data.subarray(off + 16, off + 48)),
      unlockAt: data.readBigInt64LE(off + 48),
    });
  }
  return pending;
}

function readEntries(data: Buffer): HoldLedgerEntry[] {
  requireDisc(data, LEDGER_DISC, "hold ledger");
  if (data.length < LEDGER_LEN) throw new Error(`hold ledger account is ${data.length} bytes, need ${LEDGER_LEN}`);
  const total = data.readUInt32LE(40);
  const head = data.readUInt16LE(44);
  const live = Math.min(total, HOLD_LEDGER_CAPACITY);
  const start = total >= HOLD_LEDGER_CAPACITY ? head % HOLD_LEDGER_CAPACITY : 0;
  const entries: HoldLedgerEntry[] = [];
  for (let n = 0; n < live; n += 1) {
    const index = (start + n) % HOLD_LEDGER_CAPACITY;
    const off = ENTRY_BASE + index * ENTRY_SIZE;
    entries.push({
      ts: data.readBigInt64LE(off),
      amount: data.readBigUInt64LE(off + 8),
      destination: new PublicKey(data.subarray(off + 16, off + 48)),
      withdrawalId: data.readBigUInt64LE(off + 48),
      kind: data.readUInt8(off + 56),
    });
  }
  return entries;
}

export function holdLedgerPda(programId: PublicKey, vault: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hold-ledger"), vault.toBuffer()],
    programId,
  );
  return pda;
}

export async function readHoldVault(
  connection: Connection,
  programId: PublicKey,
  address: PublicKey,
): Promise<HoldWatch> {
  const vaultData = await owned(connection, address, programId, "hold vault");
  const pending = readPending(vaultData);
  const ledgerData = await owned(connection, holdLedgerPda(programId, address), programId, "hold ledger");
  return {
    address,
    delaySecs: vaultData.readBigInt64LE(OFF_DELAY),
    pending,
    entries: readEntries(ledgerData),
  };
}

async function chainReader(cfg: WatcherConfig): Promise<(address: PublicKey) => Promise<HoldWatch>> {
  const agent = loadKeypair(keyPath(cfg, "agent"));
  const { connection, programId } = connect(cfg, agent);
  return (address) => readHoldVault(connection, programId, address);
}

/**
 * Reads configured Hold vaults and raises each due alert once.
 * No vaults configured returns before any chain read. Alerts are printed
 * with the same log line the rest of the watcher uses.
 */
export async function scanHoldVaults(args: {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  envFiles?: string[];
  notify?: (event: HoldAlertEvent) => void;
  onError?: (message: string) => void;
  readVault?: (address: PublicKey) => Promise<HoldWatch>;
} = {}): Promise<HoldAlertEvent[]> {
  const now = args.now ?? new Date();
  const notify = args.notify ?? ((event: HoldAlertEvent) => logLine(formatHoldAlert(event)));
  const onError = args.onError ?? logError;
  const opts: LoadConfigOpts | undefined = args.envFiles === undefined ? undefined : { envFiles: args.envFiles };
  const cfg = loadConfig(args.env ?? process.env, opts);
  if (cfg.holdVaults.length === 0) return [];

  const path = holdAlertJournalPath(cfg.journalPath);
  const store = storeFromGsUri(holdAlertGcsUri(cfg.journalGcsUri));
  if (store !== null) {
    try {
      await hydrateLocalJournal(path, store);
    } catch (err) {
      onError(`hold alerts: could not read the stored journal: ${messageOf(err)}`);
    }
  }
  const journal = new HoldAlertJournal(path);
  let reader = args.readVault;
  const raised: HoldAlertEvent[] = [];

  for (const address of cfg.holdVaults) {
    let key: PublicKey;
    try {
      key = new PublicKey(address);
    } catch {
      onError(`hold alerts: VETO_HOLD_VAULTS has an invalid address: ${address}`);
      continue;
    }
    if (reader === undefined) {
      try {
        reader = await chainReader(cfg);
      } catch (err) {
        onError(`hold alerts: ${messageOf(err)}`);
        break;
      }
    }
    try {
      const snap = await reader(key);
      raised.push(...raiseHoldAlerts({ now, vaults: [snap], journal, notify }));
    } catch (err) {
      onError(`hold alerts: ${address}: ${messageOf(err)}`);
    }
  }

  if (store !== null && raised.length > 0) {
    try {
      await persistLocalJournal(path, store);
    } catch (err) {
      onError(`hold alerts: could not store the journal: ${messageOf(err)}`);
    }
  }
  return raised;
}
