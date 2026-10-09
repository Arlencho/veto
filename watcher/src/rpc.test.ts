import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { loadConfig } from "./config.js";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  RateLimitedError,
  RpcTimeoutError,
  createFailoverConnection,
  isRateLimitError,
  isTransientRpcError,
  makeFailoverFetch,
  parseRpcList,
  parseRpcTimeoutMs,
  redactRejections,
  redactRpcUrl,
  redactRpcUrlsDeep,
  redactRpcUrlsInText,
} from "./rpc.js";

// Every chain identity is required now: the loader stopped inventing an
// endpoint, a program or an account when nothing is configured. These tests
// were written while those defaults still existed, so they name them here.
// Nothing about what they assert has changed.
const IDENTITIES = {
  VETO_PROGRAM_ID: "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  VETO_MINT: "2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU",
  VETO_OWNER: "EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc",
  VETO_OWNER_TOKEN: "FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE",
  VETO_MERCHANT: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  VETO_MERCHANT_TOKEN: "2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F",
  VETO_AGENT: "6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w",
};

test("parseRpcList keeps order, splits on commas and whitespace, and drops duplicates", () => {
  assert.deepEqual(parseRpcList("http://a.invalid"), ["http://a.invalid"]);
  assert.deepEqual(parseRpcList("http://a.invalid, http://b.invalid"), [
    "http://a.invalid",
    "http://b.invalid",
  ]);
  assert.deepEqual(parseRpcList("http://a.invalid\nhttp://b.invalid"), [
    "http://a.invalid",
    "http://b.invalid",
  ]);
  assert.deepEqual(parseRpcList("http://a.invalid, http://a.invalid, http://b.invalid"), [
    "http://a.invalid",
    "http://b.invalid",
  ]);
  assert.deepEqual(parseRpcList("  ,  "), []);
});

test("loadConfig honours a comma-separated VETO_RPC list, first URL first", () => {
  const cfg = loadConfig({
    ...IDENTITIES,
    VETO_RPC: "http://dedicated.invalid, http://127.0.0.1:8999",
    VETO_KEYS_DIR: "/tmp/veto-rpc-test-keys-missing",
  });
  assert.deepEqual(cfg.rpcs, ["http://dedicated.invalid", "http://127.0.0.1:8999"]);
  assert.equal(cfg.rpc, "http://dedicated.invalid");
});

test("isRateLimitError is true for 429 and rate-limit wording, false for a dead read", () => {
  assert.equal(isRateLimitError(new Error("429 Too Many Requests")), true);
  assert.equal(isRateLimitError(new Error("Server responded with 429")), true);
  assert.equal(isRateLimitError(new RateLimitedError("rpc rate limited on http://a")), true);
  assert.equal(isRateLimitError(new Error("fetch failed")), false);
  assert.equal(isRateLimitError(new Error("Block 4 cleaned up, does not exist on node")), false);
});

test("a 429 is retried on the next endpoint rather than treated as a dead read", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("primary")) {
      return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const lines: string[] = [];
  const failover = makeFailoverFetch(
    ["http://primary.invalid", "http://fallback.invalid"],
    (line) => lines.push(line),
    { fetch: fetchImpl, sleep: async () => {}, initialDelayMs: 0 },
  );
  const res = await failover("http://primary.invalid", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["http://primary.invalid", "http://fallback.invalid"]);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /rate limited/);
  assert.doesNotMatch(lines.join("\n"), /failure/);
});

test("when every endpoint rate limits, the error names the rate limit", async () => {
  const lines: string[] = [];
  const failover = makeFailoverFetch(
    ["http://a.invalid", "http://b.invalid"],
    (line) => lines.push(line),
    {
      fetch: async () => new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" }),
      sleep: async () => {},
      initialDelayMs: 0,
      maxPasses: 1,
    },
  );
  await assert.rejects(
    () => failover("http://a.invalid", { method: "POST" }),
    (err: unknown) => {
      assert.equal(err instanceof RateLimitedError, true);
      assert.match(err instanceof Error ? err.message : "", /rate limited/);
      return true;
    },
  );
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /rate limited/);
    assert.doesNotMatch(line, /failure/);
  }
});

// Critic fixtures, round 1. Each one goes RED on b23b9d3.

test("critic: one configured endpoint still backs off on a transient 429 instead of surfacing it on the first throttle", async () => {
  // Before this branch, web3.js retried a 429 on the same endpoint four more
  // times (500 ms doubling). disableRetryOnRateLimit: true removed that and
  // makeFailoverFetch only moves between entries, so the default one-URL
  // config now gets zero retries on a rate limit.
  let n = 0;
  const slept: number[] = [];
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) {
      return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), { status: 200 });
  };
  const failover = makeFailoverFetch(["http://only.invalid"], () => {}, {
    fetch: fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    initialDelayMs: 1,
  });
  const res = await failover("http://only.invalid", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(n, 2);
  assert.ok(slept.length >= 1, "a bounded backoff must run before the retry");
});

test("critic: a malformed entry in VETO_RPC is refused at load, not discovered at the first 429", () => {
  assert.throws(() =>
    loadConfig({
      VETO_RPC: "http://a.invalid, gargabe",
      VETO_KEYS_DIR: "/tmp/veto-rpc-test-keys-missing",
    }),
  );
});

test("a malformed VETO_RPC entry names its position and does not echo the value", () => {
  const secret = "rpc.example.test/?api-key=SECRET123";
  assert.throws(
    () =>
      loadConfig({
        ...IDENTITIES,
        VETO_RPC: secret,
        VETO_KEYS_DIR: "/tmp/veto-rpc-test-keys-missing",
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message.includes("SECRET123"), false, message);
      assert.equal(message.includes("rpc.example.test"), false, message);
      assert.match(message, /position 1/);
      return true;
    },
  );
  assert.throws(
    () => parseRpcList(`http://ok.example, ws://rpc.example.test/?api-key=SECRET123`),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message.includes("SECRET123"), false, message);
      assert.match(message, /position 2/);
      return true;
    },
  );
});

test("critic: an unconfirmed-transaction timeout is not a rate limit even when the signature contains 429", () => {
  // web3.js TransactionExpiredTimeoutError message shape. Base58 signatures
  // can contain the digits 429. This is the one error where the send may
  // have landed, and classifying it as a rate limit routes it to deferred
  // and a resubmit of the same nonce.
  const msg =
    "Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed. Check signature 3Q429kLmNoPqRsTuVwXyZ using the Solana Explorer or CLI tools.";
  assert.equal(isRateLimitError(new Error(msg)), false);
});

/** A fetch that never answers on its own and rejects only when its signal aborts.
 *
 * The interval stands in for the open socket of a real hung request: it keeps
 * the event loop alive, as the socket does, since AbortSignal.timeout does not. */
function hangingUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) return;
    const socket = setInterval(() => {}, 1_000);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(socket);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function okResponse(): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("final audit M3: a never-responding endpoint fails over within the timeout", async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const failover = makeFailoverFetch(
    ["http://hung.invalid/secret-key", "http://fallback.invalid"],
    (line) => lines.push(line),
    {
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("hung")) return hangingUntilAborted(init);
        return okResponse();
      },
      sleep: async () => {},
      initialDelayMs: 0,
      timeoutMs: 50,
    },
  );
  const started = Date.now();
  const res = await failover("http://hung.invalid/secret-key", { method: "POST" });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["http://hung.invalid/secret-key", "http://fallback.invalid"]);
  assert.ok(elapsed < 2_000, `failed over after ${elapsed} ms`);
  assert.ok(lines.some((l) => l === "rpc request to http://hung.invalid timed out after 50 ms"));
  assert.ok(lines.every((l) => !l.includes("secret-key")));
});

test("final audit M3: when every endpoint hangs the request ends after one timeout each, not one per pass", async () => {
  let calls = 0;
  const failover = makeFailoverFetch(["http://a.invalid", "http://b.invalid"], () => {}, {
    fetch: async (_input, init) => {
      calls += 1;
      return hangingUntilAborted(init);
    },
    sleep: async () => {},
    initialDelayMs: 0,
    maxPasses: 5,
    timeoutMs: 30,
  });
  await assert.rejects(failover("http://a.invalid", { method: "POST" }), (err: unknown) => {
    assert.ok(err instanceof RpcTimeoutError);
    assert.equal(isTransientRpcError(err), true);
    assert.equal(isRateLimitError(err), false);
    return true;
  });
  assert.equal(calls, 2);
});

test("final audit M3: a caller's own abort is not taken as a hung endpoint", async () => {
  let calls = 0;
  const failover = makeFailoverFetch(["http://a.invalid", "http://b.invalid"], () => {}, {
    fetch: async (_input, init) => {
      calls += 1;
      return hangingUntilAborted(init);
    },
    timeoutMs: 5_000,
  });
  const controller = new AbortController();
  const pending = failover("http://a.invalid", { method: "POST", signal: controller.signal });
  controller.abort(new Error("caller stopped"));
  await assert.rejects(pending, /caller stopped/);
  assert.equal(calls, 1);
});

test("final audit M3: VETO_RPC_TIMEOUT_MS defaults to 20 s, reaches the config, and refuses junk", () => {
  assert.equal(DEFAULT_RPC_TIMEOUT_MS, 20_000);
  assert.equal(parseRpcTimeoutMs(undefined), 20_000);
  assert.equal(parseRpcTimeoutMs("5000"), 5_000);
  assert.throws(() => parseRpcTimeoutMs("0"));
  assert.throws(() => parseRpcTimeoutMs("1e3"));
  const base = { ...IDENTITIES, VETO_RPC: "http://dedicated.invalid", VETO_KEYS_DIR: "/tmp/veto-rpc-test-keys-missing" };
  assert.equal(loadConfig(base, { envFiles: [] }).rpcTimeoutMs, 20_000);
  assert.equal(loadConfig({ ...base, VETO_RPC_TIMEOUT_MS: "7000" }, { envFiles: [] }).rpcTimeoutMs, 7_000);
  assert.equal(loadConfig({ ...base, VETO_AGENT_PASS_BUDGET_MS: "90000" }, { envFiles: [] }).agentPassBudgetMs, 90_000);
});

test("final audit L4: ws and wss URLs are redacted to scheme and host like http", () => {
  assert.equal(redactRpcUrl("wss://mainnet.example.com/v2/SECRET123"), "wss://mainnet.example.com");
  assert.equal(redactRpcUrl("ws://127.0.0.1:8900/SECRET123"), "ws://127.0.0.1:8900");
  const text = redactRpcUrlsInText(
    "ws error 503 on wss://rpc.example.com/v2/SECRET123, then ws://10.0.0.1:8900/?api-key=SECRET456.",
  );
  assert.equal(text.includes("SECRET"), false, text);
  assert.equal(text, "ws error 503 on wss://rpc.example.com, then ws://10.0.0.1:8900.");
  assert.equal(redactRpcUrl("ftp://rpc.example.com/SECRET"), "invalid-rpc-url");
});

test("transient RPC errors are told apart from answers a later read would repeat", () => {
  assert.equal(isTransientRpcError(new Error("failed to get info about accounts: TypeError: fetch failed")), true);
  assert.equal(isTransientRpcError(new Error("503 Service Unavailable: upstream down")), true);
  assert.equal(isTransientRpcError(new Error("502 Bad Gateway: ")), true);
  assert.equal(isTransientRpcError(new RateLimitedError("429")), true);
  assert.equal(isTransientRpcError(new RpcTimeoutError("rpc request to http://a timed out after 5 ms")), true);
  const dropped = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  assert.equal(isTransientRpcError(dropped), true);
  const refused = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
  assert.equal(isTransientRpcError(refused), true);
  assert.equal(isTransientRpcError(new Error("failed to get info about accounts: Invalid param: WrongSize")), false);
});

const KEYED_URL_TEXT =
  "connect failed for https://user:hunter2@rpc.example.com/v2/PATH-TOKEN?api-key=QUERY-TOKEN then wss://user:hunter2@rpc.example.com/v2/PATH-TOKEN?api-key=QUERY-TOKEN.";
const KEY_TOKENS = ["PATH-TOKEN", "QUERY-TOKEN", "hunter2", "user:"];

test("pr 395 review: a websocket error on the connection's own emitter is logged without the RPC key", () => {
  const connection = createFailoverConnection(["http://127.0.0.1:1"]);
  const internals = connection as unknown as {
    _rpcWebSocket: { emit(event: string, ...args: unknown[]): boolean };
    _rpcWebSocketConnected: boolean;
  };
  internals._rpcWebSocketConnected = true;
  const captured: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : String(a))).join(" "));
  };
  try {
    internals._rpcWebSocket.emit("error", new Error(KEYED_URL_TEXT));
  } finally {
    console.error = original;
  }
  assert.equal(captured.length, 1, captured.join(" | "));
  assert.ok(captured[0]!.startsWith("ws error:"), captured[0]);
  assert.ok(captured[0]!.includes("https://rpc.example.com") && captured[0]!.includes("wss://rpc.example.com"), captured[0]);
  for (const token of KEY_TOKENS) assert.equal(captured[0]!.includes(token), false, captured[0]);
  assert.equal(internals._rpcWebSocketConnected, false, "the base handler still marks the socket down");
});

test("pr 395 review: websocket call rejections reach web3.js's subscribe and unsubscribe logs redacted", async () => {
  const connection = createFailoverConnection(["http://127.0.0.1:1"]);
  const ws = (connection as unknown as { _rpcWebSocket: { call: unknown; constructor: { prototype: { call: unknown } } } })
    ._rpcWebSocket;
  assert.notEqual(ws.call, ws.constructor.prototype.call, "the connection's socket call is wrapped");
  const wrapped = redactRejections(async () => {
    throw new Error(KEYED_URL_TEXT);
  });
  await assert.rejects(wrapped(), (err: unknown) => {
    assert.ok(err instanceof Error);
    for (const token of KEY_TOKENS) assert.equal(`${err.message} ${err.stack ?? ""}`.includes(token), false, err.message);
    return true;
  });
  const rpcError = { code: -32601, message: "Method not found" };
  await assert.rejects(
    redactRejections(async () => {
      throw rpcError;
    })(),
    (err: unknown) => {
      assert.deepEqual(err, rpcError, "a JSON-RPC error without a URL keeps its code and message");
      return true;
    },
  );
});

test("pr 395 review: a plain JSON-RPC rejection is redacted in message and nested data, through web3.js's subscription logger", async () => {
  // The websocket transport rejects a server error with the plain
  // message.error object, and _updateSubscriptions logs it whole. The
  // prototype `call` is replaced before the connection is built, so the
  // connection's wrapper wraps this rejection like the real transport's.
  const probe = createFailoverConnection(["http://127.0.0.1:1"]);
  let owner: { call: unknown; connect: unknown } | null = Object.getPrototypeOf(
    (probe as unknown as { _rpcWebSocket: object })._rpcWebSocket,
  );
  while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, "call")) owner = Object.getPrototypeOf(owner);
  assert.ok(owner !== null, "found the websocket client's call");
  const connectOwner = (() => {
    let p: { connect: unknown } | null = Object.getPrototypeOf((probe as unknown as { _rpcWebSocket: object })._rpcWebSocket);
    while (p !== null && !Object.prototype.hasOwnProperty.call(p, "connect")) p = Object.getPrototypeOf(p);
    return p!;
  })();
  const originalCall = owner.call;
  const originalConnect = connectOwner.connect;
  const rpcError = {
    code: -32000,
    message: `subscribe refused at ${KEYED_URL_TEXT}`,
    data: {
      endpoint: "wss://user:hunter2@rpc.example.com/v2/PATH-TOKEN?api-key=QUERY-TOKEN",
      nested: { urls: [KEYED_URL_TEXT], slot: 7, "wss://user:hunter2@rpc.example.com/v2/PATH-TOKEN?api-key=QUERY-TOKEN": "keyed" },
    },
  };
  let target: { _rpcWebSocketGeneration: number } | null = null;
  let calls = 0;
  owner.call = async function () {
    calls += 1;
    // Mark the socket generation stale so web3.js logs once and does not resubscribe.
    if (target !== null) target._rpcWebSocketGeneration += 1;
    throw rpcError;
  };
  connectOwner.connect = function () {};
  const captured: unknown[][] = [];
  const originalError = console.error;
  try {
    const connection = createFailoverConnection(["http://127.0.0.1:1"]);
    const internals = connection as unknown as { _rpcWebSocketConnected: boolean; _rpcWebSocketGeneration: number };
    target = internals;
    internals._rpcWebSocketConnected = true;
    console.error = (...args: unknown[]) => {
      captured.push(args);
    };
    connection.onSlotChange(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    console.error = originalError;
    owner.call = originalCall;
    connectOwner.connect = originalConnect;
  }
  assert.equal(calls, 1);
  const line = captured.find((args) => String(args[0]).includes("error calling"));
  assert.ok(line !== undefined, `the subscription logger ran: ${JSON.stringify(captured)}`);
  const logged = (line[1] as { error: { code: number; message: string; data: { nested: { slot: number } } } }).error;
  const text = JSON.stringify(line);
  for (const token of KEY_TOKENS) assert.equal(text.includes(token), false, text);
  // The console's own rendering, as it would appear in the job log.
  const rendered = inspect(line, { depth: null });
  for (const token of KEY_TOKENS) assert.equal(rendered.includes(token), false, rendered);
  assert.equal((logged.data.nested as unknown as Record<string, unknown>)["wss://rpc.example.com"], "keyed", "a URL key is kept, redacted");
  assert.equal(logged.code, -32000, "the numeric code is kept");
  assert.equal(logged.data.nested.slot, 7, "the structure and other values are kept");
  assert.ok(logged.message.includes("https://rpc.example.com"), logged.message);
  assert.notEqual(logged, rpcError, "the unsanitized object is not what was logged");
});

test("pr 395 review: deep redaction keeps scalars and shape and drops what it cannot inspect", () => {
  const err = Object.assign(new Error("boom at https://rpc.example.com/PATH-TOKEN"), { cause: { url: "https://rpc.example.com/PATH-TOKEN" } });
  const out = redactRpcUrlsDeep({ code: 1, ok: true, none: null, list: ["wss://a.example/QUERY-TOKEN"], err, when: new Date(0) }) as Record<
    string,
    unknown
  >;
  assert.equal(JSON.stringify(out).includes("TOKEN"), false);
  assert.equal(out.code, 1);
  assert.equal(out.ok, true);
  assert.equal(out.none, null);
  assert.deepEqual(out.list, ["wss://a.example"]);
  assert.ok(out.err instanceof Error);
  assert.equal((out.err as Error).cause, undefined, "no unsanitized cause is kept");
  assert.equal(out.when, "[redacted]");
  const keyed = JSON.parse(
    '{"code":3,"https://rpc.example.com/PATH-TOKEN":1,"https://rpc.example.com/QUERY-TOKEN":2,"__proto__":{"polluted":true}}',
  );
  const keyedOut = redactRpcUrlsDeep(keyed) as Record<string, unknown>;
  assert.deepEqual(Object.keys(keyedOut), ["code", "https://rpc.example.com", "https://rpc.example.com#2", "__proto__"]);
  assert.equal(keyedOut.code, 3);
  assert.equal(Object.getPrototypeOf(keyedOut), Object.prototype, "a __proto__ key does not change the prototype");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const cyclic: Record<string, unknown> = { message: "https://rpc.example.com/PATH-TOKEN" };
  cyclic.self = cyclic;
  assert.equal(JSON.stringify(redactRpcUrlsDeep(cyclic)).includes("TOKEN"), false);
});

test("pr 395 review: transient matching is narrow: a stray 500 or the word network is not a server error", () => {
  assert.equal(isTransientRpcError(new Error("Invalid param: expected at most 500 accounts")), false);
  assert.equal(isTransientRpcError(new Error("account belongs to another network")), false);
  assert.equal(isTransientRpcError(new Error("decode timeout field missing")), false);
  assert.equal(isTransientRpcError(new Error("Transaction simulation failed: 5000 lamports")), false);
});

test("pr 395 review: a timed-out endpoint is skipped on later passes, so a recovering fallback gets its retry", async () => {
  const calls: string[] = [];
  let bCalls = 0;
  const failover = makeFailoverFetch(["http://a.invalid", "http://b.invalid"], () => {}, {
    fetch: async (input, init) => {
      const url = String(input);
      calls.push(url.includes("a.invalid") ? "A" : "B");
      if (url.includes("a.invalid")) return hangingUntilAborted(init);
      bCalls += 1;
      if (bCalls === 1) return new Response("Too Many Requests", { status: 429 });
      return okResponse();
    },
    sleep: async () => {},
    initialDelayMs: 0,
    timeoutMs: 30,
  });
  const res = await failover("http://a.invalid", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["A", "B", "B"]);
});

test("pr 395 review: the timeout stops once headers arrive, so a slow body is not cut off", async () => {
  let seen: AbortSignal | undefined;
  const failover = makeFailoverFetch(["http://a.invalid"], () => {}, {
    fetch: async (_input, init) => {
      seen = init?.signal ?? undefined;
      return okResponse();
    },
    timeoutMs: 20,
  });
  const res = await failover("http://a.invalid", { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(seen !== undefined);
  assert.equal(seen.aborted, false, "the signal the body reads under is not aborted after the timeout");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 1, result: "ok" });
});
