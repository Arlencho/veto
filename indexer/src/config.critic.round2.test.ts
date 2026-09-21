import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { INDEXER_DIR, requiredIdentity } from "./config.js";

// Critic round 2. The README tells an operator to copy .env.example to
// indexer/.env, a searched file. Copied as-is into an otherwise empty
// environment, it must supply no identity: the loader throws and names the
// variable, rather than the example quietly resolving one.
const EXAMPLE = join(INDEXER_DIR, ".env.example");

for (const key of ["VETO_RPC", "VETO_PROGRAM_ID"]) {
  test(`.env.example copied into place does not resolve ${key}`, () => {
    assert.throws(
      () => requiredIdentity(key, {}, { envFiles: [EXAMPLE] }),
      new RegExp(`missing ${key}`),
    );
  });
}
