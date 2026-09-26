import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { decisionsFromTx } from "./events.js";
import { decisionToJson } from "./format.js";

for (const [name, kind] of [["HoldMigrated", "hold_migrated"], ["HoldClosed", "hold_closed"]]) {
  test(`${name} retains the owner, vault, amount and destination after accounts disappear`, () => {
    const vault = new PublicKey(Buffer.alloc(32, 1)).toBase58();
    const owner = new PublicKey(Buffer.alloc(32, 2)).toBase58();
    const destination = new PublicKey(Buffer.alloc(32, 3)).toBase58();
    const raw = Buffer.alloc(112);
    createHash("sha256").update(`event:${name}`).digest().copy(raw, 0, 0, 8);
    new PublicKey(vault).toBuffer().copy(raw, 8);
    new PublicKey(owner).toBuffer().copy(raw, 40);
    raw.writeBigUInt64LE(9007199254740993n, 72);
    new PublicKey(destination).toBuffer().copy(raw, 80);
    const tx = { signature: "sig", slot: 1, blockTime: 2, err: null,
      logs: [`Program ${owner} invoke [1]`, `Program data: ${raw.toString("base64")}`, `Program ${owner} success`],
      accountKeys: [], instructions: [] };
    const rows = decisionsFromTx(tx, owner, vault);
    assert.equal(rows.length, 1);
    const json = decisionToJson(rows[0]!);
    assert.equal(json.kind, kind);
    assert.equal(json.vault, vault);
    assert.equal(json.owner, owner);
    assert.equal(json.destination, destination);
    assert.equal(json.amount, "9007199254740993");
    assert.deepEqual(decisionsFromTx({ ...tx, err: "failed" }, owner), []);
    assert.deepEqual(decisionsFromTx(tx, destination), []);
  });
}
