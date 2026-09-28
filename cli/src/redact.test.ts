import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { run } from "./commands.js";
import { errorText, redactRpc } from "./errors.js";
import { agentFile, writeConfig } from "./files.js";
import { createMcpServer } from "./mcp.js";
import { chainOf, harness, openedWorld, removeHome, saveSetup, tempHome, type Harness } from "./testkit.js";

const RPC = "https://rpc.example.com/v1/?api-key=SECRET123";
const FETCH_FAILURE = `request to ${RPC} failed, reason: getaddrinfo ENOTFOUND rpc.example.com`;

function assertClean(text: string): void {
  assert.equal(text.includes("SECRET123"), false, text);
  assert.equal(text.includes("api-key=SECRET"), false, text);
  assert.equal(text.includes("https://rpc.example.com"), false, text);
}

async function saveKeyedRpc(home: string, w: ReturnType<typeof openedWorld>): Promise<void> {
  await saveSetup(home, w);
  await writeConfig(home, { rule: w.mandate.toBase58(), rpc: RPC, cluster: "devnet", key: agentFile(home) });
}

async function callPay(runtime: Harness): Promise<{ text: string; isError?: boolean }> {
  const server = await createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "veto-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({ name: "veto_pay", arguments: { amount: "1000" } })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((item) => item.text ?? "").join("\n"), isError: result.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

test("redactRpc removes URLs and api keys, plain and JSON-escaped", () => {
  assertClean(redactRpc(FETCH_FAILURE));
  assertClean(redactRpc(`genesis hash could not be read: ${JSON.stringify(FETCH_FAILURE)}`));
  assertClean(redactRpc("wss://rpc.example.com/ws?api-key=SECRET123 closed"));
  assertClean(redactRpc("bad param api-key=SECRET123&x=1"));
  assert.equal(redactRpc("No active rule."), "No active rule.");
  assert.equal(errorText(new Error("rpc unavailable")), "rpc unavailable");
});

test("connect does not print the RPC URL when the genesis read fails", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    w.fake.getGenesisHash = async () => {
      throw new Error(FETCH_FAILURE);
    };
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["connect", "--rpc", RPC, "--rule", w.mandate.toBase58()], runtime);
    assert.equal(code, 1);
    const text = [...runtime.errs, ...runtime.lines].join("\n");
    assert.match(text, /Could not read the RPC genesis hash/);
    assertClean(text);
  } finally {
    removeHome(home);
  }
});

test("pay does not print the RPC URL when the send fails", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    await saveKeyedRpc(home, w);
    w.fake.sendRawTransaction = async () => {
      throw new Error(FETCH_FAILURE);
    };
    const runtime = harness(home, chainOf(w.fake));
    const code = await run(["pay", "1000"], runtime);
    assert.equal(code, 1);
    assert.match(runtime.errs.join("\n"), /request to \[url hidden\] failed/);
    assertClean([...runtime.errs, ...runtime.lines].join("\n"));
  } finally {
    removeHome(home);
  }
});

test("veto_pay returns a tool error without the RPC URL when the SDK wraps a transport failure", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    await saveKeyedRpc(home, w);
    w.fake.getGenesisHash = async () => {
      throw new Error(FETCH_FAILURE);
    };
    const runtime = harness(home, chainOf(w.fake));
    const result = await callPay(runtime);
    assert.equal(result.isError, true);
    assert.ok(result.text.length > 0);
    assertClean(result.text);
    assert.equal(w.fake.sent.length, 0);
  } finally {
    removeHome(home);
  }
});

test("veto_pay returns a tool error without the RPC URL when the send fails", async () => {
  const home = tempHome();
  try {
    const w = openedWorld();
    await saveKeyedRpc(home, w);
    w.fake.sendRawTransaction = async () => {
      throw new Error(FETCH_FAILURE);
    };
    const runtime = harness(home, chainOf(w.fake));
    const result = await callPay(runtime);
    assert.equal(result.isError, true);
    assert.match(result.text, /\[url hidden\]/);
    assertClean(result.text);
  } finally {
    removeHome(home);
  }
});
