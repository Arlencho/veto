import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { act, createElement, type ReactNode } from 'react';
import { create } from 'react-test-renderer';

import { skipInstruction } from './holdTx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const programId = Keypair.generate().publicKey;
const owner = Keypair.generate();
const guardian = Keypair.generate();
const destination = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const vaultId = 2n;
const id = 5n;

const sent: Transaction[][] = [];
type SkipProps = {
  payload: string;
  onPayload: (text: string) => void;
  onSign: () => Promise<void>;
  request: { ok: true; lines: readonly string[] } | { ok: false; reason: string } | null;
};
let latest: SkipProps | null = null;

const bundle = {
  account: {
    owner: owner.publicKey,
    guardian: guardian.publicKey,
    vaultId,
    mint,
    safeAddress: Keypair.generate().publicKey,
    frozen: false,
    pending: [{ id, amount: 1_000n, destination, unlockAt: 1_900_000_000n }],
  },
  decimals: 0,
  tokenProgram: TOKEN_PROGRAM_ID,
};

mock.module('expo-router', {
  namedExports: {
    useRouter: () => ({ replace() {}, back() {}, push() {} }),
    useLocalSearchParams: () => ({ vault: 'vault', id: id.toString() }),
  },
});
mock.module('expo-clipboard', { namedExports: { setStringAsync: async () => undefined } });
mock.module('../components/Screen', {
  namedExports: { Screen: ({ children }: { children: ReactNode }) => children },
});
mock.module('../components/ConnectGate', {
  namedExports: { ConnectGate: ({ children }: { children: ReactNode }) => children },
});
mock.module('../components/hold/SkipScreen', {
  namedExports: {
    SkipScreen: (props: SkipProps) => {
      latest = props;
      return null;
    },
  },
});
mock.module('./holdSign', {
  namedExports: {
    // The real decoder, without the wallet session imports behind it.
    holdRequestFromPayload: (payload: string) => Transaction.from(Buffer.from(payload.trim(), 'base64')),
    signHoldPartialWithSession: async () => {
      throw new Error('not used');
    },
  },
});
mock.module('./holdActions', {
  namedExports: {
    compileSkip: async () => {
      throw new Error('not used');
    },
    compileUnfreeze: async () => {
      throw new Error('not used');
    },
  },
});
mock.module('./holdSession', {
  namedExports: {
    useHoldBundle: () => ({
      status: 'ready',
      error: null,
      bundle,
      client: { programId, connection: {} },
      owner: guardian.publicKey,
      network: 'Test tokens',
      tokenName: 'test tokens',
      reload: async () => undefined,
      wallet: {
        busy: false,
        signAndSend: async (txs: Transaction[]) => {
          sent.push(txs);
          return ['sig'];
        },
      },
    }),
  },
});

function payloadOf(instructions: TransactionInstruction[], signers: Keypair[], feePayer = owner.publicKey): string {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.add(...instructions);
  if (signers.length > 0) tx.partialSign(...signers);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

async function pasteAndSign(payload: string): Promise<{ error: string | null; request: SkipProps['request'] }> {
  const Screen = (await import('../app/hold/skip')).default;
  let error: string | null = null;
  await act(async () => {
    create(createElement(Screen));
  });
  await act(async () => {
    latest!.onPayload(payload);
  });
  const request = latest!.request;
  try {
    await act(async () => {
      await latest!.onSign();
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { error, request };
}

const legitSkip = () =>
  skipInstruction({
    programId,
    owner: owner.publicKey,
    guardian: guardian.publicKey,
    vaultId,
    destination,
    mint,
    id,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

test('a pasted forged transfer is refused on the skip screen and nothing is signed', async () => {
  sent.length = 0;
  const forged = SystemProgram.transfer({
    fromPubkey: guardian.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 5_000_000_000,
  });
  const { error, request } = await pasteAndSign(payloadOf([forged], [], guardian.publicKey));
  assert.equal(sent.length, 0);
  assert.match(error ?? '', /Nothing was signed/);
  assert.equal(request?.ok, false);
});

test('the legitimate pasted request is shown with its facts and signed', async () => {
  sent.length = 0;
  const { error, request } = await pasteAndSign(payloadOf([legitSkip()], [owner]));
  assert.equal(error, null);
  assert.equal(sent.length, 1);
  assert.equal(request?.ok, true);
  const lines = request?.ok ? request.lines.join('\n') : '';
  assert.match(lines, /skip the wait/);
  assert.match(lines, /Withdrawal: #5, 1,000 test tokens/);
  assert.match(lines, new RegExp(`Destination: ${destination.toBase58()}`));
});
