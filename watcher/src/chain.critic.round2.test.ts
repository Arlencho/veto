import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import anchorPkg from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, connect, ledgerPda, mandatePda } from "./chain.js";
import { WATCHER_DIR, loadConfig } from "./config.js";

const { BN } = anchorPkg;

// Critic round 2. A configured VETO_PROGRAM_ID that is not the bundled IDL
// address must be the program a built charge is addressed to, and the PDAs
// the charge carries must derive from that same id.
const CONFIGURED = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const OWNER = Keypair.generate();

function identities(): NodeJS.ProcessEnv {
  return {
    VETO_RPC: "http://rpc.test",
    VETO_PROGRAM_ID: CONFIGURED,
    VETO_MINT: Keypair.generate().publicKey.toBase58(),
    VETO_OWNER: OWNER.publicKey.toBase58(),
    VETO_OWNER_TOKEN: Keypair.generate().publicKey.toBase58(),
    VETO_MERCHANT: Keypair.generate().publicKey.toBase58(),
    VETO_MERCHANT_TOKEN: Keypair.generate().publicKey.toBase58(),
    VETO_AGENT: Keypair.generate().publicKey.toBase58(),
    VETO_KEYS_DIR: mkdtempSync(join(tmpdir(), "veto-critic-r2-")),
  };
}

test("a built charge is addressed to the configured program and its PDAs derive from it", async () => {
  const cfg = loadConfig(identities(), { envFiles: [] });
  const agent = Keypair.generate();
  const { program, programId } = connect(cfg, agent);
  const mandate = mandatePda(programId, OWNER.publicKey, cfg.mandateId);
  const ledger = ledgerPda(programId, mandate);
  const ix = await program.methods
    .charge(new BN(1), new BN(1))
    .accountsPartial({
      agent: agent.publicKey,
      mandate,
      ledger,
      source: new PublicKey(cfg.ownerTokenAccount),
      destination: new PublicKey(cfg.merchantTokenAccount),
      mint: new PublicKey(cfg.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  assert.equal(ix.programId.toBase58(), CONFIGURED, "charge is addressed to the bundled IDL program");
  assert.equal(
    mandatePda(program.programId, OWNER.publicKey, cfg.mandateId).toBase58(),
    mandate.toBase58(),
    "PDA derived from the Program's id disagrees with the one derived from configuration",
  );
  const keys = ix.keys.map((k) => k.pubkey.toBase58());
  assert.ok(keys.includes(mandate.toBase58()) && keys.includes(ledger.toBase58()));
});

// The README tells an operator to copy .env.example to watcher/.env, a searched
// file. Copied as-is into an otherwise empty environment it must supply no
// identity: loadConfig throws and names the variable.
const EXAMPLE = join(WATCHER_DIR, ".env.example");

test(".env.example copied into place does not resolve VETO_RPC", () => {
  assert.throws(
    () => loadConfig({ VETO_KEYS_DIR: mkdtempSync(join(tmpdir(), "veto-critic-r2-")) }, { envFiles: [EXAMPLE] }),
    /missing VETO_RPC/,
  );
});

test(".env.example copied into place does not resolve VETO_PROGRAM_ID once VETO_RPC is supplied", () => {
  assert.throws(
    () =>
      loadConfig(
        { VETO_RPC: "http://rpc.test", VETO_KEYS_DIR: mkdtempSync(join(tmpdir(), "veto-critic-r2-")) },
        { envFiles: [EXAMPLE] },
      ),
    /missing VETO_PROGRAM_ID/,
  );
});
