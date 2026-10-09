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

const TRANSIENT_RE =
  /fetch failed|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|\b50[0-4]\b/i;

/** True for a failure a later read could get past: a rate limit, a timeout,
 * a dropped connection, or a server error. False for an answer the endpoint
 * would give again, such as a rejected request. */
export function isTransientRpcError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  if (typeof err === "object" && err !== null && "name" in err) {
    const name = (err as { name: unknown }).name;
    if (name === "RpcTimeoutError" || name === "TimeoutError" || name === "AbortError") return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_RE.test(msg);
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
    // timeout already cost timeoutMs, so the request ends after every
    // endpoint has timed out once.
    let timeouts = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      for (let i = 0; i < list.length; i += 1) {
        const endpoint = list[i]!;
        const url = i === 0 ? requestUrl(input) : endpoint;
        const hasMore = i + 1 < list.length || pass + 1 < maxPasses;
        const timer = AbortSignal.timeout(timeoutMs);
        const caller = init?.signal ?? null;
        const signal = caller === null ? timer : AbortSignal.any([caller, timer]);
        try {
          const res = await doFetch(url, { ...init, signal });
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
          if (timer.aborted && !(caller?.aborted ?? false)) {
            const shown = redactRpcUrl(endpoint);
            log(`rpc request to ${shown} timed out after ${timeoutMs} ms`);
            timeouts += 1;
            lastErr = new RpcTimeoutError(`rpc request to ${shown} timed out after ${timeoutMs} ms`);
            if (timeouts >= list.length || !hasMore) throw lastErr;
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

export function createFailoverConnection(
  endpoints: readonly string[],
  log: (line: string) => void = () => {},
  opts: FailoverFetchOpts = {},
): Connection {
  const list = [...endpoints];
  if (list.length === 0) {
    throw new Error("no rpc endpoints configured");
  }
  return new Connection(list[0]!, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: makeFailoverFetch(list, log, opts),
  });
}


