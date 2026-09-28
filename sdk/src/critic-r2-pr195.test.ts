// Backend critic fixtures, PR 195 round 2.
// R8 is the source-level lock for F1: nothing under sdk/ that ships reads a Veto
// text line. R9 and R10 are the two no-event shapes R2 did not cover: a frame that
// closes cleanly with the text line and no Program data, and a transaction whose
// logMessages is null. R11 locks the npm install line, the publication sentences,
// and the example usage.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { VetoAgent } from "./agent.js";
import { PROGRAM_ID } from "./idl.js";
import { ledgerPda } from "./layout.js";
import { TOKEN_PROGRAM, legacyChargeTx, world } from "./testkit.js";

const PROGRAM = PROGRAM_ID.toBase58();
const SDK_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function keysFor(w: ReturnType<typeof world>): PublicKey[] {
  return [
    w.agent.publicKey,
    w.mandate,
    ledgerPda(PROGRAM_ID, w.mandate),
    w.source.publicKey,
    w.destination.publicKey,
    w.mint.publicKey,
    TOKEN_PROGRAM,
    PROGRAM_ID,
  ];
}

function shippedFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["src", "examples"]) {
    for (const name of readdirSync(`${SDK_ROOT}${dir}`)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "testkit.ts") continue;
      out.push(`${dir}/${name}`);
    }
  }
  return out;
}

test("R8 no shipped file under sdk/ matches a Veto text line or names the removed text parser", () => {
  const files = shippedFiles();
  assert.ok(files.includes("src/events.ts") && files.includes("examples/pay-once.ts"));
  const banned = [/VETO PAID/, /VETO REFUSED/, /override_to_clear/, /parseVetoTextLog/, /decisionFromChargeLog/];
  for (const file of files) {
    const text = readFileSync(`${SDK_ROOT}${file}`, "utf8");
    for (const pattern of banned) {
      assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
    }
  }
  // The only log regexes left are the frame markers and the Program data line.
  const events = readFileSync(`${SDK_ROOT}src/events.ts`, "utf8");
  const regexLiterals = events.match(/= \/\^.*\/;$/gm) ?? [];
  assert.deepEqual(
    regexLiterals.map((line) => line.slice(0, 20)),
    ["= /^Program data: ([", "= /^Program ([1-9A-H", "= /^Program ([1-9A-H"],
  );
});

test("R9 charge fails loudly on a Veto frame that closes cleanly with the text line and no event", async () => {
  // No "Log truncated" marker: the runtime drops it when the flood sits in a later
  // instruction, so absence of the event is the only signal and it must fail closed.
  const w = world();
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  const amount = 10_000_001n;
  w.fake.signature = "sig-r9";
  w.fake.transactions.set(
    "sig-r9",
    legacyChargeTx({
      signature: "sig-r9",
      slot: 78,
      blockTime: 1_790_202_461,
      logs: [
        `Program ${PROGRAM} invoke [1]`,
        "Program log: Instruction: Charge",
        `Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=${amount} per_tx_max=10000000 remaining=300000000 override_to_clear=${amount}`,
        `Program ${PROGRAM} consumed 12417 of 200000 compute units`,
        `Program ${PROGRAM} success`,
      ],
      keys: keysFor(w),
      amount,
      nonce: 1n,
    }),
  );
  await assert.rejects(() => veto.charge({ amount, nonce: 1n }), /carries no attributable Veto decision/);
});

test("R10 charge fails loudly when the confirmed transaction carries logMessages null", async () => {
  const w = world();
  const veto = new VetoAgent({ connection: w.connection, agent: w.agent, mandate: w.mandate });
  w.fake.signature = "sig-r10";
  const tx = legacyChargeTx({
    signature: "sig-r10",
    slot: 79,
    blockTime: 1_790_202_462,
    logs: [],
    keys: keysFor(w),
    amount: 5n,
    nonce: 1n,
  }) as unknown as { meta: { logMessages: string[] | null } };
  tx.meta.logMessages = null;
  w.fake.transactions.set("sig-r10", tx as never);
  await assert.rejects(() => veto.charge({ amount: 5n, nonce: 1n }), /carries no attributable Veto decision/);
});

test("R11 the README install line is the published package and the example usage is unchanged", () => {
  const readme = readFileSync(`${REPO_ROOT}README.md`, "utf8");
  const pkg = JSON.parse(readFileSync(`${SDK_ROOT}package.json`, "utf8")) as {
    name: string;
    version: string;
    private?: boolean;
    description: string;
    license: string;
    homepage: string;
    engines: { node: string };
    files: string[];
    scripts: { prepublishOnly: string };
    repository: { url: string; directory?: string };
  };
  assert.equal(pkg.name, "@veto-hq/agent-sdk");
  assert.equal(pkg.version, "0.1.1");
  assert.equal(pkg.private, false);
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.homepage, "https://github.com/Arlencho/veto");
  assert.equal(pkg.engines.node, ">=22");
  assert.deepEqual(pkg.files, ["dist", "README.md", "LICENSE"]);
  assert.equal(pkg.scripts.prepublishOnly, "npm run build && npm test");
  assert.match(pkg.repository.url, /github\.com\/Arlencho\/veto/);
  assert.equal(pkg.repository.directory, "sdk");
  const sentences = pkg.description.split(".").filter((part) => part.trim().length > 0);
  assert.equal(sentences.length, 1, "description is one sentence");

  const sectionStart = readme.indexOf("## Put your agent under a rule");
  assert.notEqual(sectionStart, -1, "README has the agent section");
  const sectionEnd = readme.indexOf("\n## ", sectionStart + 1);
  const section = readme.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  assert.match(section, /npm install @veto-hq\/agent-sdk/);
  assert.match(section, /Version 0\.1\.0 was published to npm on 2026-09-27\./);
  assert.doesNotMatch(section, /<date>/);
  assert.match(section, /The package is published from this checkout by the maintainer\./);
  assert.doesNotMatch(section, /not yet published/);
  assert.doesNotMatch(section, /Install this repo's package/);
  const lines = section.split("\n");
  const fenceStart = lines.findIndex((line, index) => line === "```bash" && lines[index + 1] === "cd sdk");
  assert.notEqual(fenceStart, -1, "the in-repo example is still fenced");
  const fenceEnd = lines.indexOf("```", fenceStart + 1);
  const block = lines.slice(fenceStart + 1, fenceEnd);
  assert.deepEqual(block, [
    "cd sdk",
    "npm ci",
    "npx tsx examples/pay-once.ts ../keys/agent.json <config.json> <amount-in-base-units>",
  ]);
  assert.ok(existsSync(`${SDK_ROOT}examples/pay-once.ts`));
  const example = readFileSync(`${SDK_ROOT}examples/pay-once.ts`, "utf8");
  assert.match(example, /usage: npx tsx examples\/pay-once\.ts <agent-key\.json> <config\.json> <amount>/);
  assert.match(example, /const \[keyFile, configFile, amount\] = process\.argv\.slice\(2\)/);
  assert.match(example, /loadAgentConfig/);
  assert.match(example, /fromConfig/);
  assert.doesNotMatch(example, /new Connection\(/);
  assert.match(readme, /keys\/agent\.json/);
  assert.match(readFileSync(`${REPO_ROOT}.gitignore`, "utf8"), /^keys\/$/m);
});
