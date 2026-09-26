import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { HoldVault, holdLedgerPda, holdTokenPda, holdVaultPda } from "./hold.js";
import { HOLD_LEDGER_DISCRIMINATOR, HOLD_VAULT_DISCRIMINATOR, PROGRAM_ID } from "./idl.js";
import { FakeConnection, asConnection } from "./testkit.js";

const DAY = 86_400n;
const VAULT_LEN = 1691;
const LEDGER_LEN = 2096;

function disc(name: string): Buffer {
  const idl = JSON.parse(readFileSync(fileURLToPath(new URL("../idl/veto.json", import.meta.url)), "utf8")) as {
    instructions: { name: string; discriminator: number[] }[];
  };
  const found = idl.instructions.find((item) => item.name === name);
  assert.ok(found, name);
  return Buffer.from(found.discriminator);
}

function rig() {
  const fake = new FakeConnection();
  fake.signature = "sig-hold";
  return {
    fake,
    hold: new HoldVault({ connection: asConnection(fake) }),
    owner: Keypair.generate(),
    guardian: Keypair.generate(),
    payer: Keypair.generate(),
    mint: Keypair.generate().publicKey,
    source: Keypair.generate().publicKey,
    destination: Keypair.generate().publicKey,
    safe: Keypair.generate().publicKey,
    vaultId: 7n,
  };
}

function opened(fake: FakeConnection): { tx: Transaction; ix: TransactionInstruction } {
  const raw = fake.sent[0];
  assert.ok(raw, "a transaction was sent");
  const tx = Transaction.from(raw);
  assert.doesNotThrow(() => tx.verifySignatures());
  const ix = tx.instructions[0];
  assert.ok(ix);
  return { tx, ix };
}

function assertMetas(
  ix: TransactionInstruction,
  rows: Array<[PublicKey, boolean, boolean]>,
): void {
  assert.equal(ix.keys.length, rows.length);
  rows.forEach((row, i) => {
    const key = ix.keys[i];
    assert.ok(key);
    assert.equal(key.pubkey.toBase58(), row[0].toBase58(), `account ${i}`);
    assert.equal(key.isSigner, row[1], `signer ${i}`);
    assert.equal(key.isWritable, row[2], `writable ${i}`);
  });
}

function places(owner: PublicKey, vaultId: bigint) {
  const vault = holdVaultPda(PROGRAM_ID, owner, vaultId);
  return { vault, ledger: holdLedgerPda(PROGRAM_ID, vault), vaultToken: holdTokenPda(PROGRAM_ID, vault) };
}

test("initVault builds init_vault for that owner and vault id and sends it", async () => {
  const r = rig();
  const sent = await r.hold.initVault({
    owner: r.owner,
    vaultId: r.vaultId,
    guardian: r.guardian.publicKey,
    safeAddress: r.safe,
    dailyLimit: 1_000n,
    delaySecs: DAY,
    bigShareBps: 2_500,
    mint: r.mint,
  });
  const { tx, ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.equal(sent.signature, "sig-hold");
  assert.equal(sent.vault.toBase58(), where.vault.toBase58());
  assert.equal(sent.ledger.toBase58(), where.ledger.toBase58());
  assert.equal(sent.vaultToken.toBase58(), where.vaultToken.toBase58());
  assert.equal(tx.feePayer?.toBase58(), r.owner.publicKey.toBase58());
  assert.equal(tx.signatures.length, 1);
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58());
  assert.equal(ix.data.length, 98);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("init_vault"));
  assert.equal(ix.data.readBigUInt64LE(8), r.vaultId);
  assert.equal(new PublicKey(ix.data.subarray(16, 48)).toBase58(), r.guardian.publicKey.toBase58());
  assert.equal(new PublicKey(ix.data.subarray(48, 80)).toBase58(), r.safe.toBase58());
  assert.equal(ix.data.readBigUInt64LE(80), 1_000n);
  assert.equal(ix.data.readBigInt64LE(88), DAY);
  assert.equal(ix.data.readUInt16LE(96), 2_500);
  assertMetas(ix, [
    [r.owner.publicKey, true, true],
    [where.vault, false, true],
    [where.ledger, false, true],
    [where.vaultToken, false, true],
    [r.mint, false, false],
    [TOKEN_PROGRAM_ID, false, false],
    [SystemProgram.programId, false, false],
  ]);
});

test("deposit builds a deposit of that amount from the owner source", async () => {
  const r = rig();
  await r.hold.deposit({
    owner: r.owner,
    vaultId: r.vaultId,
    source: r.source,
    mint: r.mint,
    amount: 42n,
  });
  const { ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("deposit"));
  assert.equal(ix.data.readBigUInt64LE(8), 42n);
  assert.equal(ix.data.length, 16);
  assertMetas(ix, [
    [r.owner.publicKey, true, true],
    [where.vault, false, true],
    [where.ledger, false, true],
    [r.source, false, true],
    [where.vaultToken, false, true],
    [r.mint, false, false],
    [TOKEN_PROGRAM_ID, false, false],
  ]);
});

test("withdraw builds a withdraw of that amount to the destination", async () => {
  const r = rig();
  await r.hold.withdraw({
    owner: r.owner,
    vaultId: r.vaultId,
    destination: r.destination,
    mint: r.mint,
    amount: 77n,
  });
  const { ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("withdraw"));
  assert.equal(ix.data.readBigUInt64LE(8), 77n);
  assertMetas(ix, [
    [r.owner.publicKey, true, true],
    [where.vault, false, true],
    [where.ledger, false, true],
    [where.vaultToken, false, true],
    [r.destination, false, true],
    [r.mint, false, false],
    [TOKEN_PROGRAM_ID, false, false],
  ]);
});

test("execute builds an execute the payer signs and the instruction does not", async () => {
  const r = rig();
  await r.hold.execute({
    payer: r.payer,
    owner: r.owner.publicKey,
    vaultId: r.vaultId,
    destination: r.destination,
    mint: r.mint,
    id: 4n,
  });
  const { tx, ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.equal(tx.feePayer?.toBase58(), r.payer.publicKey.toBase58());
  assert.equal(tx.signatures.length, 1);
  assert.equal(ix.keys.some((key) => key.pubkey.equals(r.payer.publicKey)), false);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("execute"));
  assert.equal(ix.data.readBigUInt64LE(8), 4n);
  assertMetas(ix, [
    [where.vault, false, true],
    [where.ledger, false, true],
    [where.vaultToken, false, true],
    [r.destination, false, true],
    [r.mint, false, false],
    [TOKEN_PROGRAM_ID, false, false],
  ]);
});

test("stop builds a stop signed by the authority", async () => {
  const r = rig();
  await r.hold.stop({
    authority: r.guardian,
    owner: r.owner.publicKey,
    vaultId: r.vaultId,
    id: 9n,
  });
  const { tx, ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.equal(tx.feePayer?.toBase58(), r.guardian.publicKey.toBase58());
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("stop"));
  assert.equal(ix.data.readBigUInt64LE(8), 9n);
  assertMetas(ix, [
    [r.guardian.publicKey, true, true],
    [where.vault, false, true],
    [where.ledger, false, true],
  ]);
});

test("freeze builds a freeze signed by the authority", async () => {
  const r = rig();
  await r.hold.freeze({ authority: r.owner, owner: r.owner.publicKey, vaultId: r.vaultId });
  const { ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("freeze"));
  assert.equal(ix.data.length, 8);
  assertMetas(ix, [
    [r.owner.publicKey, true, true],
    [where.vault, false, true],
    [where.ledger, false, true],
  ]);
});

test("unfreeze builds an unfreeze signed by the owner and the guardian", async () => {
  const r = rig();
  await r.hold.unfreeze({ owner: r.owner, guardian: r.guardian, vaultId: r.vaultId });
  const { tx, ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.equal(tx.signatures.length, 2);
  assert.equal(tx.signatures[0]?.publicKey.toBase58(), r.owner.publicKey.toBase58());
  assert.equal(tx.signatures[1]?.publicKey.toBase58(), r.guardian.publicKey.toBase58());
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("unfreeze"));
  assert.equal(ix.data.length, 8);
  assertMetas(ix, [
    [r.owner.publicKey, true, true],
    [r.guardian.publicKey, true, false],
    [where.vault, false, true],
    [where.ledger, false, true],
  ]);
});

test("unfreeze without a guardian leaves that account as the program id and unsigned", async () => {
  const r = rig();
  await r.hold.unfreeze({ owner: r.owner, vaultId: r.vaultId });
  const { tx, ix } = opened(r.fake);
  assert.equal(tx.signatures.length, 1);
  assert.equal(ix.keys[1]?.pubkey.toBase58(), PROGRAM_ID.toBase58());
  assert.equal(ix.keys[1]?.isSigner, false);
  assert.equal(ix.keys[1]?.isWritable, false);
});

test("skip builds a skip signed by the owner and the guardian", async () => {
  const r = rig();
  await r.hold.skip({
    owner: r.owner,
    guardian: r.guardian,
    vaultId: r.vaultId,
    destination: r.destination,
    mint: r.mint,
    id: 3n,
  });
  const { tx, ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.equal(tx.signatures.length, 2);
  assert.equal(tx.signatures[0]?.publicKey.toBase58(), r.owner.publicKey.toBase58());
  assert.equal(tx.signatures[1]?.publicKey.toBase58(), r.guardian.publicKey.toBase58());
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("skip"));
  assert.equal(ix.data.readBigUInt64LE(8), 3n);
  assertMetas(ix, [
    [r.owner.publicKey, true, true],
    [r.guardian.publicKey, true, false],
    [where.vault, false, true],
    [where.ledger, false, true],
    [where.vaultToken, false, true],
    [r.destination, false, true],
    [r.mint, false, false],
    [TOKEN_PROGRAM_ID, false, false],
  ]);
});

test("recover builds a recover to the safe token account", async () => {
  const r = rig();
  await r.hold.recover({
    authority: r.guardian,
    owner: r.owner.publicKey,
    vaultId: r.vaultId,
    destination: r.destination,
    mint: r.mint,
  });
  const { ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("recover"));
  assert.equal(ix.data.length, 8);
  assertMetas(ix, [
    [r.guardian.publicKey, true, true],
    [where.vault, false, true],
    [where.ledger, false, true],
    [where.vaultToken, false, true],
    [r.destination, false, true],
    [r.mint, false, false],
    [TOKEN_PROGRAM_ID, false, false],
  ]);
});

test("proposeChange builds a propose_change carrying the new rules", async () => {
  const r = rig();
  await r.hold.proposeChange({
    owner: r.owner,
    vaultId: r.vaultId,
    dailyLimit: 50n,
    delaySecs: 2n * DAY,
    bigShareBps: 1_000,
    guardian: r.guardian.publicKey,
    safeAddress: r.safe,
  });
  const { ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.equal(ix.data.length, 90);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("propose_change"));
  assert.equal(ix.data.readBigUInt64LE(8), 50n);
  assert.equal(ix.data.readBigInt64LE(16), 2n * DAY);
  assert.equal(ix.data.readUInt16LE(24), 1_000);
  assert.equal(new PublicKey(ix.data.subarray(26, 58)).toBase58(), r.guardian.publicKey.toBase58());
  assert.equal(new PublicKey(ix.data.subarray(58, 90)).toBase58(), r.safe.toBase58());
  assertMetas(ix, [
    [r.owner.publicKey, true, true],
    [where.vault, false, true],
    [where.ledger, false, true],
  ]);
});

test("applyChange builds an apply_change signed by the payer", async () => {
  const r = rig();
  await r.hold.applyChange({ payer: r.payer, owner: r.owner.publicKey, vaultId: r.vaultId });
  const { tx, ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.equal(tx.feePayer?.toBase58(), r.payer.publicKey.toBase58());
  assert.equal(ix.keys.some((key) => key.pubkey.equals(r.payer.publicKey)), false);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("apply_change"));
  assert.equal(ix.data.length, 8);
  assertMetas(ix, [
    [where.vault, false, true],
    [where.ledger, false, true],
  ]);
});

test("cancelChange builds a cancel_change signed by the authority", async () => {
  const r = rig();
  await r.hold.cancelChange({ authority: r.guardian, owner: r.owner.publicKey, vaultId: r.vaultId });
  const { ix } = opened(r.fake);
  const where = places(r.owner.publicKey, r.vaultId);
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), disc("cancel_change"));
  assert.equal(ix.data.length, 8);
  assertMetas(ix, [
    [r.guardian.publicKey, true, true],
    [where.vault, false, true],
    [where.ledger, false, true],
  ]);
});

function putAccount(fake: FakeConnection, address: PublicKey, data: Buffer): void {
  fake.accounts.set(address.toBase58(), { data, owner: PROGRAM_ID, lamports: 1 });
}

test("readVault returns the rules, the known destinations, the pending withdrawals, and the ledger", async () => {
  const r = rig();
  const vault = Keypair.generate().publicKey;
  const token = Keypair.generate().publicKey;
  const known = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const data = Buffer.alloc(VAULT_LEN);
  data.set(HOLD_VAULT_DISCRIMINATOR, 0);
  data.set(r.owner.publicKey.toBuffer(), 8);
  data.set(r.guardian.publicKey.toBuffer(), 40);
  data.set(r.safe.toBuffer(), 72);
  data.set(r.mint.toBuffer(), 104);
  data.set(token.toBuffer(), 136);
  data.writeBigUInt64LE(7n, 168);
  data.writeBigUInt64LE(1_000n, 176);
  data.writeBigUInt64LE(40n, 184);
  data.writeBigInt64LE(1_700_000_000n, 192);
  data.writeBigInt64LE(DAY, 200);
  data.writeBigInt64LE(0n, 208);
  data.writeBigUInt64LE(5n, 216);
  data.writeUInt16LE(2_500, 224);
  data.writeUInt8(1, 226);
  data.writeUInt8(1, 227);
  data.writeUInt8(9, 228);
  data.writeUInt8(8, 229);
  data.writeUInt8(7, 230);
  data.set(known.toBuffer(), 231);
  data.set(other.toBuffer(), 263);
  const pending = 743;
  data.writeBigUInt64LE(4n, pending);
  data.writeBigUInt64LE(9n, pending + 8);
  data.set(r.destination.toBuffer(), pending + 16);
  data.writeBigInt64LE(1_700_086_400n, pending + 48);
  data.writeUInt8(1, pending + 56);
  data.writeBigUInt64LE(99n, pending + 57);
  data.writeUInt8(0, pending + 57 + 56);
  data.writeUInt8(1, 1199);
  data.writeUInt8(3, 1200);
  data.writeUInt16LE(100, 1201);
  data.writeBigUInt64LE(12n, 1203);
  data.writeBigInt64LE(DAY * 2n, 1211);
  data.set(r.guardian.publicKey.toBuffer(), 1219);
  data.set(r.safe.toBuffer(), 1251);
  data.writeBigInt64LE(1_800_000_000n, 1283);
  putAccount(r.fake, vault, data);

  const ledgerKey = holdLedgerPda(PROGRAM_ID, vault);
  const ledger = Buffer.alloc(LEDGER_LEN);
  ledger.set(HOLD_LEDGER_DISCRIMINATOR, 0);
  ledger.set(vault.toBuffer(), 8);
  ledger.writeUInt32LE(2, 40);
  ledger.writeUInt16LE(2, 44);
  ledger.writeUInt8(7, 46);
  ledger.writeBigInt64LE(11n, 48);
  ledger.writeBigUInt64LE(9n, 56);
  ledger.set(r.destination.toBuffer(), 64);
  ledger.writeBigUInt64LE(4n, 96);
  ledger.writeUInt8(3, 104);
  ledger.writeUInt8(0, 105);
  ledger.writeBigInt64LE(22n, 112);
  ledger.writeBigUInt64LE(9n, 120);
  ledger.writeUInt8(4, 168);
  putAccount(r.fake, ledgerKey, ledger);

  const view = await r.hold.readVault(vault);
  assert.equal(view.account.owner.toBase58(), r.owner.publicKey.toBase58());
  assert.equal(view.account.guardian.toBase58(), r.guardian.publicKey.toBase58());
  assert.equal(view.account.safeAddress.toBase58(), r.safe.toBase58());
  assert.equal(view.account.mint.toBase58(), r.mint.toBase58());
  assert.equal(view.account.vaultToken.toBase58(), token.toBase58());
  assert.equal(view.account.vaultId, 7n);
  assert.equal(view.account.dailyLimit, 1_000n);
  assert.equal(view.account.windowSpent, 40n);
  assert.equal(view.account.windowStart, 1_700_000_000n);
  assert.equal(view.account.delaySecs, DAY);
  assert.equal(view.account.nextWithdrawalId, 5n);
  assert.equal(view.account.bigShareBps, 2_500);
  assert.equal(view.account.frozen, true);
  assert.equal(view.account.bump, 9);
  assert.deepEqual(view.account.known.map((key) => key.toBase58()), [known.toBase58()]);
  assert.equal(view.pending.length, 1);
  assert.equal(view.pending[0]?.id, 4n);
  assert.equal(view.pending[0]?.amount, 9n);
  assert.equal(view.pending[0]?.destination.toBase58(), r.destination.toBase58());
  assert.equal(view.pending[0]?.unlockAt, 1_700_086_400n);
  assert.equal(view.account.change.active, true);
  assert.equal(view.account.change.fields, 3);
  assert.equal(view.account.change.bigShareBps, 100);
  assert.equal(view.account.change.dailyLimit, 12n);
  assert.equal(view.account.change.delaySecs, DAY * 2n);
  assert.equal(view.account.change.effectiveAt, 1_800_000_000n);
  assert.equal(view.ledger.vault.toBase58(), vault.toBase58());
  assert.equal(view.ledger.total, 2);
  assert.equal(view.ledger.entries.length, 2);
  assert.equal(view.ledger.entries[0]?.ts, 11n);
  assert.equal(view.ledger.entries[0]?.kind, 3);
  assert.equal(view.ledger.entries[0]?.withdrawalId, 4n);
  assert.equal(view.ledger.entries[1]?.ts, 22n);
  assert.equal(view.ledger.entries[1]?.kind, 4);
});

test("a wrapped hold ledger is read oldest first", async () => {
  const r = rig();
  const vault = Keypair.generate().publicKey;
  const data = Buffer.alloc(LEDGER_LEN);
  data.set(HOLD_LEDGER_DISCRIMINATOR, 0);
  data.set(vault.toBuffer(), 8);
  data.writeUInt32LE(33, 40);
  data.writeUInt16LE(1, 44);
  data.writeBigInt64LE(999n, 48);
  data.writeBigInt64LE(111n, 112);
  putAccount(r.fake, vault, data);
  const ledger = await r.hold.fetchLedger(vault);
  assert.equal(ledger.entries.length, 32);
  assert.equal(ledger.entries[0]?.ts, 111n);
  assert.equal(ledger.entries[31]?.ts, 999n);
});

test("fetchVault rejects an account the program does not own", async () => {
  const r = rig();
  const vault = Keypair.generate().publicKey;
  const data = Buffer.alloc(VAULT_LEN);
  data.set(HOLD_VAULT_DISCRIMINATOR, 0);
  r.fake.accounts.set(vault.toBase58(), { data, owner: Keypair.generate().publicKey, lamports: 1 });
  await assert.rejects(() => r.hold.fetchVault(vault), /not owned by the Veto program/);
});

type Installed = {
  vault: PublicKey;
  destination: PublicKey;
};

function install(
  fake: FakeConnection,
  spec: {
    dailyLimit?: bigint;
    dailyBuckets?: { hour: bigint; amount: bigint }[];
    windowSpent?: bigint;
    windowStart?: bigint;
    delaySecs?: bigint;
    bigShareBps?: number;
    frozen?: boolean;
    known?: PublicKey[];
    pending?: number;
    balance: bigint;
    destination?: PublicKey;
  },
): Installed {
  const vault = Keypair.generate().publicKey;
  const token = Keypair.generate().publicKey;
  const destination = spec.destination ?? Keypair.generate().publicKey;
  const data = Buffer.alloc(VAULT_LEN);
  data.set(HOLD_VAULT_DISCRIMINATOR, 0);
  data.set(token.toBuffer(), 136);
  data.writeBigUInt64LE(spec.dailyLimit ?? 1_000_000n, 176);
  const buckets = spec.dailyBuckets ?? [{ hour: (spec.windowStart ?? 0n) / 3600n, amount: spec.windowSpent ?? 0n }];
  buckets.forEach((bucket, i) => {
    data.writeBigInt64LE(bucket.hour, 1291 + i * 16);
    data.writeBigUInt64LE(bucket.amount, 1299 + i * 16);
  });
  data.writeBigUInt64LE(spec.windowSpent ?? 0n, 184);
  data.writeBigInt64LE(spec.windowStart ?? 0n, 192);
  data.writeBigInt64LE(spec.delaySecs ?? DAY, 200);
  data.writeUInt16LE(spec.bigShareBps ?? 2_500, 224);
  data.writeUInt8(spec.frozen === true ? 1 : 0, 226);
  const known = spec.known ?? [destination];
  data.writeUInt8(known.length, 227);
  known.forEach((key, i) => data.set(key.toBuffer(), 231 + i * 32));
  const slots = spec.pending ?? 0;
  for (let i = 0; i < slots; i += 1) {
    const off = 743 + i * 57;
    data.writeBigUInt64LE(BigInt(i + 1), off);
    data.writeBigUInt64LE(1n, off + 8);
    data.set(destination.toBuffer(), off + 16);
    data.writeBigInt64LE(1n, off + 48);
    data.writeUInt8(1, off + 56);
  }
  putAccount(fake, vault, data);
  const tokenData = Buffer.alloc(165);
  tokenData.writeBigUInt64LE(spec.balance, 64);
  fake.accounts.set(token.toBase58(), { data: tokenData, owner: TOKEN_PROGRAM_ID, lamports: 1 });
  return { vault, destination };
}

const NOW = 1_700_000_000n;

test("a withdrawal inside the daily limit, the share, and the known list pays at once", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 1_000_000n, bigShareBps: 2_500 });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 1_000n,
    destination: installed.destination,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "at_once" });
});

test("a withdrawal over the daily limit is held because it is over the daily limit", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 1_000_000n, dailyLimit: 1_000n, bigShareBps: 10_000 });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 1_001n,
    destination: installed.destination,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "held", reasons: ["over_daily_limit"], unlockAt: NOW + DAY });
});

test("a withdrawal to a new address is held because the address is new", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 1_000_000n, bigShareBps: 10_000, known: [] });
  const fresh = Keypair.generate().publicKey;
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 1n,
    destination: fresh,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "held", reasons: ["new_address"], unlockAt: NOW + DAY });
});

test("a destination written past known_len is still a new address", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 1_000_000n, bigShareBps: 10_000, known: [] });
  const stored = r.fake.accounts.get(installed.vault.toBase58());
  assert.ok(stored);
  stored.data.set(installed.destination.toBuffer(), 231);
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 1n,
    destination: installed.destination,
    now: NOW,
  });
  assert.equal(outlook.outcome, "held");
  if (outlook.outcome === "held") assert.deepEqual(outlook.reasons, ["new_address"]);
});

test("a withdrawal over the share of the vault is held because it is over the share", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 10_000n, bigShareBps: 2_500, dailyLimit: 1_000_000n });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 2_501n,
    destination: installed.destination,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "held", reasons: ["over_share"], unlockAt: NOW + DAY });
});

test("a withdrawal equal to the share pays at once", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 10_000n, bigShareBps: 2_500, dailyLimit: 1_000_000n });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 2_500n,
    destination: installed.destination,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "at_once" });
});

test("a withdrawal from a frozen vault is held because the vault is frozen", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 1_000_000n, bigShareBps: 10_000, frozen: true });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 1n,
    destination: installed.destination,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "held", reasons: ["frozen"], unlockAt: NOW + DAY });
});

test("a withdrawal that breaks several rules lists each reason", async () => {
  const r = rig();
  const installed = install(r.fake, {
    balance: 10_000n,
    bigShareBps: 2_500,
    dailyLimit: 1_000n,
    frozen: true,
    known: [],
  });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 3_000n,
    destination: Keypair.generate().publicKey,
    now: NOW,
  });
  assert.deepEqual(outlook, {
    outcome: "held",
    reasons: ["frozen", "new_address", "over_daily_limit", "over_share"],
    unlockAt: NOW + DAY,
  });
});

test("a withdrawal the vault cannot cover is refused for insufficient funds", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 40n, frozen: true, bigShareBps: 10_000 });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 50n,
    destination: installed.destination,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "refused", reason: "insufficient_funds" });
});

test("a withdrawal that would wait is refused when the pending list is full", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 1_000_000n, bigShareBps: 10_000, known: [], pending: 8 });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 1n,
    destination: Keypair.generate().publicKey,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "refused", reason: "pending_full" });
});

test("a withdrawal that pays at once still pays when the pending list is full", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 1_000_000n, bigShareBps: 10_000, pending: 8 });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 1n,
    destination: installed.destination,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "at_once" });
});

test("allowance returns only after the oldest hourly bucket expires", async () => {
  const r = rig();
  const start = 1_000_000n;
  const installed = install(r.fake, {
    balance: 1_000_000n,
    bigShareBps: 10_000,
    dailyLimit: 500n,
    windowSpent: 500n,
    windowStart: start,
  });
  const open = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 1n,
    destination: installed.destination,
    now: (start / 3600n + 25n) * 3600n,
  });
  assert.deepEqual(open, { outcome: "at_once" });
  const still = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 1n,
    destination: installed.destination,
    now: start + DAY - 1n,
  });
  assert.equal(still.outcome, "held");
  if (still.outcome === "held") assert.deepEqual(still.reasons, ["over_daily_limit"]);
});

test("a withdrawal of zero is rejected before it is described as paid or held", async () => {
  const r = rig();
  const installed = install(r.fake, { balance: 10n });
  await assert.rejects(
    () => r.hold.previewWithdrawal({
      vault: installed.vault,
      amount: 0n,
      destination: installed.destination,
      now: NOW,
    }),
    /amount must be positive/,
  );
});

test("the share preview holds a burst across the old window edge", async () => {
  const r = rig();
  const start = NOW - DAY;
  const installed = install(r.fake, {
    balance: 800n,
    dailyLimit: 10_000n,
    bigShareBps: 2_500,
    windowStart: start,
    windowSpent: 201n,
    dailyBuckets: [{ hour: (NOW - 1n) / 3600n, amount: 201n }],
  });
  const outlook = await r.hold.previewWithdrawal({
    vault: installed.vault,
    amount: 100n,
    destination: installed.destination,
    now: NOW,
  });
  assert.deepEqual(outlook, { outcome: "held", reasons: ["over_share"], unlockAt: NOW + DAY });
});

test("migration signs with the owner and funds rent using the IDL account order", async () => {
  const { fake, hold, owner, vaultId } = rig();
  await hold.migrateHoldVault({ owner, vaultId });
  const { ix } = opened(fake);
  assert.deepEqual(ix.data, disc("migrate_hold_vault"));
  assertMetas(ix, [[owner.publicKey, true, true],
    [places(owner.publicKey, vaultId).vault, false, true],
    [places(owner.publicKey, vaultId).ledger, false, true], [SystemProgram.programId, false, false]]);
});

test("closure signs with the owner and supplies the safe destination and rent accounts", async () => {
  const { fake, hold, owner, vaultId, destination, mint } = rig();
  await hold.closeHoldVault({ owner, vaultId, destination, mint });
  const { ix } = opened(fake);
  const where = places(owner.publicKey, vaultId);
  assert.deepEqual(ix.data, disc("close_hold_vault"));
  assertMetas(ix, [[owner.publicKey, true, true], [where.vault, false, true],
    [where.ledger, false, true], [where.vaultToken, false, true], [destination, false, true],
    [mint, false, false], [TOKEN_PROGRAM_ID, false, false]]);
});
