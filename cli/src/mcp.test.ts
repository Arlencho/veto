import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseRuleRequest } from "@veto-hq/agent-sdk";
import { COMMANDS, run } from "./commands.js";
import { DEFAULT_RPC } from "./cluster.js";
import { TRADE_RULE_DISABLED, tradeRuleEnabled } from "./features.js";
import { agentFile, writeConfig, writeKeyFile } from "./files.js";
import { createMcpServer } from "./mcp.js";
import { DEVNET_USDC_MINT } from "./money.js";
import {
  chainOf,
  harness,
  openedWorld,
  plantCharge,
  plantDecision,
  plantDecoy,
  plantNewerRule,
  removeHome,
  retargetMint,
  saveSetup,
  tempHome,
  type Harness,
} from "./testkit.js";
import { Keypair, Transaction } from "./web3.js";

const EXPIRES = 1793750400n;
const SCAN = "Scan this on your phone and hold to approve.";

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

async function withClient(runtime: Harness, body: (client: Client) => Promise<void>): Promise<void> {
  const server = await createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "veto-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function asResult(value: unknown): ToolResult {
  const result = value as ToolResult;
  assert.ok(Array.isArray(result.content));
  return result;
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

test("the tool list is pay, status, decisions, and request rule", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        ["veto_pay", "veto_status", "veto_decisions", "veto_request_rule"],
      );
      for (const tool of listed.tools) {
        const properties = tool.inputSchema.properties ?? {};
        assert.equal(Object.hasOwn(properties, "key"), false);
      }
    });
  } finally {
    removeHome(home);
  }
});

test("veto_pay is annotated as spending and not idempotent, and says it spends money", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const listed = await client.listTools();
      const pay = listed.tools.find((tool) => tool.name === "veto_pay");
      assert.ok(pay);
      assert.equal(pay.annotations?.readOnlyHint, false);
      assert.equal(pay.annotations?.destructiveHint, true);
      assert.equal(pay.annotations?.idempotentHint, false);
      assert.match(pay.description ?? "", /^Spends money\./);
      assert.match(pay.description ?? "", /within the rule's per-payment maximum and total/);
      for (const name of ["veto_status", "veto_decisions"]) {
        const tool = listed.tools.find((row) => row.name === name);
        assert.equal(tool?.annotations?.readOnlyHint, true);
      }
      const request = listed.tools.find((tool) => tool.name === "veto_request_rule");
      assert.equal(request?.annotations?.destructiveHint, false);
    });
  } finally {
    removeHome(home);
  }
});

test("veto_pay text states the amount in the token and base units, the payee, and the signature", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    retargetMint(w, DEVNET_USDC_MINT);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 5n, 1n, "paid");
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(await client.callTool({ name: "veto_pay", arguments: { amount: "5" } }));
      assert.equal(result.isError, undefined);
      const text = textOf(result);
      assert.ok(text.includes("amount 0.000005 USDC (5 base units)"));
      assert.ok(text.includes(`payee ${w.merchant.publicKey.toBase58()}`));
      assert.ok(text.includes("signature sig-charge"));
      assert.equal(result.structuredContent?.amount, "0.000005 USDC");
      assert.equal(result.structuredContent?.amountBaseUnits, "5");
    });
  } finally {
    removeHome(home);
  }
});

test("veto_trade is disabled and is not a tool", async () => {
  const home = tempHome();
  try {
    assert.equal(tradeRuleEnabled, false);
    const trade = COMMANDS.find((command) => command.tool === "veto_trade");
    assert.ok(trade);
    assert.equal(trade.enabled, false);
    assert.equal(trade.disabledMessage, TRADE_RULE_DISABLED);
    assert.equal(TRADE_RULE_DISABLED, "Trading from the companion is switched off in this version. Agents trade through the SDK's trade().");
    const w = openedWorld();
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const listed = await client.listTools();
      assert.equal(
        listed.tools.some((tool) => tool.name === "veto_trade"),
        false,
      );
      const called = asResult(await client.callTool({ name: "veto_trade", arguments: {} }));
      assert.equal(called.isError, true);
    });
  } finally {
    removeHome(home);
  }
});

test("veto_pay returns a paid decision", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    retargetMint(w, DEVNET_USDC_MINT);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 1000n, 1n, "paid");
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(await client.callTool({ name: "veto_pay", arguments: { amount: "1000" } }));
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        kind: "paid",
        amount: "0.001 USDC",
        amountBaseUnits: "1000",
        token: "USDC",
        mint: DEVNET_USDC_MINT,
        payee: w.merchant.publicKey.toBase58(),
        reasonCode: 0,
        reasonText: "ok",
        override: "0 USDC",
        signature: "sig-charge",
        explorer: "https://explorer.solana.com/tx/sig-charge?cluster=devnet",
      });
      assert.equal(w.fake.sent.length, 1);
    });
  } finally {
    removeHome(home);
  }
});

test("veto_pay returns a refusal as a normal result", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    retargetMint(w, DEVNET_USDC_MINT);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 1000n, 1n, "refused", 500_000n);
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(await client.callTool({ name: "veto_pay", arguments: { amount: "1000" } }));
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        kind: "refused",
        amount: "0.001 USDC",
        amountBaseUnits: "1000",
        token: "USDC",
        mint: DEVNET_USDC_MINT,
        payee: w.merchant.publicKey.toBase58(),
        reasonCode: 5,
        reasonText: "over per-payment maximum",
        override: "0.50 USDC",
        signature: "sig-charge",
        explorer: "https://explorer.solana.com/tx/sig-charge?cluster=devnet",
      });
    });
  } finally {
    removeHome(home);
  }
});

test("veto_pay charges the rule you name", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    plantNewerRule(w);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 1000n, 1n, "paid");
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(
        await client.callTool({
          name: "veto_pay",
          arguments: { amount: "1000", rule: w.mandate.toBase58() },
        }),
      );
      assert.equal(result.isError, undefined);
      const raw = w.fake.sent[0];
      assert.ok(raw);
      const ix = Transaction.from(raw).instructions[0];
      assert.equal(ix?.keys[1]?.pubkey.toBase58(), w.mandate.toBase58());
    });
  } finally {
    removeHome(home);
  }
});

test("veto_pay without a rule charges the saved rule, not a u64::MAX decoy from another owner", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const decoy = plantDecoy(w);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 1000n, 1n, "paid");
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(await client.callTool({ name: "veto_pay", arguments: { amount: "1000" } }));
      assert.equal(result.isError, undefined);
      const raw = w.fake.sent[0];
      assert.ok(raw);
      const ix = Transaction.from(raw).instructions[0];
      assert.equal(ix?.keys[1]?.pubkey.toBase58(), w.mandate.toBase58());
      assert.notEqual(ix?.keys[1]?.pubkey.toBase58(), decoy);
    });
  } finally {
    removeHome(home);
  }
});

test("veto_pay rejects a key argument and does not send", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    const secretPath = `${home}/other.json`;
    await writeKeyFile(secretPath, w.agent.secretKey);
    await withClient(runtime, async (client) => {
      const result = asResult(
        await client.callTool({
          name: "veto_pay",
          arguments: { amount: "1000", key: secretPath },
        }),
      );
      assert.equal(result.isError, true);
      assert.equal(textOf(result).includes(secretPath), false);
      assert.equal(w.fake.sent.length, 0);
    });
  } finally {
    removeHome(home);
  }
});

test("veto_status names what the rule can still pay", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({
      cap: 20_000_000n,
      spent: 500_000n,
      perTxMax: 500_000n,
      expiresAt: EXPIRES,
      balance: 50_000,
    });
    retargetMint(w, DEVNET_USDC_MINT);
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(await client.callTool({ name: "veto_status", arguments: {} }));
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        remaining: "19.50 USDC",
        cap: "20 USDC",
        largest: "0.50 USDC",
        expiry: "2026-11-04",
        feeSol: "0.00005 SOL",
        feeWarning:
          "agent SOL balance is 50000 lamports, under 100000 lamports (20 base fees of 5000). The agent pays the transaction fee.",
      });
    });
  } finally {
    removeHome(home);
  }
});

test("veto_status reports no active rule", async () => {
  const home = tempHome();
  try {
    const w = openedWorld({ status: 1 });
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(await client.callTool({ name: "veto_status", arguments: {} }));
      assert.equal(result.isError, true);
      assert.equal(textOf(result), "No active rule.");
    });
  } finally {
    removeHome(home);
  }
});

test("veto_decisions lists newest first", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    retargetMint(w, DEVNET_USDC_MINT);
    plantDecision(w, "older", 10, 100, 500_000n, 1n);
    plantDecision(w, "newer", 20, 200, 1_000_000n, 2n);
    w.fake.signatures = [
      { signature: "newer", slot: 20, err: null, memo: null, blockTime: 200, confirmationStatus: "confirmed" },
      { signature: "older", slot: 10, err: null, memo: null, blockTime: 100, confirmationStatus: "confirmed" },
    ];
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(await client.callTool({ name: "veto_decisions", arguments: { limit: 20 } }));
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        decisions: [
          { kind: "paid", amount: "1 USDC", reasonText: "ok", signature: "newer" },
          { kind: "paid", amount: "0.50 USDC", reasonText: "ok", signature: "older" },
        ],
      });
    });
  } finally {
    removeHome(home);
  }
});

test("veto_decisions returns a refusal as a row", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    retargetMint(w, DEVNET_USDC_MINT);
    plantDecision(w, "older", 10, 100, 1_000_000n, 1n, "paid");
    plantDecision(w, "newer", 20, 200, 500_000n, 2n, "refused");
    w.fake.signatures = [
      { signature: "newer", slot: 20, err: null, memo: null, blockTime: 200, confirmationStatus: "confirmed" },
      { signature: "older", slot: 10, err: null, memo: null, blockTime: 100, confirmationStatus: "confirmed" },
    ];
    await saveSetup(home, w);
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(await client.callTool({ name: "veto_decisions", arguments: {} }));
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        decisions: [
          { kind: "refused", amount: "0.50 USDC", reasonText: "over per-payment maximum", signature: "newer" },
          { kind: "paid", amount: "1 USDC", reasonText: "ok", signature: "older" },
        ],
      });
    });
  } finally {
    removeHome(home);
  }
});

test("veto_request_rule returns the link, a PNG, and the hold instruction", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    await writeKeyFile(agentFile(home), w.agent.secretKey);
    const payee = Keypair.generate().publicKey.toBase58();
    const runtime = harness(home, chainOf(w.fake));
    runtime.qr = () => {
      throw new Error("the tool must not use the terminal QR");
    };
    await withClient(runtime, async (client) => {
      const result = asResult(
        await client.callTool({
          name: "veto_request_rule",
          arguments: { payee, max: "500000", cap: "20000000", days: "30", purpose: "API fees" },
        }),
      );
      assert.equal(result.isError, undefined);
      const texts = result.content.filter((item) => item.type === "text");
      assert.equal(texts.length, 2);
      const url = texts[0]?.type === "text" ? texts[0].text : "";
      assert.equal(url.startsWith("veto://rule-request?"), true);
      const parsed = parseRuleRequest(url);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.equal(parsed.request.agent, w.agent.publicKey.toBase58());
      assert.equal(parsed.request.payee, payee);
      assert.equal(parsed.request.mint, DEVNET_USDC_MINT);
      assert.equal(parsed.request.max, 500_000n);
      assert.equal(parsed.request.cap, 20_000_000n);
      assert.equal(parsed.request.days, 30);
      assert.equal(parsed.request.purpose, "API fees");
      assert.equal(texts[1]?.type === "text" ? texts[1].text : "", SCAN);
      const image = result.content.find((item) => item.type === "image");
      assert.ok(image && image.type === "image");
      assert.equal(image.mimeType, "image/png");
      const bytes = Buffer.from(image.data, "base64");
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      assert.equal(width, height);
      assert.ok(width > 20);
      const idat = pngIdat(bytes);
      const raw = inflateSync(idat);
      const stride = width + 1;
      let dark = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (raw[y * stride + 1 + x] === 0) dark += 1;
        }
      }
      assert.ok(dark > 0);
      assert.equal(w.fake.sent.length, 0);
    });
  } finally {
    removeHome(home);
  }
});

test("veto_request_rule requires a mint when the saved cluster is mainnet", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const key = agentFile(home);
    await writeKeyFile(key, w.agent.secretKey);
    await writeConfig(home, {
      rule: w.mandate.toBase58(),
      rpc: DEFAULT_RPC["mainnet-beta"],
      cluster: "mainnet-beta",
      key,
    });
    const payee = Keypair.generate().publicKey.toBase58();
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(
        await client.callTool({
          name: "veto_request_rule",
          arguments: { payee, max: "500000", cap: "20000000", days: "30", purpose: "API fees" },
        }),
      );
      assert.equal(result.isError, true);
      assert.equal(textOf(result), "Mint address is required.");
      assert.equal(
        result.content.some((item) => item.type === "image"),
        false,
      );
    });
  } finally {
    removeHome(home);
  }
});

test("veto_request_rule returns a bad request as a tool error", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    await writeKeyFile(agentFile(home), w.agent.secretKey);
    const payee = Keypair.generate().publicKey.toBase58();
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(
        await client.callTool({
          name: "veto_request_rule",
          arguments: { payee, max: "5", cap: "1", days: "30", purpose: "API fees" },
        }),
      );
      assert.equal(result.isError, true);
      assert.equal(textOf(result), "max is greater than cap");
      assert.equal(
        result.content.some((item) => item.type === "image"),
        false,
      );
    });
  } finally {
    removeHome(home);
  }
});

test("the server refuses to start when the agent key mode is wider than 0600", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const file = agentFile(home);
    await writeKeyFile(file, w.agent.secretKey);
    await chmod(file, 0o644);
    const runtime = harness(home, chainOf(w.fake));
    await assert.rejects(() => createMcpServer(runtime), /The agent key file mode is 0644, which is wider than 0600/);
    const secret = JSON.stringify(Array.from(w.agent.secretKey));
    await assert.rejects(
      async () => {
        try {
          await createMcpServer(runtime);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          assert.equal(message.includes(secret), false);
          throw err;
        }
      },
      /wider than 0600/,
    );
  } finally {
    removeHome(home);
  }
});

test("the server starts when the agent key is missing or mode 0600, without reading it", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 4);
    });
    const file = agentFile(home);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "not a key\n", { mode: 0o600 });
    await chmod(file, 0o600);
    await withClient(runtime, async (client) => {
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 4);
    });
    await chmod(file, 0o400);
    await withClient(runtime, async (client) => {
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 4);
    });
  } finally {
    removeHome(home);
  }
});

test("veto mcp rejects a key flag", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["mcp", "--key", `${home}/secret.json`], runtime);
    assert.equal(code, 1);
    assert.equal(runtime.errs.join("\n"), "Flag --key is not used by this command.");
  } finally {
    removeHome(home);
  }
});

test("a tool result does not contain the key file", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    retargetMint(w, DEVNET_USDC_MINT);
    await saveSetup(home, w);
    plantCharge(w, w.mandate, 1000n, 1n, "refused", 500_000n);
    const secret = JSON.stringify(Array.from(w.agent.secretKey));
    const runtime = harness(home, chainOf(w.fake));
    await withClient(runtime, async (client) => {
      const result = asResult(await client.callTool({ name: "veto_pay", arguments: { amount: "1000" } }));
      const spoken = JSON.stringify(result);
      assert.equal(spoken.includes(secret), false);
      assert.equal(spoken.includes(secret.slice(1, 40)), false);
      assert.equal(result.structuredContent?.kind, "refused");
    });
    assert.equal(runtime.lines.join("\n").includes(secret), false);
    assert.equal(runtime.errs.join("\n").includes(secret), false);
  } finally {
    removeHome(home);
  }
});

function pngIdat(bytes: Buffer): Buffer {
  let offset = 8;
  const parts: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") parts.push(data);
    if (type === "IEND") break;
    offset += 12 + length;
  }
  assert.ok(parts.length > 0);
  return Buffer.concat(parts);
}
