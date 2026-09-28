import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROGRAM_ID } from "@veto-hq/agent-sdk";
import { decodeMandate, ledgerPda } from "../../sdk/src/layout.js";
import {
  TOKEN_PROGRAM,
  asConnection,
  framed,
  legacyChargeTx,
  mandateBytes,
  paidLog,
  refusedLog,
  world,
  type FakeConnection,
  type MandateFields,
  type World,
} from "../../sdk/src/testkit.js";
import { DEFAULT_RPC, type Cluster } from "./cluster.js";
import { agentFile, writeConfig, writeKeyFile } from "./files.js";
import type { Runtime } from "./runtime.js";
import { Keypair, PublicKey, type Connection, type PublicKey as Address } from "./web3.js";

const MINT_OFFSET = 72;
const AGENT_OFFSET = 40;
const MANDATE_ID_OFFSET = 168;

export type Harness = Runtime & {
  lines: string[];
  errs: string[];
  prompts: string[];
};

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "veto-cli-"));
}

export function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

export function output(runtime: Harness): string {
  return runtime.lines.join("\n");
}

export function harness(home: string, connection: Connection, answers: string[] = []): Harness {
  const lines: string[] = [];
  const errs: string[] = [];
  const prompts: string[] = [];
  const pending = [...answers];
  return {
    home,
    lines,
    errs,
    prompts,
    now: () => new Date("2026-09-25T00:00:00.000Z"),
    sleep: async () => {},
    connect: () => connection,
    qr: (text) => `QR ${text}`,
    stdout(text) {
      lines.push(text);
    },
    stderr(text) {
      errs.push(text);
    },
    async ask(prompt) {
      prompts.push(prompt);
      const next = pending.shift();
      if (next === undefined) throw new Error(`no answer for ${prompt}`);
      return next;
    },
    maxPolls: 5,
  };
}

export function chainOf(fake: FakeConnection): Connection {
  return asConnection(fake) as unknown as Connection;
}

export function trackAirdrops(fake: FakeConnection): void {
  const tracked = fake as FakeConnection & {
    airdrops: { to: string; lamports: number }[];
    requestAirdrop(key: { toBase58(): string }, lamports: number): Promise<string>;
  };
  tracked.airdrops = [];
  tracked.requestAirdrop = async (key, lamports) => {
    const id = key.toBase58();
    const current = fake.balances.get(id) ?? 0;
    fake.balances.set(id, current + lamports);
    tracked.airdrops.push({ to: id, lamports });
    return "airdrop-sig";
  };
}

export function airdropsOf(fake: FakeConnection): { to: string; lamports: number }[] {
  return (fake as { airdrops?: { to: string; lamports: number }[] }).airdrops ?? [];
}

/** Point the mandate, source, and payee token account at a known mint address. */
export function retargetMint(w: World, mintAddress: string): void {
  const bytes = new PublicKey(mintAddress).toBuffer();
  const canonical = new PublicKey(mintAddress).toBase58();
  const old = w.mint.publicKey.toBase58();
  const mandate = w.fake.accounts.get(w.mandate.toBase58());
  const source = w.fake.accounts.get(w.source.publicKey.toBase58());
  const mintAccount = w.fake.accounts.get(old);
  if (!mandate || !source || !mintAccount) throw new Error("chain is missing the mint accounts");
  mandate.data.set(bytes, MINT_OFFSET);
  source.data.set(bytes, 0);
  w.fake.accounts.delete(old);
  w.fake.accounts.set(canonical, mintAccount);
  for (const row of w.fake.tokenAccounts) {
    if (row.mint === old) {
      row.mint = canonical;
      row.data.set(bytes, 0);
    }
  }
}

/** A second mandate for a different agent, newest id, so a missing filter would pick it. */
export function plantForeignAgent(w: World): string {
  const current = w.fake.accounts.get(w.mandate.toBase58());
  if (!current) throw new Error("mandate missing");
  const data = Buffer.from(current.data);
  data.set(Keypair.generate().publicKey.toBuffer(), AGENT_OFFSET);
  data.writeBigUInt64LE(99n, MANDATE_ID_OFFSET);
  const address = Keypair.generate().publicKey.toBase58();
  w.fake.accounts.set(address, { data, owner: PROGRAM_ID, lamports: 1 });
  return address;
}

/** Same agent, higher mandate id, so it is the most recent rule. */
export function plantNewerRule(w: World): string {
  const current = w.fake.accounts.get(w.mandate.toBase58());
  if (!current) throw new Error("mandate missing");
  const data = Buffer.from(current.data);
  data.writeBigUInt64LE(9n, MANDATE_ID_OFFSET);
  const address = Keypair.generate().publicKey.toBase58();
  w.fake.accounts.set(address, { data, owner: PROGRAM_ID, lamports: 1 });
  return address;
}

export const U64_MAX = 18446744073709551615n;

/**
 * A rule for this agent opened by someone else: foreign owner, foreign payee, and mandate id
 * u64::MAX so it sorts first for the agent. Other fields copy the world's rule unless patched.
 */
export function plantDecoy(w: World, patch: Partial<MandateFields> = {}): string {
  const current = w.fake.accounts.get(w.mandate.toBase58());
  if (!current) throw new Error("mandate missing");
  const fields: MandateFields = {
    ...decodeMandate(Buffer.from(current.data)),
    owner: Keypair.generate().publicKey,
    merchant: Keypair.generate().publicKey,
    source: Keypair.generate().publicKey,
    mandateId: U64_MAX,
    ...patch,
  };
  const address = Keypair.generate().publicKey.toBase58();
  w.fake.accounts.set(address, { data: mandateBytes(fields), owner: PROGRAM_ID, lamports: 1 });
  return address;
}

export function plantCharge(
  w: World,
  mandate: Address,
  amount: bigint,
  nonce: bigint,
  kind: "paid" | "refused",
  suggested = 0n,
): void {
  const signature = "sig-charge";
  w.fake.signature = signature;
  const logs =
    kind === "paid"
      ? framed(PROGRAM_ID.toBase58(), [paidLog(mandate, amount, nonce, amount)])
      : framed(PROGRAM_ID.toBase58(), [refusedLog(mandate, amount, nonce, 5, suggested)]);
  w.fake.transactions.set(
    signature,
    legacyChargeTx({
      signature,
      slot: 7,
      blockTime: 1_700_000_000,
      logs,
      amount,
      nonce,
      keys: chargeKeys(w, mandate),
    }),
  );
}

export function plantDecision(
  w: World,
  signature: string,
  slot: number,
  blockTime: number,
  amount: bigint,
  nonce: bigint,
  kind: "paid" | "refused" = "paid",
): void {
  const logs =
    kind === "paid"
      ? framed(PROGRAM_ID.toBase58(), [paidLog(w.mandate, amount, nonce, amount)])
      : framed(PROGRAM_ID.toBase58(), [refusedLog(w.mandate, amount, nonce, 5, 500_000n)]);
  w.fake.transactions.set(
    signature,
    legacyChargeTx({
      signature,
      slot,
      blockTime,
      logs,
      amount,
      nonce,
      keys: chargeKeys(w, w.mandate),
    }),
  );
}

export async function saveSetup(home: string, w: World, cluster: Cluster = "devnet"): Promise<void> {
  const keyPath = agentFile(home);
  await writeKeyFile(keyPath, w.agent.secretKey);
  await writeConfig(home, {
    rule: w.mandate.toBase58(),
    rpc: DEFAULT_RPC[cluster],
    cluster,
    key: keyPath,
  });
}

export function openedWorld(patch?: Parameters<typeof world>[0]): World {
  const w = world(patch);
  trackAirdrops(w.fake);
  return w;
}

function chargeKeys(w: World, mandate: Address): Address[] {
  return [
    w.agent.publicKey,
    mandate,
    ledgerPda(PROGRAM_ID, mandate),
    w.source.publicKey,
    w.destination.publicKey,
    w.mint.publicKey,
    TOKEN_PROGRAM,
    PROGRAM_ID,
  ];
}
