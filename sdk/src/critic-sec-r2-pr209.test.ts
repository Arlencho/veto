// Security critic, round 2 on PR 209 (docs/phase2-191, closes #191).
//
// Round 1 (critic-sec-r1-pr209.test.ts) pinned five sentences that called a
// charge against the quoted rule reason 7 without bounding the amount. The fix
// (a107742) rewrote them as reason 5 over the per-payment limit and reason 7
// inside the limits. This round locks the rewritten pairing to the program and
// pairs every reason code and amount the docs quote with the chain.
//
// R5, R6, R7 are offline. R8 reads devnet and runs only with VETO_RPC set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

function sentences(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.replace(/\s+/g, " ").split(/(?<=\.)\s+(?=[A-Z`"'(-])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** reason_text() in lib.rs, keyed by the numeric constant in state.rs. */
function programReasons(): Map<number, string> {
  const state = read("programs/veto/src/state.rs");
  const lib = read("programs/veto/src/lib.rs");
  const codes = new Map<string, number>();
  for (const m of state.matchAll(/pub const (REASON_[A-Z_]+): u8 = (\d+);/g)) codes.set(m[1]!, Number(m[2]));
  const body = lib.slice(lib.indexOf("fn reason_text("), lib.indexOf("}", lib.indexOf("fn reason_text(")));
  const out = new Map<number, string>();
  for (const m of body.matchAll(/(REASON_[A-Z_]+) => "([^"]+)"/g)) {
    const code = codes.get(m[1]!);
    assert.notEqual(code, undefined, `${m[1]} has a constant in state.rs`);
    out.set(code!, m[2]!);
  }
  assert.equal(out.size, 11, "eleven reason texts in lib.rs");
  return out;
}

function docTable(rel: string, heading: RegExp): Map<number, string> {
  const text = read(rel);
  const start = text.search(heading);
  assert.ok(start >= 0, `${rel} has the reason heading`);
  const section = text.slice(start, text.indexOf("\n#", start + 1));
  const out = new Map<number, string>();
  for (const m of section.matchAll(/^\| (\d+) \| ([^|]+) \|$/gm)) out.set(Number(m[1]), m[2]!.trim());
  return out;
}

test("R5: the reason tables in README.md and DECISION_RECORD.md are the program's reason_text, code for code", () => {
  const program = programReasons();
  const readme = docTable("README.md", /### Refusal reasons/);
  const record = docTable("docs/DECISION_RECORD.md", /### Reason codes/);
  const readmeCodes = [...readme.keys()];
  assert.deepEqual(readmeCodes.filter((code) => code <= 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "README lists the ten refusal codes");
  assert.ok(readmeCodes.every((code) => code >= 1 && code <= 14), "README adds only the trade codes 11 to 14");
  assert.deepEqual([...record.keys()], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "DECISION_RECORD lists ok plus the ten");
  for (const [code, text] of program) {
    if (code !== 0) assert.equal(readme.get(code), text, `README code ${code}`);
    assert.equal(record.get(code), text, `DECISION_RECORD code ${code}`);
  }
});

const PAIRED_DOCS = ["docs/PITCH.md", "docs/VIDEO.md", "docs/SECURITY_REVIEW.md", "README.md"];

test("R6: every charge sentence that names reason 7 also pairs it with reason 5, over the per-payment limit, and inside the limits", () => {
  let hits = 0;
  for (const rel of PAIRED_DOCS) {
    for (const s of sentences(read(rel))) {
      if (!/reason 7/.test(s) || !/charge/i.test(s)) continue;
      hits += 1;
      // Order-free: the README sentence names the limit before reason 7.
      for (const part of [/reason 5/, /over the per-payment limit/i, /reason 7/, /inside the limits/i]) {
        assert.match(s, part, `${rel}: ${s}`);
      }
      assert.doesNotMatch(s, /before any limit/i, `${rel}: ${s}`);
    }
  }
  assert.equal(
    hits,
    2,
    "README id 1 and SECURITY_REVIEW id 1 still pair reason 5 with the per-payment limit and reason 7 with inside the limits",
  );
  // The program agrees: per-payment maximum, then cap, then delegate.
  const lib = read("programs/veto/src/lib.rs");
  const body = lib.slice(lib.indexOf("fn evaluate("), lib.indexOf("fn suggested_override("));
  assert.ok(body.indexOf("REASON_OVER_PER_TX_MAX") < body.indexOf("REASON_OVER_CAP"));
  assert.ok(body.indexOf("REASON_OVER_CAP") < body.indexOf("REASON_DELEGATE_MISSING"));
});

test("R7: VIDEO.md says the open is not a Decisions row, and the app lists paid, refused and override only", () => {
  const video = read("docs/VIDEO.md");
  assert.match(video, /The open is not listed on Decisions\./);
  assert.match(video, /16\.659625/);
  assert.doesNotMatch(video, /6\.2325/);
  assert.doesNotMatch(read("docs/DECK.md"), /6\.2325/);
  const format = read("app/lib/format.ts");
  const fn = format.slice(format.indexOf("export function isListedDecision("), format.indexOf("}", format.indexOf("export function isListedDecision(")));
  assert.match(fn, /KIND_PAID/);
  assert.match(fn, /KIND_REFUSED/);
  assert.match(fn, /KIND_OVERRIDE/);
  assert.doesNotMatch(fn, /KIND_OPENED/);
  // The program does write an opened row, so the app filter is what makes the sentence true.
  assert.match(read("programs/veto/src/lib.rs"), /kind: KIND_OPENED/);
});

const RULE_1 = "CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g";

/** Rule 1, which README.md still quotes, in chain order. The video and the deck quote mandate 3hgrSbPX2VTrfnVekoL2qi2qDWNGBhWP3QgADAWz6X6N. */
const EXPECTED: ReadonlyArray<{ at: string; log: RegExp }> = [
  { at: "2026-09-20T20:57:50Z", log: /^VETO OPENED cap=100000000 per_tx_max=500000 / },
  { at: "2026-09-20T20:58:03Z", log: /^VETO PAID amount=446000 / },
  { at: "2026-09-20T20:58:03Z", log: /^VETO PAID amount=214500 / },
  { at: "2026-09-20T20:58:12Z", log: /^VETO REFUSED reason=5 \(over per-payment maximum\) amount=6232500 per_tx_max=500000 remaining=99339500 override_to_clear=6232500$/ },
  { at: "2026-09-20T21:00:50Z", log: /^VETO PAID amount=5500 spent=666000 / },
  { at: "2026-09-20T22:00:00Z", log: /^VETO REFUSED reason=5 .* amount=8163000 / },
  { at: "2026-09-21T04:00:08Z", log: /^VETO REFUSED reason=5 .* amount=21542500 / },
  { at: "2026-09-21T10:00:00Z", log: /^VETO REFUSED reason=5 .* amount=7903500 / },
  { at: "2026-09-21T16:00:09Z", log: /^VETO REFUSED reason=5 .* amount=63938500 / },
  { at: "2026-09-21T22:00:11Z", log: /^VETO REFUSED reason=5 .* amount=64852000 / },
];

async function rpcCall<T>(rpc: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: unknown };
  assert.equal(json.error, undefined, `${method}: ${JSON.stringify(json.error)}`);
  assert.notEqual(json.result, undefined, `${method} returned a result`);
  return json.result as T;
}

test(
  "R8 live: every reason code and amount the docs quote on rule 1 is the chain's row at that time, and there is no later signature",
  { skip: process.env.VETO_RPC ? false : "set VETO_RPC to read the devnet ledger" },
  async () => {
    const rpc = process.env.VETO_RPC ?? "";
    type Sig = { signature: string; blockTime: number | null };
    const sigs = await rpcCall<Sig[]>(rpc, "getSignaturesForAddress", [RULE_1, { limit: 50, commitment: "finalized" }]);
    assert.equal(sigs.length, EXPECTED.length, "ten signatures on the quoted rule, none later");
    const rows = sigs.slice().reverse();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const want = EXPECTED[i]!;
      assert.equal(new Date((row.blockTime ?? 0) * 1000).toISOString().replace(".000Z", "Z"), want.at, `row ${i} time`);
      type Tx = { meta?: { logMessages?: string[] | null } | null };
      const tx = await rpcCall<Tx | null>(rpc, "getTransaction", [
        row.signature,
        { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" },
      ]);
      const line = (tx?.meta?.logMessages ?? []).map((l) => l.replace(/^Program log: /, "")).find((l) => l.startsWith("VETO "));
      assert.ok(line, `row ${i} has a VETO log line`);
      assert.match(line, want.log, `row ${i} ${row.signature}`);
      await new Promise((r) => setTimeout(r, 1200));
    }
    // README.md still links rule 1's 18:00 refusal. DECK.md quotes the current rule's 12:00 refusal.
    assert.equal(rows[3]!.signature, "3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib");
    assert.match(read("README.md"), /remaining=99339500 override_to_clear=6232500/);
    assert.match(
      read("docs/DECK.md"),
      /VETO REFUSED reason=5 \(over per-payment maximum\) amount=16659625\s+per_tx_max=10000000 remaining=292000000 override_to_clear=16659625/,
    );
  },
);
