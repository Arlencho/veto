import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { type Idl } from "@coral-xyz/anchor";

import { decodeHoldVault } from "./hold.js";

const root = new URL("../", import.meta.url);
const copies = ["tools", "sdk", "watcher", "indexer"].map((pkg) => `${pkg}/idl/veto.json`);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

test("IDL copies agree with each other and the generated IDL when present", () => {
  const expected = read(copies[0]);
  for (const path of copies) assert.deepEqual(read(path), expected, path);
  if (existsSync(new URL("target/idl/veto.json", root))) {
    assert.deepEqual(read("target/idl/veto.json"), expected, "generated IDL");
    assert.equal(readFileSync(new URL("watcher/src/idl.ts", root), "utf8"),
      readFileSync(new URL("target/types/veto.ts", root), "utf8"), "generated watcher type");
  }
});

test("the tools IDL decodes all Hold rolling buckets without moving the existing fields", () => {
  const idl = read(copies[0]) as Idl;
  const bytes = Buffer.alloc(1691);
  bytes.set(idl.accounts!.find((account) => account.name === "HoldVault")!.discriminator);
  bytes.writeBigUInt64LE(777n, 176);
  bytes.writeBigInt64LE(86400n, 200);
  bytes.writeBigUInt64LE(42n, 743);
  bytes.writeUInt8(1, 799);
  bytes.writeBigInt64LE(123456n, 1283);
  for (let i = 0; i < 25; i++) {
    bytes.writeBigInt64LE(BigInt(i - 1), 1291 + 16 * i);
    bytes.writeBigUInt64LE(9007199254740993n + BigInt(i), 1299 + 16 * i);
  }
  const vault = decodeHoldVault(bytes);
  assert.equal(vault.daily_limit.toString(), "777");
  assert.equal(vault.delay_secs.toString(), "86400");
  assert.equal(vault.pending[0].id.toString(), "42");
  assert.equal(vault.change.effective_at.toString(), "123456");
  assert.equal(vault.daily_buckets.length, 25);
  for (let i = 0; i < 25; i++) {
    assert.equal(vault.daily_buckets[i].hour.toString(), String(i - 1));
    assert.equal(vault.daily_buckets[i].amount.toString(), String(9007199254740993n + BigInt(i)));
  }
  assert.throws(() => decodeHoldVault(bytes.subarray(0, 1291)));
});

test("all client error tables preserve the generated program codes and reasons", async () => {
  const idl = read(copies[0]);
  const expectedCodes = Object.fromEntries(idl.errors.map((e: { name: string; code: number }) => [e.name, e.code]));
  const expectedMessages = Object.fromEntries(idl.errors.map((e: { name: string; msg: string }) => [e.name, e.msg]));
  for (const path of ["app/lib/veto_errors.ts", "sdk/src/veto_errors.ts", "watcher/src/veto_errors.ts", "tools/veto_errors.ts"]) {
    const table = await import(new URL(path, root).href);
    assert.deepEqual(table.VetoErrorCode, expectedCodes, path);
    assert.deepEqual(table.VetoErrorMessage, expectedMessages, path);
  }
});
