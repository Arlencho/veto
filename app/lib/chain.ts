import { redactRpc } from './rpcPrivacy';
import { Buffer } from 'buffer';
import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccount3Instruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  type ConfirmedSignatureInfo,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';

import type { AppConfig } from './appConfig';
import { loadConfig } from './config';
import {
  KIND_OPENED,
  KIND_OVERRIDE,
  KIND_REVOKED,
  LEDGER_ACCOUNT_SIZE,
  MANDATE_ACCOUNT_SIZE,
  OPEN_FEE_MARGIN_LAMPORTS,
  PURPOSE_MAX_LEN,
  STATUS_ACTIVE,
  STATUS_REVOKED,
} from './constants';
import { decodeEventsFromLogs, decodeInstructionKind } from './events';
import {
  closeMandateInstruction,
  grantOverrideInstruction,
  openMandateInstruction,
  revokeMandateInstruction,
} from './instructions';
import {
  classifyRuleSource,
  deriveRuleTokenAccount,
  openFundsRefusal,
  readConfirmedTokenAmount,
  readMintDecimals,
  readTokenAmount,
  readTokenDelegate,
  ruleTokenSeed,
  type RuleAccountKind,
} from './ruleAccount';
import { displayPurpose } from './ruleView';
import { isRateLimitError } from './rpcError';
import { openRpcConnection } from './rpcFallback';
import { signatureNotYetVisibleMessage, signatureSeenUnconfirmedMessage } from './wallet';
import { assessOverride, type OverrideAssessment } from './override';
import { decodeMandateAccount, isActive, type MandateAccount } from './mandate';
import { mergeDecisionRows, readAdvisoryDeclines } from './advisory';
import {
  attachSignatures,
  decodeLedgerAccount,
  ledgerPda,
  mandatePda,
  oldestMatchableBlockTime,
  type DecodedTxDecision,
  type LedgerRow,
  type LedgerSnapshot,
} from './ring';

export type SignAndSend = (transactions: Transaction[]) => Promise<string[]>;

// (account bytes + 128) * lamports per byte. This is devnet rent on 2026-09-23
// when the connection does not expose getMinimumBalanceForRentExemption.
const RENT_ACCOUNT_OVERHEAD = 128;
const RENT_LAMPORTS_PER_EXEMPT_BYTE = 5080;

export function rentExemptLamports(space: number): number {
  return (space + RENT_ACCOUNT_OVERHEAD) * RENT_LAMPORTS_PER_EXEMPT_BYTE;
}

type OpenAccountRent = { mandate: number; ledger: number };

async function rentForOpen(connection: Connection): Promise<OpenAccountRent> {
  if (typeof connection.getMinimumBalanceForRentExemption === 'function') {
    const mandate = await connection.getMinimumBalanceForRentExemption(MANDATE_ACCOUNT_SIZE);
    const ledger = await connection.getMinimumBalanceForRentExemption(LEDGER_ACCOUNT_SIZE);
    return { mandate, ledger };
  }
  return {
    mandate: rentExemptLamports(MANDATE_ACCOUNT_SIZE),
    ledger: rentExemptLamports(LEDGER_ACCOUNT_SIZE),
  };
}

async function quotedRent(connection: Connection, space: number): Promise<number> {
  if (typeof connection.getMinimumBalanceForRentExemption === 'function') {
    try {
      return await connection.getMinimumBalanceForRentExemption(space);
    } catch {
      return rentExemptLamports(space);
    }
  }
  return rentExemptLamports(space);
}

async function tokenAccountRent(connection: Connection): Promise<number> {
  return quotedRent(connection, ACCOUNT_SIZE);
}

async function payerFloorLamports(connection: Connection): Promise<number> {
  return quotedRent(connection, 0);
}

function openSolRefusal(args: {
  balance: number;
  mandateRent: number;
  ledgerRent: number;
  tokenRent: number;
  fee: number;
  floor: number | null;
}): string {
  const needed = args.tokenRent + args.mandateRent + args.ledgerRent + args.fee;
  const head = `Opening a rule needs ${needed} lamports of rent and fees: ${args.tokenRent} for the rule token account, ${args.mandateRent} for the mandate, ${args.ledgerRent} for the ledger, and ${args.fee} for the fee margin, and the wallet holds ${args.balance} lamports`;
  if (args.balance < needed) {
    return `${head}, short by ${needed - args.balance} lamports.`;
  }
  const left = args.balance - needed;
  return `${head}, which would leave ${left} lamports, above zero and below its own rent floor of ${args.floor ?? 0} lamports.`;
}

function closeSolRefusal(args: {
  balance: number;
  ataRent: number;
  fee: number;
  floor: number | null;
}): string {
  const needed = args.ataRent + args.fee;
  const detail = `The wallet holds ${args.balance} lamports. This close needs ${needed} lamports of rent and fees: ${args.ataRent} for the associated token account and ${args.fee} for the fee margin.`;
  if (args.balance < needed) {
    return `${detail} Short by ${needed - args.balance} lamports.`;
  }
  const left = args.balance - needed;
  return `${detail} After rent and fees the wallet would keep ${left} lamports, above zero and below its own rent floor of ${args.floor ?? 0} lamports.`;
}

async function ownerLamports(connection: Connection, owner: PublicKey): Promise<number> {
  if (typeof connection.getBalance === 'function') {
    return connection.getBalance(owner, 'confirmed');
  }
  const info = await connection.getAccountInfo(owner, 'confirmed');
  return info?.lamports ?? 0;
}

export type OpenMandateInput = {
  owner: PublicKey;
  agent: PublicKey;
  merchant: PublicKey;
  cap: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  purpose: string;
  mint?: PublicKey;
};

export type OpenMandateResult = {
  signature: string;
  mandate: MandateAccount;
  ledger: string;
};

export type RevokeResult = {
  signature: string;
  mandate: MandateAccount;
};

export type CloseResult = {
  signature: string;
};

export type RuleFunds = {
  source: string;
  balance: bigint | null;
  kind: RuleAccountKind;
  closeCreatesAssociated: boolean;
  decimals: number | null;
  /** Owner of the mint account, already read for decimals. */
  tokenProgram: string;
  otherRule: string | null;
};

export type GrantOverrideResult = {
  signature: string;
  mandate: MandateAccount;
  row: LedgerRow;
};

export type ChainClient = {
  config: AppConfig;
  connection: Connection;
  programId: PublicKey;
};

export const chainConnection = {
  open(rpcUrl: string, cluster: string): Connection {
    return openRpcConnection(rpcUrl, cluster);
  },
};

export function createClient(config: AppConfig = loadConfig()): ChainClient {
  return {
    config,
    connection: chainConnection.open(config.rpcUrl, config.explorerCluster),
    programId: new PublicKey(config.programId),
  };
}

export async function fetchMandate(
  client: ChainClient,
  address: PublicKey,
): Promise<MandateAccount> {
  const info = await client.connection.getAccountInfo(address, 'confirmed');
  if (!info) {
    throw new Error(`mandate ${address.toBase58()} was not found on chain`);
  }
  return decodeMandateAccount(address.toBase58(), info.data);
}

export async function fetchLedger(
  client: ChainClient,
  mandate: PublicKey,
): Promise<LedgerSnapshot> {
  const address = ledgerPda(client.programId, mandate);
  const info = await client.connection.getAccountInfo(address, 'confirmed');
  if (!info) {
    throw new Error(`ledger ${address.toBase58()} was not found on chain`);
  }
  return decodeLedgerAccount(address.toBase58(), info.data);
}

export async function fetchOwnerMandates(
  client: ChainClient,
  owner: PublicKey,
): Promise<MandateAccount[]> {
  const accounts = await client.connection.getProgramAccounts(client.programId, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 8, bytes: owner.toBase58() } }],
  });
  const mandates: MandateAccount[] = [];
  for (const account of accounts) {
    try {
      mandates.push(decodeMandateAccount(account.pubkey.toBase58(), account.account.data));
    } catch {
      // Ledgers and other program accounts share the program id. Skip those.
    }
  }
  mandates.sort((a, b) => (a.mandateId < b.mandateId ? 1 : a.mandateId > b.mandateId ? -1 : 0));
  return mandates;
}

/**
 * The rule Overview and Decisions show. A rule the user chose wins while it still exists.
 * Otherwise it is the most recently opened rule that is still live, then the most recently
 * opened rule not stopped, then the most recently opened rule. The mandate id is the open time
 * in milliseconds, so a larger id is a newer rule.
 */
export function pickMandate(
  mandates: MandateAccount[],
  preferredAddress: string | null,
  nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): MandateAccount | null {
  if (mandates.length === 0) {
    return null;
  }
  if (preferredAddress) {
    const preferred = mandates.find((m) => m.address === preferredAddress);
    if (preferred) {
      return preferred;
    }
  }
  const newest = [...mandates].sort((a, b) => (a.mandateId < b.mandateId ? 1 : a.mandateId > b.mandateId ? -1 : 0));
  return (
    newest.find((m) => isActive(m, nowSec)) ??
    newest.find((m) => m.status === STATUS_ACTIVE) ??
    newest[0] ??
    null
  );
}

export async function fetchMintDecimals(client: ChainClient, mint: PublicKey): Promise<number> {
  const mintInfo = await getMint(client.connection, mint, 'confirmed');
  return mintInfo.decimals;
}

export async function tokenProgramOfMint(
  client: ChainClient,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await client.connection.getAccountInfo(mint, 'confirmed');
  if (!info) {
    throw new Error(`mint ${mint.toBase58()} was not found on chain`);
  }
  return info.owner;
}

async function delegatedRuleName(client: ChainClient, delegate: PublicKey): Promise<string> {
  const address = delegate.toBase58();
  try {
    const info = await client.connection.getAccountInfo(delegate, 'confirmed');
    if (!info) {
      return address;
    }
    const other = decodeMandateAccount(address, info.data);
    const purpose = displayPurpose(other.purpose).trim();
    return purpose.length > 0 ? `${purpose} (${address})` : address;
  } catch {
    return address;
  }
}

export async function readRuleFunds(client: ChainClient, mandate: MandateAccount): Promise<RuleFunds> {
  const owner = new PublicKey(mandate.owner);
  const mint = new PublicKey(mandate.mint);
  const source = new PublicKey(mandate.source);
  const mintInfo = await client.connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) {
    throw new Error(`mint ${mint.toBase58()} was not found on chain`);
  }
  const tokenProgram = mintInfo.owner;
  const decimals = mintInfo.data.length >= 45 ? readMintDecimals(mintInfo.data) : null;
  const kind = await classifyRuleSource({
    owner,
    mandateId: mandate.mandateId,
    mint,
    tokenProgram,
    source,
  });
  const info = await client.connection.getAccountInfo(source, 'confirmed');
  const balance = info
    ? readConfirmedTokenAmount({
        data: info.data,
        accountProgram: info.owner,
        tokenProgram,
        mint,
        owner,
      })
    : null;
  let closeCreatesAssociated = false;
  if (kind === 'dedicated' && balance != null && balance > 0n) {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
    const ataInfo = await client.connection.getAccountInfo(ata, 'confirmed');
    closeCreatesAssociated = ataInfo == null;
  }
  let otherRule: string | null = null;
  if (
    kind !== 'dedicated' &&
    mandate.status !== STATUS_REVOKED &&
    info &&
    info.owner.equals(tokenProgram)
  ) {
    const delegate = readTokenDelegate(info.data);
    if (delegate && !delegate.equals(new PublicKey(mandate.address))) {
      otherRule = await delegatedRuleName(client, delegate);
    }
  }
  return {
    source: source.toBase58(),
    balance,
    kind,
    closeCreatesAssociated,
    decimals,
    tokenProgram: tokenProgram.toBase58(),
    otherRule,
  };
}

function blockhashOutlived(err: unknown): boolean {
  if (
    err instanceof TransactionExpiredBlockheightExceededError ||
    err instanceof TransactionExpiredTimeoutError
  ) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.name === 'TransactionExpiredBlockheightExceededError' ||
    err.name === 'TransactionExpiredTimeoutError' ||
    err.message.includes('block height exceeded') ||
    err.message.includes('was not confirmed in')
  );
}

// The blockhash is taken before the wallet round trip. A slow approval can pass
// lastValidBlockHeight after the signature has already landed, and the wallet
// may have signed with a newer blockhash of its own. Absence right then does
// not mean the signature can no longer land.
export const signatureWatch = {
  pollMs: 2_000,
  windowMs: 90_000,
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export async function confirmSignature(
  client: ChainClient,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const connection = client.connection;
  try {
    const result = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (result.value.err) {
      throw new Error(`transaction ${signature} landed with an error`);
    }
    return;
  } catch (err) {
    if (!blockhashOutlived(err)) {
      throw err;
    }
  }

  const cluster = client.config.explorerCluster;
  const started = signatureWatch.now();
  let seen = false;
  for (;;) {
    const status = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const row = status.value?.[0] ?? null;
    if (row?.err) {
      throw new Error(`transaction ${signature} landed with an error`);
    }
    const confirmation = row?.confirmationStatus;
    if (confirmation === 'confirmed' || confirmation === 'finalized') {
      return;
    }
    if (confirmation === 'processed') {
      seen = true;
    }
    if (signatureWatch.now() - started >= signatureWatch.windowMs) {
      throw new Error(
        seen ? signatureSeenUnconfirmedMessage(cluster) : signatureNotYetVisibleMessage(cluster),
      );
    }
    await signatureWatch.sleep(signatureWatch.pollMs);
  }
}

export async function openMandate(
  client: ChainClient,
  signAndSend: SignAndSend,
  input: OpenMandateInput,
): Promise<OpenMandateResult> {
  if (input.cap <= 0n) {
    throw new Error('cap must be greater than zero');
  }
  if (input.perTxMax <= 0n) {
    throw new Error('per-payment maximum must be greater than zero');
  }
  if (input.perTxMax > input.cap) {
    throw new Error('per-payment maximum cannot exceed the cap');
  }
  if (input.purpose.length > PURPOSE_MAX_LEN) {
    throw new Error('purpose is longer than the on-chain limit');
  }
  if (input.merchant.equals(PublicKey.default)) {
    throw new Error('a mandate must name the merchant it may pay');
  }
  if (input.agent.equals(input.owner)) {
    throw new Error('the agent key must not be the owner key');
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (input.expiresAt <= now) {
    throw new Error('expiry must be in the future');
  }

  const mint = input.mint ?? (client.config.mint ? new PublicKey(client.config.mint) : null);
  if (!mint) {
    throw new Error(
      'Mint is missing from config. Set EXPO_PUBLIC_VETO_MINT as documented in app/README.md.',
    );
  }

  const mintInfo = await client.connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) {
    throw new Error(`mint ${mint.toBase58()} was not found on chain`);
  }
  const tokenProgram = mintInfo.owner;
  const ata = getAssociatedTokenAddressSync(mint, input.owner, false, tokenProgram);
  const ataInfo = await client.connection.getAccountInfo(ata, 'confirmed');
  if (!ataInfo) {
    throw new Error(
      `The owner holds none of mint ${mint.toBase58()}. This app will not create a token account for it. The rule spends tokens the owner already holds.`,
    );
  }
  const tokenBalance = readTokenAmount(ataInfo.data);
  if (tokenBalance === null) {
    throw new Error(
      `The associated token account ${ata.toBase58()} could not be read, so nothing was submitted.`,
    );
  }

  const rent = await rentForOpen(client.connection);
  const tokenRent = await tokenAccountRent(client.connection);
  const fee = OPEN_FEE_MARGIN_LAMPORTS;
  const accountRent = rent.mandate + rent.ledger;
  const needed = accountRent + tokenRent + fee;
  const solBalance = await ownerLamports(client.connection, input.owner);
  let floor: number | null = null;
  if (solBalance > needed) {
    floor = await payerFloorLamports(client.connection);
  }
  const lamportsShort = solBalance < needed || (floor != null && solBalance - needed < floor);
  const decimals = mintInfo.data.length >= 45 ? readMintDecimals(mintInfo.data) : null;
  const tokenMessage =
    decimals == null
      ? null
      : openFundsRefusal({
          ata,
          ataFound: true,
          balance: tokenBalance,
          cap: input.cap,
          decimals,
          mint: mint.toBase58(),
        });
  if (lamportsShort || tokenMessage) {
    const solMessage = lamportsShort
      ? openSolRefusal({
          balance: solBalance,
          mandateRent: rent.mandate,
          ledgerRent: rent.ledger,
          tokenRent,
          fee,
          floor: solBalance > needed ? floor : null,
        })
      : null;
    throw new Error([tokenMessage, solMessage].filter((part) => part != null).join(' '));
  }
  if (decimals == null) {
    throw new Error('The mint account is too short to read decimals, so the transfer was not built.');
  }

  let mandateId = BigInt(Date.now());
  let ruleAccount = await deriveRuleTokenAccount(input.owner, mandateId, tokenProgram);
  let free = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const mandatePk = mandatePda(client.programId, input.owner, mandateId);
    const [mandateInfo, ruleInfo] = await Promise.all([
      client.connection.getAccountInfo(mandatePk, 'confirmed'),
      client.connection.getAccountInfo(ruleAccount, 'confirmed'),
    ]);
    if (!mandateInfo && !ruleInfo) {
      free = true;
      break;
    }
    mandateId += 1n;
    ruleAccount = await deriveRuleTokenAccount(input.owner, mandateId, tokenProgram);
  }
  if (!free) {
    throw new Error('No free mandate id was found for a new rule account.');
  }

  const built = openMandateInstruction({
    programId: client.programId,
    owner: input.owner,
    agent: input.agent,
    merchant: input.merchant,
    mint,
    source: ruleAccount,
    tokenProgram,
    mandateId,
    cap: input.cap,
    perTxMax: input.perTxMax,
    expiresAt: input.expiresAt,
    purpose: input.purpose,
  });
  const seed = ruleTokenSeed(mandateId);
  const createRuleAccount = SystemProgram.createAccountWithSeed({
    fromPubkey: input.owner,
    basePubkey: input.owner,
    seed,
    newAccountPubkey: ruleAccount,
    lamports: tokenRent,
    space: ACCOUNT_SIZE,
    programId: tokenProgram,
  });
  const initializeRuleAccount = createInitializeAccount3Instruction(
    ruleAccount,
    mint,
    input.owner,
    tokenProgram,
  );
  const fundRuleAccount = createTransferCheckedInstruction(
    ata,
    mint,
    ruleAccount,
    input.owner,
    input.cap,
    decimals,
    [],
    tokenProgram,
  );

  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = input.owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(createRuleAccount, initializeRuleAccount, fundRuleAccount, built.instruction);

  const [signature] = await signAndSend([tx]);
  if (!signature) {
    throw new Error('wallet returned no signature');
  }
  await confirmSignature(client, signature, latest.blockhash, latest.lastValidBlockHeight);

  const mandate = await fetchMandate(client, built.mandate);
  return { signature, mandate, ledger: built.ledger.toBase58() };
}

export async function revokeMandate(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  mandate: MandateAccount,
): Promise<RevokeResult> {
  const tokenProgram = await tokenProgramOfMint(client, new PublicKey(mandate.mint));
  const ix = revokeMandateInstruction({
    programId: client.programId,
    owner,
    mandate: new PublicKey(mandate.address),
    source: new PublicKey(mandate.source),
    tokenProgram,
  });
  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(ix);

  const [signature] = await signAndSend([tx]);
  if (!signature) {
    throw new Error('wallet returned no signature');
  }
  await confirmSignature(client, signature, latest.blockhash, latest.lastValidBlockHeight);
  const next = await fetchMandate(client, new PublicKey(mandate.address));
  return { signature, mandate: next };
}

export async function closeMandate(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  mandate: MandateAccount,
): Promise<CloseResult> {
  const live = await fetchMandate(client, new PublicKey(mandate.address));
  if (!owner.equals(new PublicKey(live.owner))) {
    throw new Error('Only the owner can close this rule.');
  }

  const mint = new PublicKey(live.mint);
  const source = new PublicKey(live.source);
  const mandateKey = new PublicKey(live.address);
  const mintInfo = await client.connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) {
    throw new Error(`mint ${mint.toBase58()} was not found on chain`);
  }
  const tokenProgram = mintInfo.owner;
  const kind = await classifyRuleSource({
    owner,
    mandateId: live.mandateId,
    mint,
    tokenProgram,
    source,
  });

  const instructions: TransactionInstruction[] = [];
  const sourceInfo = await client.connection.getAccountInfo(source, 'confirmed');
  if (live.status === STATUS_ACTIVE && !sourceInfo) {
    throw new Error(
      `The token account ${source.toBase58()} is not on chain, so this active rule cannot be revoked and closed.`,
    );
  }
  if (live.status !== STATUS_REVOKED && sourceInfo) {
    instructions.push(
      revokeMandateInstruction({
        programId: client.programId,
        owner,
        mandate: mandateKey,
        source,
        tokenProgram,
      }),
    );
  }

  if (kind === 'dedicated' && sourceInfo) {
    const amount = readTokenAmount(sourceInfo.data);
    if (amount === null) {
      throw new Error('The rule token account could not be read, so nothing was submitted.');
    }
    if (amount > 0n) {
      const decimals = readMintDecimals(mintInfo.data);
      const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
      const ataInfo = await client.connection.getAccountInfo(ata, 'confirmed');
      if (!ataInfo) {
        const ataRent = await quotedRent(client.connection, ACCOUNT_SIZE);
        const fee = OPEN_FEE_MARGIN_LAMPORTS;
        const solBalance = await ownerLamports(client.connection, owner);
        const needed = ataRent + fee;
        let floor: number | null = null;
        if (solBalance > needed) {
          floor = await payerFloorLamports(client.connection);
        }
        if (solBalance < needed || (floor != null && solBalance - needed < floor)) {
          throw new Error(
            closeSolRefusal({
              balance: solBalance,
              ataRent,
              fee,
              floor: solBalance > needed ? floor : null,
            }),
          );
        }
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, tokenProgram),
        );
      }
      instructions.push(
        createTransferCheckedInstruction(source, mint, ata, owner, amount, decimals, [], tokenProgram),
      );
    }
    instructions.push(createCloseAccountInstruction(source, owner, owner, [], tokenProgram));
  }

  instructions.push(
    closeMandateInstruction({
      programId: client.programId,
      owner,
      mandate: mandateKey,
    }),
  );

  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(...instructions);

  const [signature] = await signAndSend([tx]);
  if (!signature) {
    throw new Error('wallet returned no signature');
  }
  await confirmSignature(client, signature, latest.blockhash, latest.lastValidBlockHeight);
  return { signature };
}

function unixNowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export async function probeOverride(
  client: ChainClient,
  mandateAddress: PublicKey,
  row: LedgerRow,
  decimals: number,
  nowSec: bigint = unixNowSec(),
): Promise<OverrideAssessment> {
  const live = await fetchMandate(client, mandateAddress);
  return assessOverride({ row, mandate: live, decimals, nowSec });
}

export async function grantOverride(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  mandate: MandateAccount,
  row: LedgerRow,
  decimals: number,
): Promise<GrantOverrideResult> {
  const live = await fetchMandate(client, new PublicKey(mandate.address));
  const assessment = assessOverride({
    row,
    mandate: live,
    decimals,
    nowSec: unixNowSec(),
  });
  if (assessment.status !== 'ready') {
    throw new Error(assessment.why);
  }

  const tokenProgram = await tokenProgramOfMint(client, new PublicKey(live.mint));
  const ix = grantOverrideInstruction({
    programId: client.programId,
    owner,
    mandate: new PublicKey(live.address),
    source: new PublicKey(live.source),
    tokenProgram,
    amount: assessment.amount,
    nonce: assessment.nonce,
  });
  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(ix);

  const [signature] = await signAndSend([tx]);
  if (!signature) {
    throw new Error('wallet returned no signature');
  }
  await confirmSignature(client, signature, latest.blockhash, latest.lastValidBlockHeight);

  const next = await fetchMandate(client, new PublicKey(live.address));
  const ledger = await fetchLedgerRows(client, new PublicKey(live.address));
  const confirmed =
    ledger.rows.find((item) => item.kind === KIND_OVERRIDE && item.signature === signature) ??
    ledger.rows
      .filter(
        (item) =>
          item.kind === KIND_OVERRIDE &&
          item.nonce === assessment.nonce &&
          item.amount === assessment.amount,
      )
      .at(-1);
  if (!confirmed) {
    throw new Error(
      'The transaction confirmed, but the ledger does not yet show the one-time allowance. Pull to retry. This screen will not invent one.',
    );
  }
  return { signature, mandate: next, row: confirmed };
}

function instructionData(data: string | Uint8Array | number[] | Buffer): Uint8Array {
  if (typeof data === 'string') {
    try {
      return Buffer.from(data, 'base64');
    } catch {
      return new Uint8Array();
    }
  }
  return Uint8Array.from(data);
}

export function decisionsFromTx(
  signature: string,
  tx: VersionedTransactionResponse,
  programId: string,
): DecodedTxDecision[] {
  const logs = tx.meta?.logMessages ?? [];
  const fromEvents = decodeEventsFromLogs(signature, logs);
  if (fromEvents.length > 0) {
    return fromEvents;
  }

  const message = tx.transaction.message;
  const keys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const compiled =
    'compiledInstructions' in message
      ? message.compiledInstructions
      : (message as unknown as { instructions?: Array<{ programIdIndex: number; data: string }> })
          .instructions ?? [];

  const out: DecodedTxDecision[] = [];
  for (const ix of compiled) {
    const program = keys.get(ix.programIdIndex);
    if (!program || program.toBase58() !== programId) {
      continue;
    }
    const data =
      'data' in ix && ix.data !== undefined ? instructionData(ix.data as string | Uint8Array) : new Uint8Array();
    const decoded = decodeInstructionKind(signature, data);
    if (decoded && (decoded.kind === KIND_OPENED || decoded.kind === KIND_REVOKED || decoded.kind === KIND_OVERRIDE)) {
      out.push(decoded);
    }
  }
  return out;
}

export async function fetchAdvisoryDeclines(
  client: ChainClient,
  mandate: PublicKey,
  agent: PublicKey,
): Promise<LedgerRow[]> {
  let signatures: ConfirmedSignatureInfo[];
  try {
    signatures = await listSignatures(client, mandate, 4);
  } catch (err) {
    const detail = err instanceof Error ? redactRpc(err.message) : redactRpc(String(err));
    throw new Error(`Failed to list mandate signatures: ${detail}`);
  }
  return readAdvisoryDeclines({
    mandate,
    agent,
    signatures,
    loadTransaction: async (signature) => {
      try {
        return await client.connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
      } catch {
        return null;
      }
    },
  });
}

// Two at a time, then a longer wait, so a phone burst does not sit on HTTP 429.
export const ledgerBodyFetch = {
  concurrency: 2,
  retryMs: [400, 1200] as const,
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

// A confirmed signature's body does not change. A failed read is left out so
// the next pull can try that signature again.
const ledgerSignatureCache = new Map<string, Map<string, DecodedTxDecision[]>>();

function signaturesForLedger(ledger: string): Map<string, DecodedTxDecision[]> {
  let found = ledgerSignatureCache.get(ledger);
  if (!found) {
    found = new Map();
    ledgerSignatureCache.set(ledger, found);
  }
  return found;
}

function errorBlob(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const push = (value: unknown, depth: number) => {
    if (value == null || depth > 4 || seen.has(value)) {
      return;
    }
    if (typeof value === 'object') {
      seen.add(value);
    }
    if (value instanceof Error) {
      parts.push(value.name, value.message);
      const extra = value as Error & {
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
        cause?: unknown;
      };
      if (extra.code != null) {
        parts.push(String(extra.code));
      }
      if (extra.status != null) {
        parts.push(String(extra.status));
      }
      if (extra.statusCode != null) {
        parts.push(String(extra.statusCode));
      }
      push(extra.cause, depth + 1);
      return;
    }
    parts.push(String(value));
  };
  push(err, 0);
  return parts.join(' ').toLowerCase();
}

function isNetworkError(err: unknown): boolean {
  const blob = errorBlob(err);
  return (
    blob.includes('network') ||
    blob.includes('fetch failed') ||
    blob.includes('failed to fetch') ||
    blob.includes('econnreset') ||
    blob.includes('etimedout') ||
    blob.includes('econnrefused') ||
    blob.includes('enotfound') ||
    blob.includes('eai_again') ||
    blob.includes('socket hang up') ||
    blob.includes('timed out') ||
    blob.includes('timeout') ||
    blob.includes('offline') ||
    blob.includes('aborted')
  );
}

function retryableBodyError(err: unknown): boolean {
  return isRateLimitError(err) || isNetworkError(err);
}

async function readTransactionBody(
  client: ChainClient,
  signature: string,
): Promise<VersionedTransactionResponse | null> {
  const delays = ledgerBodyFetch.retryMs;
  let attempt = 0;
  for (;;) {
    try {
      return await client.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      const delay = delays[attempt];
      if (attempt >= delays.length || delay == null || !retryableBodyError(err)) {
        throw err;
      }
      attempt += 1;
      await ledgerBodyFetch.sleep(delay);
    }
  }
}

async function loadDecoded(
  client: ChainClient,
  info: ConfirmedSignatureInfo,
): Promise<DecodedTxDecision[] | null> {
  const tx = await readTransactionBody(client, info.signature);
  if (!tx) {
    return null;
  }
  const blockTime = info.blockTime ?? tx.blockTime ?? null;
  return decisionsFromTx(info.signature, tx, client.programId.toBase58()).map((decision) => ({
    ...decision,
    blockTime,
    slot: info.slot,
  }));
}

async function mapLimited(
  indexes: readonly number[],
  limit: number,
  run: (index: number) => Promise<void>,
): Promise<void> {
  if (indexes.length === 0) {
    return;
  }
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, indexes.length));
  const worker = async () => {
    for (;;) {
      const cursorIndex = cursor;
      cursor += 1;
      if (cursorIndex >= indexes.length) {
        return;
      }
      const index = indexes[cursorIndex];
      if (index == null) {
        return;
      }
      await run(index);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
}

export async function fetchLedgerRows(
  client: ChainClient,
  mandate: PublicKey,
  agent?: PublicKey,
): Promise<{ snapshot: LedgerSnapshot; rows: LedgerRow[] }> {
  const snapshot = await fetchLedger(client, mandate);
  const ledgerAddress = new PublicKey(snapshot.address);
  // Only a body that can match a ring entry is read. An untimed signature is always read.
  const oldest = oldestMatchableBlockTime(snapshot.entries);
  let signatures: ConfirmedSignatureInfo[];
  try {
    signatures = await listSignatures(client, ledgerAddress, 4, oldest);
  } catch (err) {
    const detail = err instanceof Error ? redactRpc(err.message) : redactRpc(String(err));
    throw new Error(`Failed to list ledger signatures: ${detail}`);
  }

  const ok = signatures.filter(
    (info) => !info.err && (info.blockTime == null || info.blockTime >= oldest),
  );
  const cache = signaturesForLedger(ledgerAddress.toBase58());
  const decodedByIndex: DecodedTxDecision[][] = ok.map(() => []);
  const missing: number[] = [];
  for (let i = 0; i < ok.length; i += 1) {
    const info = ok[i];
    const hit = info ? cache.get(info.signature) : undefined;
    if (hit) {
      decodedByIndex[i] = hit;
    } else {
      missing.push(i);
    }
  }

  let failures = 0;
  await mapLimited(missing, ledgerBodyFetch.concurrency, async (index) => {
    const info = ok[index];
    if (!info) {
      return;
    }
    try {
      const decisions = await loadDecoded(client, info);
      if (!decisions) {
        failures += 1;
        return;
      }
      cache.set(info.signature, decisions);
      decodedByIndex[index] = decisions;
    } catch {
      failures += 1;
    }
  });
  if (failures > 0) {
    const noun = failures === 1 ? 'body' : 'bodies';
    console.warn(
      `fetchLedgerRows: ${failures} transaction ${noun} could not be read for ledger ${ledgerAddress.toBase58()}`,
    );
  }

  const decoded = decodedByIndex.flat();
  const rows = attachSignatures(snapshot.entries, decoded);
  if (!agent) {
    return { snapshot, rows };
  }
  const advisory = await fetchAdvisoryDeclines(client, mandate, agent);
  return { snapshot, rows: mergeDecisionRows(rows, advisory) };
}

export async function listSignatures(
  client: ChainClient,
  address: PublicKey,
  maxPages = 4,
  oldestBlockTime?: number,
): Promise<ConfirmedSignatureInfo[]> {
  const out: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  const pages = Math.max(1, maxPages);
  for (let page = 0; page < pages; page++) {
    const batch = await client.connection.getSignaturesForAddress(
      address,
      { limit: 50, before },
      'confirmed',
    );
    if (batch.length === 0) {
      break;
    }
    out.push(...batch);
    if (batch.length < 50) {
      break;
    }
    if (
      oldestBlockTime != null &&
      batch.every((info) => info.blockTime != null && info.blockTime < oldestBlockTime)
    ) {
      // Pages come newest first, so every later page is older still.
      break;
    }
    const last = batch[batch.length - 1];
    if (!last) {
      break;
    }
    before = last.signature;
  }
  return out;
}

export async function fetchGenesisHash(client: ChainClient): Promise<string> {
  return client.connection.getGenesisHash();
}

/** Confirmed decisions on an account, used for a trade ledger as well as a payment ledger. */
export async function decisionsForAddress(
  client: ChainClient,
  address: PublicKey,
): Promise<DecodedTxDecision[]> {
  let signatures: ConfirmedSignatureInfo[];
  try {
    signatures = await listSignatures(client, address, 4);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list ledger signatures: ${detail}`);
  }
  const ok = signatures.filter((info) => !info.err);
  const cache = signaturesForLedger(address.toBase58());
  const decodedByIndex: DecodedTxDecision[][] = ok.map(() => []);
  const missing: number[] = [];
  for (let i = 0; i < ok.length; i += 1) {
    const info = ok[i];
    const hit = info ? cache.get(info.signature) : undefined;
    if (hit) {
      decodedByIndex[i] = hit;
    } else {
      missing.push(i);
    }
  }
  await mapLimited(missing, ledgerBodyFetch.concurrency, async (index) => {
    const info = ok[index];
    if (!info) {
      return;
    }
    try {
      const decisions = await loadDecoded(client, info);
      if (!decisions) {
        return;
      }
      cache.set(info.signature, decisions);
      decodedByIndex[index] = decisions;
    } catch {
      // A missing body leaves the row without a signature. The next read tries again.
    }
  });
  return decodedByIndex.flat();
}
