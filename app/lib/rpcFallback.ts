import { Connection, type Commitment } from '@solana/web3.js';

import { publicRpcFor } from './rpcPrivacy';

type Fetch = typeof globalThis.fetch;

/** The configured endpoint refused us: bad or exhausted key, or rate limited. */
const FALLBACK_STATUSES = new Set([401, 403, 429]);

/** Calls that change state are never replayed on another endpoint. */
const WRITE_METHODS = new Set(['sendTransaction', 'requestAirdrop']);

/** The public endpoint of the same cluster, or null when there is none to fall back to. */
export function publicFallbackFor(rpcUrl: string, cluster: string): string | null {
  let fallback: string;
  try {
    fallback = publicRpcFor(cluster);
  } catch {
    return null;
  }
  return fallback === rpcUrl.trim() ? null : fallback;
}

/** True unless the body is JSON-RPC made only of read calls. Unknown bodies count as writes. */
function mayWrite(body: unknown): boolean {
  if (typeof body !== 'string') return true;
  try {
    const parsed: unknown = JSON.parse(body);
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    return calls.some((call) => {
      const method = (call as { method?: unknown } | null)?.method;
      return typeof method !== 'string' || WRITE_METHODS.has(method);
    });
  } catch {
    return true;
  }
}

/**
 * A fetch for the JSON-RPC client: a read refused by the configured endpoint with 401, 403 or
 * 429 is asked again of the public endpoint of the same cluster, so the app still shows data when
 * the build's key is exhausted. Sends always stay on the configured endpoint.
 */
export function readFallbackFetch(
  rpcUrl: string,
  cluster: string,
  base: Fetch = (input, init) => globalThis.fetch(input, init),
): Fetch {
  const fallback = publicFallbackFor(rpcUrl, cluster);
  return async (input, init) => {
    const response = await base(input, init);
    if (!fallback || !FALLBACK_STATUSES.has(response.status) || mayWrite(init?.body)) {
      return response;
    }
    return base(fallback, init);
  };
}

export function openRpcConnection(rpcUrl: string, cluster: string, commitment: Commitment = 'confirmed'): Connection {
  return new Connection(rpcUrl, { commitment, fetch: readFallbackFetch(rpcUrl, cluster) });
}
