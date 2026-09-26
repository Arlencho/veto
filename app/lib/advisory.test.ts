import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { mock } from 'node:test';

import { Buffer } from 'buffer';
import { act, createElement, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import {
  Keypair,
  Message,
  PublicKey,
  TransactionInstruction,
  type ConfirmedSignatureInfo,
  type Connection,
  type VersionedTransactionResponse,
} from '@solana/web3.js';

import {
  ENTRY_SIZE,
  KIND_PAID,
  KIND_REFUSED,
  LEDGER_ACCOUNT_SIZE,
  LEDGER_CAPACITY,
  LEDGER_DISCRIMINATOR,
  LEDGER_HEADER_SIZE,
  REASON_OVER_PER_TX_MAX,
} from './constants';
import type { ChainClient } from './chain';
import { ledgerPda, type LedgerRow } from './ring';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
mock.module('react-native', {
  namedExports: {
    Linking: { openURL: async () => undefined },
    Pressable: Host('Pressable'),
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
      hairlineWidth: 1,
      absoluteFill: {},
    },
    Text: Host('Text'),
    View: Host('View'),
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove() {} }),
    },
    Animated: {
      Value: class {
        setValue() {}
        interpolate() {
          return 0;
        }
      },
      View: Host('Animated.View'),
      Text: Host('Animated.Text'),
      timing: () => ({ start() {}, stop() {} }),
      delay: () => ({ start() {}, stop() {} }),
      sequence: () => ({ start() {}, stop() {} }),
      loop: () => ({ start() {}, stop() {} }),
      createAnimatedComponent: (Component: unknown) => Component,
    },
    Easing: {
      linear: (value: number) => value,
      cubic: (value: number) => value,
      out: (ease: (value: number) => number) => ease,
      inOut: (ease: (value: number) => number) => ease,
      bezier: () => (value: number) => value,
    },
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Path: Host('Path'),
    Circle: Host('Circle'),
    Rect: Host('Rect'),
    G: Host('G'),
    Defs: Host('Defs'),
    LinearGradient: Host('LinearGradient'),
    Stop: Host('Stop'),
  },
});
mock.module('expo-router', {
  namedExports: {
    useRouter: () => ({
      push: () => undefined,
    }),
  },
});

const advisoryModule = import('./advisory');
const chainModule = import('./chain');
const formatModule = import('./format');
const sdkAdvisory = import('../../sdk/src/advisory');

const DESCRIPTION = 'a bar tab';
const HASH = createHash('sha256').update(DESCRIPTION, 'utf8').digest('hex');
const REASON = 'bar tab, not transport';
const EXACT =
  'veto-advisory:v1{"mandate":"11111111111111111111111111111111","amount":"180","nonce":"7","reason":"bar tab, not transport","description_sha256":"1bfe4ca8d9b4656be983772e79f79eb552b24fd03ca715f2dfab3baa347692de"}';

const MEMO_PROGRAM = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');

function key(seed: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, seed));
}

function visibleText(root: ReactTestRenderer): string {
  const bits: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === 'string' || typeof child === 'number') {
      bits.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        walk(item);
      }
    }
  };
  for (const node of root.root.findAll((candidate) => (candidate.type as unknown) === 'Text')) {
    walk(node.props.children);
  }
  return bits.join('\n');
}

function entryBytes(args: {
  ts: bigint;
  amount: bigint;
  counterparty: Uint8Array;
  nonce: bigint;
  kind: number;
  reason: number;
}): Buffer {
  const raw = Buffer.alloc(ENTRY_SIZE);
  raw.writeBigInt64LE(args.ts, 0);
  raw.writeBigUInt64LE(args.amount, 8);
  Buffer.from(args.counterparty).copy(raw, 16);
  raw.writeBigUInt64LE(args.nonce, 48);
  raw[64] = args.kind;
  raw[65] = args.reason;
  return raw;
}

function ledgerBytes(mandate: PublicKey, slots: Buffer[]): Buffer {
  const data = Buffer.alloc(LEDGER_ACCOUNT_SIZE);
  LEDGER_DISCRIMINATOR.copy(data, 0);
  Buffer.from(mandate.toBytes()).copy(data, 8);
  data.writeUInt32LE(slots.length, 40);
  data.writeUInt16LE(0, 44);
  data[46] = 255;
  for (let i = 0; i < LEDGER_CAPACITY && i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) {
      continue;
    }
    slot.copy(data, 8 + LEDGER_HEADER_SIZE + i * ENTRY_SIZE);
  }
  return data;
}

function memoMessage(args: {
  signer: PublicKey;
  mandate: PublicKey;
  memo: string;
  mandateWritable?: boolean;
}): Message {
  const ix = new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [
      { pubkey: args.signer, isSigner: true, isWritable: false },
      { pubkey: args.mandate, isSigner: false, isWritable: args.mandateWritable ?? false },
    ],
    data: Buffer.from(args.memo, 'utf8'),
  });
  return Message.compile({
    payerKey: args.signer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [ix],
  });
}

function txBody(message: Message, signature: string): VersionedTransactionResponse {
  return {
    slot: 4,
    blockTime: 1_700_000_100,
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [], logMessages: [] },
    transaction: { signatures: [signature], message },
  } as unknown as VersionedTransactionResponse;
}

async function memoFor(mandate: string): Promise<string> {
  const { advisoryMemoText } = await sdkAdvisory;
  return advisoryMemoText({
    mandate,
    amount: 180n,
    nonce: 7n,
    reason: REASON,
    description: DESCRIPTION,
  }).text;
}

type ListedMemo = {
  signature: string;
  memo: string | null;
  err?: ConfirmedSignatureInfo['err'];
  body?: VersionedTransactionResponse | null;
  boom?: boolean;
};

async function readMandate(args: {
  mandate: PublicKey;
  agent: PublicKey;
  programId: PublicKey;
  memos: ListedMemo[];
}): Promise<LedgerRow[]> {
  const { fetchLedgerRows } = await chainModule;
  const peer = key(7).toBytes();
  const ledgerData = ledgerBytes(args.mandate, [
    entryBytes({
      ts: 1_000n,
      amount: 10n,
      counterparty: peer,
      nonce: 1n,
      kind: KIND_PAID,
      reason: 0,
    }),
    entryBytes({
      ts: 1_100n,
      amount: 20n,
      counterparty: peer,
      nonce: 2n,
      kind: KIND_REFUSED,
      reason: REASON_OVER_PER_TX_MAX,
    }),
  ]);
  const ledger = ledgerPda(args.programId, args.mandate);
  const bySig = new Map(args.memos.map((item) => [item.signature, item]));
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(ledger)) {
        return { data: ledgerData, owner: args.programId, executable: false, lamports: 1 };
      }
      return null;
    },
    getSignaturesForAddress: async (address: PublicKey) => {
      if (address.equals(ledger)) {
        return [];
      }
      if (!address.equals(args.mandate)) {
        return [];
      }
      return args.memos.map(
        (item): ConfirmedSignatureInfo => ({
          signature: item.signature,
          slot: 4,
          err: item.err ?? null,
          memo: item.memo,
          blockTime: 1_700_000_100,
          confirmationStatus: 'confirmed',
        }),
      );
    },
    getTransaction: async (signature: string) => {
      const item = bySig.get(signature);
      if (!item || item.boom) {
        throw new Error(`rpc failed for ${signature}`);
      }
      return item.body ?? null;
    },
  };
  const client: ChainClient = {
    config: {} as ChainClient['config'],
    connection: connection as unknown as Connection,
    programId: args.programId,
  };
  const loaded = await fetchLedgerRows(client, args.mandate, args.agent);
  return loaded.rows;
}

function rpcMemo(text: string): string {
  return `[${Buffer.byteLength(text, 'utf8')}] ${text}`;
}

test('v1 memo text is veto-advisory:v1 plus compact JSON with the description hash', async () => {
  const { advisoryMemoText, parseAdvisoryMemo } = await sdkAdvisory;
  assert.equal(HASH, '1bfe4ca8d9b4656be983772e79f79eb552b24fd03ca715f2dfab3baa347692de');
  const written = advisoryMemoText({
    mandate: '11111111111111111111111111111111',
    amount: 180n,
    nonce: 7n,
    reason: REASON,
    description: DESCRIPTION,
  });
  assert.equal(written.text, EXACT);
  const parsed = parseAdvisoryMemo(EXACT);
  assert.ok(parsed, 'the pinned v1 string parses');
  assert.equal(parsed.mandate, '11111111111111111111111111111111');
  assert.equal(parsed.amount, 180n);
  assert.equal(parsed.nonce, 7n);
  assert.equal(parsed.reason, REASON);
  assert.equal(parsed.descriptionSha256, HASH);
  assert.equal(parseAdvisoryMemo(EXACT.replace('description_sha256', 'descriptionHash')), null);
  assert.equal(parseAdvisoryMemo(EXACT.replace('"180"', '180')), null);
  assert.equal(parseAdvisoryMemo('veto-advisory:v1{"mandate":'), null);
  assert.equal(parseAdvisoryMemo(EXACT.replace('veto-advisory:v1', 'veto-advisory:v2')), null);
});

test('an agent-signed v1 memo is shown as the agent\'s own note, with the reason and the amount', async () => {
  const { KIND_ADVISORY_DECLINE } = await advisoryModule;
  const { isListedDecision, formatBaseUnits } = await formatModule;
  const { DecisionRow } = await import('../components/DecisionRow');
  const { AdvisoryDeclineDetail } = await import('../components/AdvisoryDecline');
  const agent = Keypair.generate();
  const mandate = key(9);
  const text = await memoFor(mandate.toBase58());
  const rows = await readMandate({
    mandate,
    agent: agent.publicKey,
    programId: key(1),
    memos: [
      {
        signature: 'sig-agent',
        memo: rpcMemo(text),
        body: txBody(memoMessage({ signer: agent.publicKey, mandate, memo: text }), 'sig-agent'),
      },
    ],
  });
  const advisory = rows.filter((row) => row.kind === KIND_ADVISORY_DECLINE);
  assert.equal(advisory.length, 1);
  const row = advisory[0];
  assert.ok(row);
  assert.equal(row.reasonText, REASON);
  assert.equal(row.amount, 180n);
  assert.notEqual(row.kind, KIND_REFUSED);
  assert.equal(isListedDecision(row.kind), true);
  const amount = formatBaseUnits(row.amount, 6);

  let list: ReactTestRenderer | undefined;
  await act(async () => {
    list = create(
      createElement(DecisionRow, {
        row,
        decimals: 6,
        cluster: 'devnet',
        rpcUrl: 'http://127.0.0.1:8899',
        mandateAddress: mandate.toBase58(),
      }),
    );
  });
  assert.ok(list);
  const listText = visibleText(list);
  assert.match(listText, /Your agent's own note/);
  assert.match(listText, /Your agent declined on its own: bar tab, not transport/);
  assert.match(listText, /Not a refusal by the rule\. Your agent signed this note itself\./);
  assert.match(listText, /<0\.01/);
  assert.equal(amount, '0.00018');
  assert.doesNotMatch(listText, /Your rule held/);
  assert.doesNotMatch(listText, /Refused/);

  let detail: ReactTestRenderer | undefined;
  await act(async () => {
    detail = create(
      createElement(AdvisoryDeclineDetail, {
        when: '2026-09-24',
        reason: row.reasonText,
        amount,
      }),
    );
  });
  assert.ok(detail);
  const detailText = visibleText(detail);
  assert.match(detailText, /Your agent's own note/);
  assert.match(detailText, /Your agent declined on its own: bar tab, not transport/);
  assert.match(detailText, /Not a refusal by the rule\. Your agent signed this note itself\./);
  assert.match(detailText, /bar tab, not transport/);
  assert.match(detailText, /0\.00018/);
  assert.match(
    detailText,
    /The agent chose not to submit this charge; the program did not decide it\./,
  );
  assert.doesNotMatch(detailText, /Your rule held/);
  assert.doesNotMatch(detailText, /within rule/);
});

test('a memo signed by a stranger is ignored', async () => {
  const { KIND_ADVISORY_DECLINE } = await advisoryModule;
  const agent = Keypair.generate();
  const stranger = Keypair.generate();
  const mandate = key(9);
  const text = await memoFor(mandate.toBase58());
  const rows = await readMandate({
    mandate,
    agent: agent.publicKey,
    programId: key(1),
    memos: [
      {
        signature: 'sig-stranger',
        memo: rpcMemo(text),
        body: txBody(memoMessage({ signer: stranger.publicKey, mandate, memo: text }), 'sig-stranger'),
      },
    ],
  });
  assert.equal(
    rows.some((row) => row.kind === KIND_ADVISORY_DECLINE),
    false,
  );
});

test('a malformed memo is ignored and the agent decline still shows', async () => {
  const { KIND_ADVISORY_DECLINE } = await advisoryModule;
  const agent = Keypair.generate();
  const mandate = key(9);
  const text = await memoFor(mandate.toBase58());
  const broken = 'veto-advisory:v1{"mandate":';
  const rows = await readMandate({
    mandate,
    agent: agent.publicKey,
    programId: key(1),
    memos: [
      {
        signature: 'sig-broken',
        memo: rpcMemo(broken),
        body: txBody(memoMessage({ signer: agent.publicKey, mandate, memo: broken }), 'sig-broken'),
      },
      {
        signature: 'sig-boom',
        memo: rpcMemo(broken),
        boom: true,
      },
      {
        signature: 'sig-bad-message',
        memo: rpcMemo('veto-advisory:v1'),
        body: {
          slot: 4,
          blockTime: 1_700_000_100,
          meta: { err: null },
          transaction: {
            signatures: ['sig-bad-message'],
            message: {
              getAccountKeys() {
                throw new Error('bad message');
              },
              get compiledInstructions() {
                throw new Error('bad message');
              },
            },
          },
        } as unknown as VersionedTransactionResponse,
      },
      {
        signature: 'sig-agent',
        memo: rpcMemo(text),
        body: txBody(memoMessage({ signer: agent.publicKey, mandate, memo: text }), 'sig-agent'),
      },
    ],
  });
  const advisory = rows.filter((row) => row.kind === KIND_ADVISORY_DECLINE);
  assert.deepEqual(
    advisory.map((row) => row.signature),
    ['sig-agent'],
  );
  assert.equal(advisory[0]?.reasonText, REASON);
});

test('an advisory decline does not change paid or refused totals', async () => {
  const { KIND_ADVISORY_DECLINE } = await advisoryModule;
  const { decisionTotals } = await formatModule;
  const agent = Keypair.generate();
  const mandate = key(9);
  const text = await memoFor(mandate.toBase58());
  const rows = await readMandate({
    mandate,
    agent: agent.publicKey,
    programId: key(1),
    memos: [
      {
        signature: 'sig-agent',
        memo: rpcMemo(text),
        body: txBody(memoMessage({ signer: agent.publicKey, mandate, memo: text }), 'sig-agent'),
      },
    ],
  });
  assert.equal(
    rows.some((row) => row.kind === KIND_ADVISORY_DECLINE),
    true,
  );
  const withAdvisory = decisionTotals(rows);
  const withoutAdvisory = decisionTotals(rows.filter((row) => row.kind !== KIND_ADVISORY_DECLINE));
  assert.equal(withAdvisory.paid, 1);
  assert.equal(withAdvisory.refused, 1);
  assert.deepEqual(withAdvisory, withoutAdvisory);
});
