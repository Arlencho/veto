import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Connection, Keypair } from '@solana/web3.js';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });

const KEYED = 'https://keyed.invalid/?api-key=tester';
const PUBLIC_DEVNET = 'https://api.devnet.solana.com';

type Call = { url: string; method: string };

/** A fake network: the keyed endpoint answers `keyedStatus`, the public one answers a slot. */
function network(keyedStatus: number) {
  const calls: Call[] = [];
  const fetchFn = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    let body: { id?: unknown; method?: string } | { method?: string }[] = {};
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as typeof body;
    } catch {
      // Not JSON-RPC; recorded with no method.
    }
    const first = Array.isArray(body) ? body[0] : body;
    calls.push({ url, method: first?.method ?? '' });
    if (url === KEYED && keyedStatus !== 200) {
      return new Response('{"error":"refused"}', { status: keyedStatus, headers: { 'content-type': 'application/json' } });
    }
    const id = (first as { id?: unknown } | undefined)?.id ?? 1;
    const result = first?.method === 'getSlot' ? (url === KEYED ? 111 : 222) : 'sig';
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { calls, fetchFn };
}

async function connectionOver(keyedStatus: number) {
  const { readFallbackFetch } = await import('./rpcFallback');
  const net = network(keyedStatus);
  const connection = new Connection(KEYED, {
    commitment: 'confirmed',
    fetch: readFallbackFetch(KEYED, 'devnet', net.fetchFn),
    disableRetryOnRateLimit: true,
  });
  return { ...net, connection };
}

for (const status of [401, 403, 429]) {
  test(`a read refused with ${status} is answered by the public endpoint of the same cluster`, async () => {
    const { calls, connection } = await connectionOver(status);
    assert.equal(await connection.getSlot(), 222);
    assert.deepEqual(
      calls.map((call) => call.url),
      [KEYED, PUBLIC_DEVNET],
    );
  });
}

test('a healthy endpoint and a server error are not redirected', async () => {
  const ok = await connectionOver(200);
  assert.equal(await ok.connection.getSlot(), 111);
  assert.deepEqual(ok.calls.map((call) => call.url), [KEYED]);

  const broken = await connectionOver(500);
  await assert.rejects(broken.connection.getSlot());
  assert.deepEqual(broken.calls.map((call) => call.url), [KEYED]);
});

test('sending a transaction never falls back to another endpoint', async () => {
  const { calls, connection } = await connectionOver(429);
  await assert.rejects(connection.sendRawTransaction(Buffer.alloc(8), { skipPreflight: true }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, KEYED);
  assert.equal(calls[0]?.method, 'sendTransaction');
});

test('a batch with a send, or a body that is not JSON-RPC, stays on the configured endpoint', async () => {
  const { readFallbackFetch } = await import('./rpcFallback');
  const net = network(429);
  const fetchFn = readFallbackFetch(KEYED, 'devnet', net.fetchFn);
  const batch = JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'getSlot' },
    { jsonrpc: '2.0', id: 2, method: 'sendTransaction', params: ['x'] },
  ]);
  assert.equal((await fetchFn(KEYED, { method: 'POST', body: batch })).status, 429);
  assert.equal((await fetchFn(KEYED, { method: 'POST', body: 'not json' })).status, 429);
  assert.ok(net.calls.every((call) => call.url === KEYED));
});

test('no fallback without a known public endpoint, or when it is already the configured one', async () => {
  const { publicFallbackFor } = await import('./rpcFallback');
  assert.equal(publicFallbackFor(KEYED, 'devnet'), PUBLIC_DEVNET);
  assert.equal(publicFallbackFor(KEYED, 'mainnet-beta'), 'https://api.mainnet-beta.solana.com');
  assert.equal(publicFallbackFor(PUBLIC_DEVNET, 'devnet'), null);
  assert.equal(publicFallbackFor(KEYED, 'localnet'), null);
});

test('the app chain client reads through the public endpoint when its key is exhausted', async () => {
  const { createClient } = await import('./chain');
  const net = network(429);
  const saved = globalThis.fetch;
  globalThis.fetch = net.fetchFn;
  try {
    const client = createClient({
      rpcUrl: KEYED,
      programId: Keypair.generate().publicKey.toBase58(),
      mint: null,
      explorerCluster: 'devnet',
      mintDecimals: 6,
    });
    assert.equal(await client.connection.getSlot(), 222);
    assert.ok(net.calls.some((call) => call.url === PUBLIC_DEVNET));
  } finally {
    globalThis.fetch = saved;
  }
});
