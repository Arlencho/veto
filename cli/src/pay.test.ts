import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { run } from "./commands.js";
import { DEVNET_USDC_MINT } from "./money.js";
import { vetoDir } from "./files.js";
import {
  chainOf,
  harness,
  openedWorld,
  output,
  plantCharge,
  plantDecoy,
  plantNewerRule,
  removeHome,
  retargetMint,
  saveSetup,
  tempHome,
} from "./testkit.js";
import { PublicKey, Transaction } from "./web3.js";

test("pay refuses an amount that is not an integer in base units", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "1.5"], runtime);
    assert.equal(code, 1);
    assert.equal(runtime.errs.join("\n"), "Amount must be an integer in base units.");
    assert.equal(w.fake.sent.length, 0);
    assert.equal(existsSync(vetoDir(home)), false);
  } finally {
    removeHome(home);
  }
});

test("pay refuses when no active rule", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ status: 1 });
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "1000"], runtime);
    assert.equal(code, 1);
    assert.equal(runtime.errs.join("\n"), "No active rule.");
    assert.equal(w.fake.sent.length, 0);
  } finally {
    removeHome(home);
  }
});

test("pay refuses when the rule has expired", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ expiresAt: 1n });
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "1000"], runtime);
    assert.equal(code, 1);
    assert.equal(runtime.errs.join("\n"), "No active rule.");
    assert.equal(w.fake.sent.length, 0);
  } finally {
    removeHome(home);
  }
});

test("pay prints a refusal and exits 0", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    retargetMint(w, DEVNET_USDC_MINT);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 1000n, 1n, "refused", 500_000n);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "1000"], runtime);
    assert.equal(code, 0);
    assert.equal(
      output(runtime),
      [
        "kind refused",
        "asked 0.001 USDC (1000 base units)",
        `payee ${w.merchant.publicKey.toBase58()}`,
        "reason 5 over per-payment maximum",
        "override 0.50 USDC",
        "signature sig-charge",
        "https://explorer.solana.com/tx/sig-charge?cluster=devnet",
      ].join("\n"),
    );
  } finally {
    removeHome(home);
  }
});

test("pay states the amount in the token and in base units, the payee, and the signature", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    retargetMint(w, DEVNET_USDC_MINT);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 5n, 1n, "paid");
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "5"], runtime);
    assert.equal(code, 0);
    assert.deepEqual(runtime.lines.slice(0, 3), [
      "kind paid",
      "amount 0.000005 USDC (5 base units)",
      `payee ${w.merchant.publicKey.toBase58()}`,
    ]);
    assert.ok(runtime.lines.includes("signature sig-charge"));
  } finally {
    removeHome(home);
  }
});

test("pay charges the saved rule, not a newer rule for this key from another owner", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const decoy = plantDecoy(w);
    const newer = plantNewerRule(w);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 1000n, 1n, "paid");
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "1000"], runtime);
    assert.equal(code, 0);
    const raw = w.fake.sent[0];
    assert.ok(raw);
    const ix = Transaction.from(raw).instructions[0];
    const charged = ix?.keys[1]?.pubkey.toBase58();
    assert.equal(charged, w.mandate.toBase58());
    assert.notEqual(charged, decoy);
    assert.notEqual(charged, newer);
  } finally {
    removeHome(home);
  }
});

test("pay uses the rule you name", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    plantNewerRule(w);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 1000n, 1n, "paid");
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "1000", "--rule", w.mandate.toBase58()], runtime);
    assert.equal(code, 0);
    const raw = w.fake.sent[0];
    assert.ok(raw);
    const ix = Transaction.from(raw).instructions[0];
    assert.equal(ix?.keys[1]?.pubkey.toBase58(), w.mandate.toBase58());
  } finally {
    removeHome(home);
  }
});

test("pay submits the pending override nonce", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ lastNonce: 1n, overrideNonce: 4n, overrideAmount: 2000n });
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 2000n, 4n, "paid");
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "2000"], runtime);
    assert.equal(code, 0);
    const raw = w.fake.sent[0];
    assert.ok(raw);
    const ix = Transaction.from(raw).instructions[0];
    assert.equal(ix?.data.readBigUInt64LE(16), 4n);
    assert.equal(output(runtime).includes("kind paid"), true);
  } finally {
    removeHome(home);
  }
});

test("pay does not submit a different amount while an override is pending", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ lastNonce: 1n, overrideNonce: 4n, overrideAmount: 2000n });
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "1000"], runtime);
    assert.equal(code, 1);
    assert.equal(w.fake.sent.length, 0);
    assert.match(runtime.errs.join("\n"), /does not clear the override/);
  } finally {
    removeHome(home);
  }
});

test("pay exits 1 when the RPC fails", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    await saveSetup(home, w);
    w.fake.sendRawTransaction = async () => {
      throw new Error("rpc unavailable");
    };
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "1000"], runtime);
    assert.equal(code, 1);
    assert.match(runtime.errs.join("\n"), /rpc unavailable/);
  } finally {
    removeHome(home);
  }
});
