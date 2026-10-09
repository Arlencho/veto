import assert from "node:assert/strict";
import { test } from "node:test";
import { type Connection } from "@solana/web3.js";
import { confirmSignature } from "./confirm.js";
import { RateLimitedError } from "./rpc.js";

function mockConnection(args: {
  wsDelayMs: number;
  status: "pending" | "confirmed" | "refuse";
  refuseDelayMs?: number;
}): Connection {
  return {
    onSignature(_sig: string, cb: (result: { err: null }, ctx: { slot: number }) => void) {
      setTimeout(() => cb({ err: null }, { slot: 1 }), args.wsDelayMs);
      return 1;
    },
    async getSignatureStatus() {
      if (args.status === "refuse") {
        if (args.refuseDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, args.refuseDelayMs));
        }
        throw new RateLimitedError("rpc rate limited on http://127.0.0.1:1");
      }
      if (args.status === "confirmed") {
        return {
          context: { slot: 1 },
          value: { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" },
        };
      }
      return { context: { slot: 1 }, value: null };
    },
    async removeSignatureListener() {},
  } as unknown as Connection;
}

test("a pending status poll then a late websocket confirm is a confirmation, not a rate limit", async () => {
  const lines: string[] = [];
  await confirmSignature(mockConnection({ wsDelayMs: 600, status: "pending" }), "slow-sig", {
    graceMs: 100,
    log: (line) => lines.push(line),
  });
  assert.equal(
    lines.some((line) => /rate limit/i.test(line) || /poll failed/i.test(line)),
    false,
    `invented a throttle: ${lines.join(" | ")}`,
  );
});

test("a leftover rate-limit after websocket confirm is logged and does not fail the confirm", async () => {
  const lines: string[] = [];
  await confirmSignature(mockConnection({ wsDelayMs: 20, status: "refuse" }), "sig-1", {
    graceMs: 500,
    log: (line) => lines.push(line),
  });
  assert.ok(
    lines.some((line) => /leftover status poll after sig-1 was already confirmed/.test(line)),
    `logged: ${lines.join(" | ")}`,
  );
});

test("pr 395 review: the leftover poll line redacts http and ws RPC URLs, path, query and userinfo", async () => {
  const messages = [
    "poll failed on https://user:hunter2@rpc.example.com/v2/SECRET-PATH?api-key=SECRET-QUERY",
    "poll failed on wss://user:hunter2@rpc.example.com/v2/SECRET-PATH?api-key=SECRET-QUERY.",
  ];
  for (const message of messages) {
    const lines: string[] = [];
    const connection = {
      onSignature(_sig: string, cb: (result: { err: null }, ctx: { slot: number }) => void) {
        setTimeout(() => cb({ err: null }, { slot: 1 }), 20);
        return 1;
      },
      async getSignatureStatus() {
        throw new Error(message);
      },
      async removeSignatureListener() {},
    } as unknown as Connection;
    await confirmSignature(connection, "sig-redact", { graceMs: 500, log: (line) => lines.push(line) });
    const leftover = lines.filter((l) => l.includes("leftover status poll after sig-redact"));
    assert.equal(leftover.length, 1, lines.join(" | "));
    for (const secret of ["SECRET-PATH", "SECRET-QUERY", "hunter2", "user:"]) {
      assert.equal(leftover[0]!.includes(secret), false, leftover[0]);
    }
    assert.ok(leftover[0]!.includes("://rpc.example.com"), leftover[0]);
  }
});

test("a status poll that refuses to answer fails with that refusal when the websocket never confirms", async () => {
  const err = new RateLimitedError("rpc rate limited on http://127.0.0.1:1");
  const connection = {
    onSignature() {
      return 1;
    },
    async getSignatureStatus() {
      throw err;
    },
    async removeSignatureListener() {},
  } as unknown as Connection;
  await assert.rejects(
    () => confirmSignature(connection, "sig", { graceMs: 20, log: () => {} }),
    (caught: unknown) => caught === err,
  );
});

