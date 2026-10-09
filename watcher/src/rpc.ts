import { Connection } from "@solana/web3.js";

export function redactRpcUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid-rpc-url";
  }
  // ws and wss are the subscription endpoints web3.js derives from the RPC URL,
  // and they carry the same key in the path.
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return "invalid-rpc-url";
  // Scheme and host only. Alchemy, QuickNode, and Ankr put the key in the path.
  // url.host is hostname plus port, and it already brackets IPv6.
  return `${url.protocol}//${url.host}`;
}

export function redactRpcUrls(urls: readonly string[]): string {
  return urls.map((url) => redactRpcUrl(url)).join(",");
}

export function redactRpcUrlsInText(message: string): string {
  return message.replace(/(?:https?|wss?):\/\/[^\s]+/g, (match) => {
    const trimmed = match.replace(/[),.;]+$/g, "");
    return redactRpcUrl(trimmed) + match.slice(trimmed.length);
  });
}

export class RateLimitedError extends Error {
  readonly endpoints: readonly string[];

  constructor(message: string, endpoints: readonly string[] = []) {
    super(message);
    this.name = "RateLimitedError";
    this.endpoints = endpoints;
  }
}

/** One RPC request that got no response within the timeout. */
export class RpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTimeoutError";
  }
}

/** Default bound on one RPC request, VETO_RPC_TIMEOUT_MS. */
export const DEFAULT_RPC_TIMEOUT_MS = 20_000;

/** VETO_RPC_TIMEOUT_MS. Unset is the default; the value must be a positive whole number of milliseconds. */
export function parseRpcTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RPC_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) === 0) {
    throw new Error(`config.loadConfig: VETO_RPC_TIMEOUT_MS must be a positive whole number, got ${trimmed}`);
  }
  return Number.parseInt(trimmed, 10);
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type FailoverFetchOpts = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxPasses?: number;
  /** Bound on each request to one endpoint. A request past it fails over to the next endpoint. */
  timeoutMs?: number;
};

const RATE_LIMIT_RE = /\b429\b|too many requests|rate limit/i;

export function parseRpcList(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null) return [];
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (seen.has(part)) continue;
    try {
      assertHttpUrl(part);
    } catch (err) {
      if (err instanceof Error && err.message === "invalid rpc endpoint") {
        throw new Error(`invalid rpc endpoint at position ${i + 1}`);
      }
      throw err;
    }
    seen.add(part);
    out.push(part);
  }
  return out;
}

function assertHttpUrl(part: string): void {
  let url: URL;
  try {
    url = new URL(part);
  } catch {
    throw new Error("invalid rpc endpoint");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("invalid rpc endpoint");
  }
  if (url.hostname.length === 0) {
    throw new Error("invalid rpc endpoint");
  }
}

export function isRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitedError) return true;
  if (typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "RateLimitedError") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_RE.test(msg);
}

/** Node and undici error codes for a connection that failed or dropped. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
]);
const TRANSIENT_NAMES = new Set(["RpcTimeoutError", "TimeoutError", "AbortError"]);
/** Text forms of the same failures, for errors that were rewrapped as a message:
 * an HTTP 5xx status line as web3.js writes it, undici's "fetch failed", a
 * Node error code, and this module's own timeout line. */
const TRANSIENT_TEXT_RE = new RegExp(
  [
    String.raw`\b50[0-4] (?:Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout)\b`,
    String.raw`\bfetch failed\b`,
    String.raw`\bsocket hang up\b`,
    String.raw`\brpc request to \S+ timed out after \d+ ms\b`,
    String.raw`\b(?:${[...TRANSIENT_CODES].join("|")})\b`,
  ].join("|"),
);

/** True for a failure a later read could get past: a rate limit, a timeout,
 * a dropped connection, or an HTTP 5xx. False for an answer the endpoint
 * would give again, such as a rejected request. Follows `cause` a few levels,
 * where undici puts the socket error under "fetch failed". */
export function isTransientRpcError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "object") {
      const { name, code } = current as { name?: unknown; code?: unknown };
      if (typeof name === "string" && TRANSIENT_NAMES.has(name)) return true;
      if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    }
    const msg = current instanceof Error ? current.message : String(current);
    if (TRANSIENT_TEXT_RE.test(msg)) return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function nextDelay(delay: number, cap: number): number {
  if (delay <= 0) return delay;
  const doubled = delay * 2;
  return doubled > cap ? cap : doubled;
}

export function makeFailoverFetch(
  endpoints: readonly string[],
  log: (line: string) => void = () => {},
  opts: FailoverFetchOpts = {},
): FetchLike {
  const list = [...endpoints];
  if (list.length === 0) {
    throw new Error("no rpc endpoints configured");
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleepFn = opts.sleep ?? sleep;
  const initialDelayMs = opts.initialDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 8_000;
  const maxPasses = opts.maxPasses ?? 5;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  return async (input, init) => {
    let delay = initialDelayMs;
    let lastErr: unknown;
    // A hung endpoint is tried once per request, not once per pass: each
    // timeout already cost timeoutMs, so later passes skip it and keep
    // trying the endpoints that still answer.
    const timedOut = new Set<number>();
    const hasMoreAfter = (i: number, pass: number): boolean => {
      for (let j = i + 1; j < list.length; j += 1) if (!timedOut.has(j)) return true;
      return pass + 1 < maxPasses && timedOut.size < list.length;
    };
    for (let pass = 0; pass < maxPasses; pass += 1) {
      for (let i = 0; i < list.length; i += 1) {
        if (timedOut.has(i)) continue;
        const endpoint = list[i]!;
        const url = i === 0 ? requestUrl(input) : endpoint;
        const hasMore = hasMoreAfter(i, pass);
        // The timer bounds the wait for the response headers and is cleared
        // once they arrive, so a large body is not cut off mid-read.
        const controller = new AbortController();
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          controller.abort(new RpcTimeoutError(`rpc request timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        const caller = init?.signal ?? null;
        const signal = caller === null ? controller.signal : AbortSignal.any([caller, controller.signal]);
        try {
          let res: Response;
          try {
            res = await doFetch(url, { ...init, signal });
          } finally {
            clearTimeout(timer);
          }
          if (res.status === 429) {
            const shown = redactRpcUrl(endpoint);
            log(`rpc rate limited on ${shown}`);
            lastErr = new RateLimitedError(`rpc rate limited on ${shown}`, list);
            if (!hasMore) throw lastErr;
            if (delay > 0) await sleepFn(delay);
            delay = nextDelay(delay, maxDelayMs);
            continue;
          }
          return res;
        } catch (err) {
          if (err instanceof RateLimitedError && !hasMore) throw err;
          if (expired && !(caller?.aborted ?? false)) {
            const shown = redactRpcUrl(endpoint);
            log(`rpc request to ${shown} timed out after ${timeoutMs} ms`);
            timedOut.add(i);
            lastErr = new RpcTimeoutError(`rpc request to ${shown} timed out after ${timeoutMs} ms`);
            if (!hasMoreAfter(i, pass)) throw lastErr;
            continue;
          }
          lastErr = err;
          if (isRateLimitError(err)) {
            if (!(err instanceof RateLimitedError)) {
              log(`rpc rate limited on ${redactRpcUrl(endpoint)}`);
            }
            if (!hasMore) {
              throw err instanceof RateLimitedError
                ? err
                : new RateLimitedError("rpc rate limited on all endpoints", list);
            }
            if (delay > 0) await sleepFn(delay);
            delay = nextDelay(delay, maxDelayMs);
            continue;
          }
          throw err;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new RateLimitedError("rpc rate limited on all endpoints", list);
  };
}

/** The web3.js internals the redacting subclass touches. They are marked
 * internal, so they are not in the published types. */
type ConnectionWsInternals = {
  _wsOnError(err: Error): void;
  _rpcWebSocket?: { call?: (...args: unknown[]) => Promise<unknown> };
};

/** The same error with every RPC URL in its message cut to scheme and host. */
function redactedError(err: Error): Error {
  const out = new Error(redactRpcUrlsInText(err.message));
  out.name = err.name;
  return out;
}

/** A copy of `value` with every RPC URL in every string cut to scheme and
 * host: strings, arrays and plain objects are copied and walked, numbers and
 * other scalars are kept, an Error becomes a redacted Error with no cause.
 * Anything else (a class instance, a function) is replaced by a placeholder,
 * so no unsanitized object survives in the copy. */
export function redactRpcUrlsDeep(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactRpcUrlsInText(value);
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? "[function]" : value;
  }
  if (value instanceof Error) return redactedError(value);
  if (seen.has(value) || depth >= 8) return "[redacted]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactRpcUrlsDeep(item, depth + 1, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "[redacted]";
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // A key can be a URL too. Two keys that redact alike get a numeric suffix.
    let name = redactRpcUrlsInText(key);
    for (let n = 2; Object.prototype.hasOwnProperty.call(out, name); n += 1) name = `${redactRpcUrlsInText(key)}#${n}`;
    // defineProperty, so a key named __proto__ is a plain property, not a prototype change.
    Object.defineProperty(out, name, {
      value: redactRpcUrlsDeep(item, depth + 1, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Wrap an async call so whatever it rejects with has its RPC URLs redacted:
 * an Error, or a plain JSON-RPC error object ({ code, message, data }) as the
 * websocket transport rejects server errors, with its code and shape kept. */
export function redactRejections<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw redactRpcUrlsDeep(err);
    }
  };
}

/** A Connection whose own websocket error logging cannot print a keyed RPC URL.
 *
 * web3.js logs websocket errors with console.error from inside Connection:
 * `_wsOnError` prints err.message, and the subscribe and unsubscribe paths of
 * `_updateSubscriptions` print the error `_rpcWebSocket.call` rejected with.
 * `_wsOnError` is overridden here (the base still runs, so its connection
 * state update is kept) and `call` is wrapped, so both see redacted text.
 * Scoped to this class; console is not touched.
 */
class RedactingConnection extends Connection {
  constructor(endpoint: string, config: ConstructorParameters<typeof Connection>[1]) {
    super(endpoint, config);
    const ws = (this as unknown as ConnectionWsInternals)._rpcWebSocket;
    if (ws !== undefined && typeof ws.call === "function") {
      ws.call = redactRejections(ws.call.bind(ws));
    }
  }

  // The base constructor binds this._wsOnError to the socket's error event,
  // and that lookup finds this override on the subclass prototype.
  _wsOnError(err: Error): void {
    const base = (Connection.prototype as unknown as ConnectionWsInternals)._wsOnError;
    base.call(this, redactedError(err instanceof Error ? err : new Error(String(err))));
  }
}

export function createFailoverConnection(
  endpoints: readonly string[],
  log: (line: string) => void = () => {},
  opts: FailoverFetchOpts = {},
): Connection {
  const list = [...endpoints];
  if (list.length === 0) {
    throw new Error("no rpc endpoints configured");
  }
  return new RedactingConnection(list[0]!, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: makeFailoverFetch(list, log, opts),
  });
}


