import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { run } from "./commands.js";
import { configFile, vetoDir, writeKeyFile } from "./files.js";
import {
  chainOf,
  harness,
  openedWorld,
  plantCharge,
  removeHome,
  tempHome,
} from "./testkit.js";

test("pay, status, and decisions do not create a veto directory", async () => {
  const home = tempHome();
  const real = join(homedir(), ".veto");
  const before = existsSync(real) ? statSync(real).mtimeMs : null;
  try {
    const w = openedWorld();
    const runtime = harness(home, chainOf(w.fake));
    assert.equal(await run([], runtime), 0);
    assert.equal(await run(["trade"], runtime), 1);
    assert.equal(runtime.errs.at(-1), "Trading from the companion is switched off in this version. Agents trade through the SDK's trade().");
    assert.equal(await run(["pay", "1000"], runtime), 1);
    assert.equal(await run(["status"], runtime), 1);
    assert.equal(await run(["decisions"], runtime), 1);
    assert.equal(existsSync(vetoDir(home)), false);
    const after = existsSync(real) ? statSync(real).mtimeMs : null;
    assert.equal(after, before);
  } finally {
    removeHome(home);
  }
});

test("only connect writes the veto directory", async () => {
  const home = tempHome();
  const real = join(homedir(), ".veto");
  const beforeReal = existsSync(real) ? statSync(real).mtimeMs : null;
  try {
    const w = openedWorld();
    const keyFile = resolve(home, "agent.json");
    await writeKeyFile(keyFile, w.agent.secretKey);
    const runtime = harness(home, chainOf(w.fake));
    assert.equal(await run(["connect", "--key", keyFile, "--rule", w.mandate.toBase58()], runtime), 0);
    plantCharge(w, w.mandate, 1000n, 1n, "paid");
    const stamp = () => ({
      files: readdirSync(vetoDir(home)).sort(),
      config: statSync(configFile(home)).mtimeMs,
      configBody: readFileSync(configFile(home), "utf8"),
      keyBody: readFileSync(keyFile, "utf8"),
      keyMtime: statSync(keyFile).mtimeMs,
    });
    const before = stamp();
    const later = harness(home, chainOf(w.fake));
    assert.equal(await run(["pay", "1000"], later), 0);
    assert.equal(await run(["status"], later), 0);
    assert.equal(await run(["decisions"], later), 0);
    assert.deepEqual(stamp(), before);
    const afterReal = existsSync(real) ? statSync(real).mtimeMs : null;
    assert.equal(afterReal, beforeReal);
  } finally {
    removeHome(home);
  }
});

test("no command prints the secret key", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const secretJson = JSON.stringify(Array.from(w.agent.secretKey));
    const secretB64 = Buffer.from(w.agent.secretKey).toString("base64");
    const keyFile = resolve(home, "agent.json");
    await writeKeyFile(keyFile, w.agent.secretKey);
    const runtime = harness(home, chainOf(w.fake));
    assert.equal(await run(["connect", "--key", keyFile, "--rule", w.mandate.toBase58()], runtime), 0);
    plantCharge(w, w.mandate, 1000n, 1n, "refused", 1000n);
    const later = harness(home, chainOf(w.fake));
    assert.equal(await run(["pay", "1000"], later), 0);
    assert.equal(await run(["status"], later), 0);
    assert.equal(await run(["decisions"], later), 0);
    assert.equal(await run(["pay", "1.5"], later), 1);
    const spoken = [...runtime.lines, ...runtime.errs, ...later.lines, ...later.errs].join("\n");
    assert.equal(spoken.includes(secretJson), false);
    assert.equal(spoken.includes(secretJson.slice(1, 48)), false);
    assert.equal(spoken.includes(secretB64), false);
    assert.ok(spoken.includes(w.agent.publicKey.toBase58()));
  } finally {
    removeHome(home);
  }
});
