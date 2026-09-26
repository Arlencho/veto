import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import * as hold from "./hold.js";

for (const [name, kind] of [["HoldMigrated", "migrated"], ["HoldClosed", "closed"]]) {
  test(`${name} decodes movement history without live accounts`, () => {
    const vault = new PublicKey(Buffer.alloc(32, 1)).toBase58();
    const owner = new PublicKey(Buffer.alloc(32, 2)).toBase58();
    const destination = new PublicKey(Buffer.alloc(32, 3)).toBase58();
    const raw = Buffer.alloc(112);
    createHash("sha256").update(`event:${name}`).digest().copy(raw, 0, 0, 8);
    new PublicKey(vault).toBuffer().copy(raw, 8);
    new PublicKey(owner).toBuffer().copy(raw, 40);
    raw.writeBigUInt64LE(9007199254740993n, 72);
    new PublicKey(destination).toBuffer().copy(raw, 80);
    const data = `Program data: ${raw.toString("base64")}`;
    const logs = [`Program ${owner} invoke [1]`, data, `Program ${owner} success`];
    assert.deepEqual(hold.decodeHoldLifecycleEvents(logs, owner), [{ kind, vault, owner, amount: 9007199254740993n, destination }]);
    assert.deepEqual(hold.decodeHoldLifecycleEvents(logs, owner, true), []);
    assert.deepEqual(hold.decodeHoldLifecycleEvents(logs, destination), []);
    assert.deepEqual(hold.decodeHoldLifecycleEvents([data], owner), []);
    assert.deepEqual(hold.decodeHoldLifecycleEvents([`Program ${owner} invoke [1]`, `Program ${destination} invoke [2]`, data, `Program ${destination} success`, `Program ${owner} success`], owner), []);
    assert.deepEqual(hold.decodeHoldLifecycleEvents([`Program ${owner} invoke [1]`, `Program data: ${raw.subarray(0, 111).toString("base64")}`, `Program ${owner} success`], owner), []);
  });
}
