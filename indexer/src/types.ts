import type { Connection } from "@solana/web3.js";

export type DecisionKind = "paid" | "refused" | "traded" | "hold_migrated" | "hold_closed";

export type Decision = {
  vault?: string;
  owner?: string;
  destination?: string;
  rule?: string;
  amountIn?: bigint;
  amountOut?: bigint;
  minOut?: bigint;
  signature: string;
  slot: number;
  timestamp: number | null;
  mandate: string;
  amount: bigint;
  nonce: bigint;
  counterparty: string;
  kind: DecisionKind;
  reason: number;
  reasonText: string;
  suggestedOverride: bigint;
};

export type RingEntry = {
  ts: bigint;
  amount: bigint;
  counterparty: string;
  nonce: bigint;
  suggestedOverride: bigint;
  kind: number;
  kindName: string;
  reason: number;
  reasonText: string;
};

export type LedgerSnapshot = {
  address: string;
  mandate: string;
  total: number;
  head: number;
  bump: number;
  entries: RingEntry[];
};

export type SignaturePage = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
};

export type CompiledIx = {
  programId: string;
  accounts: string[];
  data: Buffer;
};

export type TxView = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  logs: string[];
  accountKeys: string[];
  instructions: CompiledIx[];
};

export type FetchHistoryOptions = {
  rpcUrl: string;
  programId: string;
  mandate?: string;
  pageSize?: number;
  allowBlockScan?: boolean;
  maxSlots?: number;
  // Reader's connection. Verify passes the connection it already opened so a
  // date_range check hits the same RPC the rest of the verdict used.
  connection?: Connection;
  // Inclusive unix seconds. Signature pages are newest-first, so paging stops
  // once a signature is older than `from`. getTransaction is skipped for
  // signatures outside [from, to].
  from?: number | null;
  to?: number | null;
};

export type OverlapRow = {
  ring: RingEntry;
  indexed: Decision | null;
  equal: boolean;
  diffs: string[];
};

export type Comparison = {
  ringDecisions: number;
  matched: number;
  ok: boolean;
  rows: OverlapRow[];
  extraInIndexer: Decision[];
};
