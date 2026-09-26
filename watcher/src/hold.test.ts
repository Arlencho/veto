import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import {
  HoldAlertJournal,
  formatHoldAlert,
  holdAlertGcsUri,
  holdLedgerPda,
  raiseHoldAlerts,
  readHoldVault,
  scanHoldVaults,
  type HoldAlertEvent,
  type HoldLedgerEntry,
  type HoldPending,
  type HoldWatch,
} from "./hold.js";
import { hydrateLocalJournal, memoryStore, persistLocalJournal } from "./journalStore.js";

const T0 = new Date("2026-09-01T00:00:00.000Z");
const CREATED = BigInt(Math.floor(T0.getTime() / 1000));
const DAY = 86_400n;
const VAULT = new PublicKey("11111111111111111111111111111111");
const DEST = Keypair.generate().publicKey;
const DEST_B = Keypair.generate().publicKey;

const IDENTITIES = {
  VETO_RPC: "http://rpc.test",
  VETO_PROGRAM_ID: "Prog",
  VETO_MINT: "Mint",
  VETO_OWNER: "Owner",
  VETO_OWNER_TOKEN: "OwnerToken",
  VETO_MERCHANT: "Merchant",
  VETO_MERCHANT_TOKEN: "MerchantToken",
  VETO_AGENT: "Agent",
};

function plus(hours: number): Date {
  return new Date(T0.getTime() + hours * 3_600_000);
}

function tempJournal(): HoldAlertJournal {
  const dir = mkdtempSync(join(tmpdir(), "hold-alerts-"));
  return new HoldAlertJournal(join(dir, "hold-alerts.jsonl"));
}

function held(id: bigint, ts = CREATED, destination = DEST, amount = 10n): HoldLedgerEntry {
  return { ts, amount, destination, withdrawalId: id, kind: 3 };
}

function row(id: bigint, unlock: bigint, destination = DEST, amount = 10n): HoldPending {
  return { id, amount, destination, unlockAt: unlock };
}

function openVault(delaySecs: bigint, id = 4n): HoldWatch {
  return {
    address: VAULT,
    delaySecs,
    pending: [row(id, CREATED + delaySecs)],
    entries: [held(id)],
  };
}

function names(events: readonly HoldAlertEvent[]): string[] {
  return events.map((event) => event.alert);
}

function raise(journal: HoldAlertJournal, now: Date, vault: HoldWatch, notes?: HoldAlertEvent[]): HoldAlertEvent[] {
  return raiseHoldAlerts({
    now,
    vaults: [vault],
    journal,
    notify: (event) => notes?.push(event),
  });
}

test("a hold raises a creation alert when it is first seen", () => {
  const journal = tempJournal();
  const notes: HoldAlertEvent[] = [];
  const raised = raise(journal, T0, openVault(3n * DAY), notes);
  assert.deepEqual(names(raised), ["created"]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.key, raised[0]?.key);
  assert.equal(journal.load().length, 1);
  assert.equal(journal.load()[0]?.alert, "created");
  assert.match(formatHoldAlert(raised[0]!), /hold alert vault=.* alert=created amount=10 /);
});

test("the one hour alert is raised at one hour and the creation alert is not repeated", () => {
  const journal = tempJournal();
  const vault = openVault(3n * DAY);
  raise(journal, T0, vault);
  const atHour = raise(journal, plus(1), vault);
  assert.deepEqual(names(atHour), ["1h"]);
  assert.equal(raise(journal, plus(1), vault).length, 0);
});

test("the one hour alert is not raised before the hour", () => {
  const journal = tempJournal();
  const raised = raise(journal, new Date(plus(1).getTime() - 1000), openVault(3n * DAY));
  assert.equal(raised.some((event) => event.alert === "1h"), false);
  assert.deepEqual(names(raised), ["created"]);
});

test("the twelve hour alert is raised at twelve hours", () => {
  const journal = tempJournal();
  const vault = openVault(3n * DAY);
  raise(journal, plus(1), vault);
  const atTwelve = raise(journal, plus(12), vault);
  assert.deepEqual(names(atTwelve), ["12h"]);
});

test("every twelve hours after the first twelve raises its own alert", () => {
  const journal = tempJournal();
  const vault = openVault(3n * DAY);
  raise(journal, plus(12), vault);
  const at24 = raise(journal, plus(24), vault);
  assert.deepEqual(at24.map((event) => [event.alert, event.mark]), [["every_12h", "24"]]);
  const at36 = raise(journal, plus(36), vault);
  assert.deepEqual(at36.map((event) => [event.alert, event.mark]), [["every_12h", "36"]]);
  assert.equal(raise(journal, plus(36), vault).length, 0);
});

test("the six hour warning starts at six hours before unlock", () => {
  const journal = tempJournal();
  const vault = openVault(DAY);
  raise(journal, plus(12), vault);
  const early = raise(journal, new Date(plus(18).getTime() - 1000), vault);
  assert.equal(early.some((event) => event.alert === "6h_before"), false);
  const due = raise(journal, plus(18), vault);
  assert.deepEqual(names(due), ["6h_before"]);
});

test("the one hour warning starts at one hour before unlock", () => {
  const journal = tempJournal();
  const vault = openVault(DAY);
  raise(journal, plus(18), vault);
  const due = raise(journal, plus(23), vault);
  assert.deepEqual(names(due), ["1h_before"]);
  assert.equal(raise(journal, plus(23), vault).length, 0);
});

test("an instant payment is not a hold alert", () => {
  const journal = tempJournal();
  const vault: HoldWatch = {
    address: VAULT,
    delaySecs: DAY,
    pending: [],
    entries: [{ ts: CREATED, amount: 5n, destination: DEST, withdrawalId: 0n, kind: 2 }],
  };
  assert.deepEqual(raise(journal, T0, vault), []);
});

test("a paid hold raises one paid alert and then stays quiet", () => {
  const journal = tempJournal();
  const notes: HoldAlertEvent[] = [];
  const vault: HoldWatch = {
    address: VAULT,
    delaySecs: DAY,
    pending: [],
    entries: [held(4n), { ts: CREATED + 50n, amount: 10n, destination: DEST, withdrawalId: 4n, kind: 2 }],
  };
  const raised = raise(journal, plus(2), vault, notes);
  assert.deepEqual(names(raised), ["paid"]);
  assert.equal(raised[0]?.amount, "10");
  assert.equal(raised[0]?.withdrawalId, "4");
  assert.equal(notes.length, 1);
  assert.equal(raise(journal, plus(30), vault).length, 0);
  assert.equal(journal.load().filter((row) => row.alert === "paid").length, 1);
});

test("a stopped hold raises one stopped alert", () => {
  const journal = tempJournal();
  const vault: HoldWatch = {
    address: VAULT,
    delaySecs: DAY,
    pending: [],
    entries: [held(4n), { ts: CREATED + 10n, amount: 10n, destination: DEST, withdrawalId: 4n, kind: 4 }],
  };
  assert.deepEqual(names(raise(journal, plus(1), vault)), ["stopped"]);
});

test("a skipped hold raises one skipped alert and no reminder", () => {
  const journal = tempJournal();
  const vault: HoldWatch = {
    address: VAULT,
    delaySecs: DAY,
    pending: [],
    entries: [held(4n), { ts: CREATED + 10n, amount: 10n, destination: DEST, withdrawalId: 4n, kind: 7 }],
  };
  assert.deepEqual(names(raise(journal, plus(20), vault)), ["skipped"]);
});

test("a recovered vault raises one recovered alert for each open hold and no reminder", () => {
  const journal = tempJournal();
  const unlock = CREATED + 3n * DAY;
  const vault: HoldWatch = {
    address: VAULT,
    delaySecs: 3n * DAY,
    pending: [row(4n, unlock, DEST, 10n), row(5n, unlock, DEST_B, 20n)],
    entries: [
      held(4n, CREATED, DEST, 10n),
      held(5n, CREATED, DEST_B, 20n),
      { ts: CREATED + 10n, amount: 999n, destination: DEST, withdrawalId: 0n, kind: 8 },
    ],
  };
  const raised = raise(journal, plus(20), vault);
  assert.deepEqual(raised.map((event) => [event.alert, event.withdrawalId, event.amount]), [
    ["recovered", "4", "10"],
    ["recovered", "5", "20"],
  ]);
  assert.equal(raised.some((event) => event.alert === "12h"), false);
  assert.equal(raise(journal, plus(20), vault).length, 0);
});

test("a recovery from before this hold does not end it", () => {
  const journal = tempJournal();
  const vault: HoldWatch = {
    address: VAULT,
    delaySecs: 3n * DAY,
    pending: [row(4n, CREATED + 3n * DAY)],
    entries: [
      { ts: CREATED - 100n, amount: 1n, destination: DEST, withdrawalId: 0n, kind: 8 },
      held(4n),
    ],
  };
  assert.deepEqual(names(raise(journal, T0, vault)), ["created"]);
});

test("each hold alert is recorded once", () => {
  const journal = tempJournal();
  let calls = 0;
  const vault = openVault(3n * DAY);
  raiseHoldAlerts({ now: T0, vaults: [vault], journal, notify: () => { calls += 1; } });
  const again = raiseHoldAlerts({ now: T0, vaults: [vault], journal, notify: () => { calls += 1; } });
  assert.deepEqual(again, []);
  assert.equal(calls, 1);
  assert.equal(journal.load().length, 1);
});

test("an unset VETO_HOLD_VAULTS leaves the vault list empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "hold-cfg-"));
  const cfg = loadConfig({ ...IDENTITIES, VETO_KEYS_DIR: dir }, { envFiles: [] });
  assert.deepEqual(cfg.holdVaults, []);
  const spaced = loadConfig(
    { ...IDENTITIES, VETO_KEYS_DIR: dir, VETO_HOLD_VAULTS: " , " },
    { envFiles: [] },
  );
  assert.deepEqual(spaced.holdVaults, []);
});

test("VETO_HOLD_VAULTS splits on commas and trims each address", () => {
  const dir = mkdtempSync(join(tmpdir(), "hold-cfg-"));
  const cfg = loadConfig(
    { ...IDENTITIES, VETO_KEYS_DIR: dir, VETO_HOLD_VAULTS: " Aaa , Bbb " },
    { envFiles: [] },
  );
  assert.deepEqual(cfg.holdVaults, ["Aaa", "Bbb"]);
});

test("no configured vaults writes no hold alert and does not read the chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hold-scan-"));
  const notes: HoldAlertEvent[] = [];
  const result = await scanHoldVaults({
    now: T0,
    env: { ...IDENTITIES, VETO_KEYS_DIR: dir, VETO_JOURNAL: join(dir, "decisions.jsonl") },
    envFiles: [],
    notify: (event) => notes.push(event),
    readVault: () => Promise.reject(new Error("should not read")),
  });
  assert.deepEqual(result, []);
  assert.equal(notes.length, 0);
  assert.equal(existsSync(join(dir, "hold-alerts.jsonl")), false);
  assert.equal(existsSync(join(dir, "decisions.jsonl")), false);
});

test("configured vaults raise one creation alert each and a bad address is reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hold-scan-"));
  const first = Keypair.generate().publicKey;
  const second = Keypair.generate().publicKey;
  const seen: string[] = [];
  const errors: string[] = [];
  const notes: HoldAlertEvent[] = [];
  const result = await scanHoldVaults({
    now: T0,
    env: {
      ...IDENTITIES,
      VETO_KEYS_DIR: dir,
      VETO_JOURNAL: join(dir, "decisions.jsonl"),
      VETO_HOLD_VAULTS: `nope, ${first.toBase58()}, ${second.toBase58()}`,
    },
    envFiles: [],
    notify: (event) => notes.push(event),
    onError: (message) => errors.push(message),
    readVault: (address) => {
      seen.push(address.toBase58());
      return Promise.resolve({ ...openVault(3n * DAY), address });
    },
  });
  assert.deepEqual(seen, [first.toBase58(), second.toBase58()]);
  assert.deepEqual(names(result), ["created", "created"]);
  assert.deepEqual(notes.map((event) => event.vault), [first.toBase58(), second.toBase58()]);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /nope/);
  assert.equal(existsSync(join(dir, "decisions.jsonl")), false);
  assert.equal(existsSync(join(dir, "hold-alerts.jsonl")), true);
});

test("a stored hold journal keeps the same alert from being raised again", async () => {
  const store = memoryStore();
  const firstDir = mkdtempSync(join(tmpdir(), "hold-store-"));
  const first = new HoldAlertJournal(join(firstDir, "hold-alerts.jsonl"));
  const vault = openVault(3n * DAY);
  assert.equal(raise(first, T0, vault).length, 1);
  await persistLocalJournal(first.path, store);
  const secondDir = mkdtempSync(join(tmpdir(), "hold-store-"));
  const secondPath = join(secondDir, "hold-alerts.jsonl");
  await hydrateLocalJournal(secondPath, store);
  const again = raise(new HoldAlertJournal(secondPath), T0, vault);
  assert.deepEqual(again, []);
});

test("the hold alert object sits beside the decision journal object", () => {
  assert.equal(holdAlertGcsUri("gs://bucket/decisions.jsonl"), "gs://bucket/hold-alerts.jsonl");
  assert.equal(holdAlertGcsUri("gs://bucket/a/b/decisions.jsonl"), "gs://bucket/a/b/hold-alerts.jsonl");
  assert.equal(holdAlertGcsUri(null), null);
});

test("readHoldVault reads the pending withdrawal and the held ledger row", async () => {
  const idl = JSON.parse(readFileSync(fileURLToPath(new URL("../idl/veto.json", import.meta.url)), "utf8")) as {
    accounts: { name: string; discriminator: number[] }[];
  };
  const disc = (name: string): Buffer => {
    const found = idl.accounts.find((item) => item.name === name);
    assert.ok(found, name);
    return Buffer.from(found.discriminator);
  };
  const programId = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const vaultData = Buffer.alloc(1691);
  vaultData.set(disc("HoldVault"), 0);
  vaultData.writeBigInt64LE(DAY, 200);
  vaultData.writeBigUInt64LE(4n, 743);
  vaultData.writeBigUInt64LE(9n, 751);
  vaultData.set(destination.toBuffer(), 759);
  vaultData.writeBigInt64LE(CREATED + DAY, 791);
  vaultData.writeUInt8(1, 799);
  vaultData.writeBigUInt64LE(99n, 800);
  vaultData.writeUInt8(0, 856);
  const ledgerKey = holdLedgerPda(programId, vault);
  const ledger = Buffer.alloc(2096);
  ledger.set(disc("HoldLedger"), 0);
  ledger.writeUInt32LE(1, 40);
  ledger.writeUInt16LE(1, 44);
  ledger.writeBigInt64LE(CREATED, 48);
  ledger.writeBigUInt64LE(9n, 56);
  ledger.set(destination.toBuffer(), 64);
  ledger.writeBigUInt64LE(4n, 96);
  ledger.writeUInt8(3, 104);
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>();
  accounts.set(vault.toBase58(), { data: vaultData, owner: programId });
  accounts.set(ledgerKey.toBase58(), { data: ledger, owner: programId });
  const connection = {
    getAccountInfo: (key: PublicKey) => Promise.resolve(accounts.get(key.toBase58()) ?? null),
  } as unknown as Connection;
  const snap = await readHoldVault(connection, programId, vault);
  assert.equal(snap.delaySecs, DAY);
  assert.equal(snap.pending.length, 1);
  assert.equal(snap.pending[0]?.id, 4n);
  assert.equal(snap.pending[0]?.amount, 9n);
  assert.equal(snap.pending[0]?.destination.toBase58(), destination.toBase58());
  assert.equal(snap.pending[0]?.unlockAt, CREATED + DAY);
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0]?.kind, 3);
  assert.equal(snap.entries[0]?.withdrawalId, 4n);
  accounts.set(vault.toBase58(), { data: vaultData.subarray(0, 1291), owner: programId });
  assert.deepEqual(await readHoldVault(connection, programId, vault), snap,
    "legacy holds retain the same alerts while the owner arranges migration");
  accounts.set(vault.toBase58(), { data: vaultData.subarray(0, 1290), owner: programId });
  await assert.rejects(readHoldVault(connection, programId, vault), /need 1691/);
});
