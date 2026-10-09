import { ACCOUNT_SIZE, getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { PublicKey, Transaction } from '@solana/web3.js';

import {
  confirmSignature,
  decisionsForAddress,
  rentExemptLamports,
  type ChainClient,
  type SignAndSend,
} from './chain';
import {
  EXCHANGE_KIND_SPL_TOKEN_SWAP,
  KIND_OVERRIDE,
  OPEN_FEE_MARGIN_LAMPORTS,
  PURPOSE_MAX_LEN,
  STATUS_REVOKED,
  TRADE_LEDGER_ACCOUNT_SIZE,
  TRADE_RULE_ACCOUNT_SIZE,
} from './constants';
import { grantTradeOverrideInstruction, revokeTradeRuleInstruction } from './instructions';
import { assessOverride, type OverrideAssessment } from './override';
import { poolByAddress, poolById, SPL_TOKEN_SWAP_PROGRAM_ID, type KnownPool } from './pools';
import { readMintDecimals, readTokenAmount } from './ruleAccount';
import { attachSignatures, type LedgerRow, type LedgerSnapshot } from './ring';
import { floorFromSpot, parseSwapPool, poolSides } from './tradePool';
import {
  decodeTradeLedgerAccount,
  decodeTradeRuleAccount,
  deriveTradeTokenAccount,
  isTradeActive,
  tradeLedgerPda,
  tradeRuleAsMandate,
  tradeRulePda,
  withTradeOutput,
  type TradeRuleAccount,
} from './tradeRule';
import { buildCloseTradeInstructions, buildOpenTradeInstructions } from './tradeTx';

export type OpenTradeInput = {
  owner: PublicKey;
  agent: PublicKey;
  cluster: string;
  poolId: string;
  cap: bigint;
  perTradeMax: bigint;
  dailyLimit: bigint;
  floorPercent: number;
  expiresAt: bigint;
  purpose: string;
};

export type OpenTradeResult = {
  signature: string;
  rule: TradeRuleAccount;
  ledger: string;
};

async function quotedRent(client: ChainClient, space: number): Promise<number> {
  const connection = client.connection;
  if (typeof connection.getMinimumBalanceForRentExemption === 'function') {
    try {
      return await connection.getMinimumBalanceForRentExemption(space);
    } catch {
      return rentExemptLamports(space);
    }
  }
  return rentExemptLamports(space);
}

async function ownerLamports(client: ChainClient, owner: PublicKey): Promise<number> {
  if (typeof client.connection.getBalance === 'function') {
    return client.connection.getBalance(owner, 'confirmed');
  }
  const info = await client.connection.getAccountInfo(owner, 'confirmed');
  return info?.lamports ?? 0;
}

function outputDecimals(rule: TradeRuleAccount): number {
  return poolByAddress(rule.pool)?.outputDecimals ?? 0;
}

export async function fetchTradeRule(client: ChainClient, address: PublicKey): Promise<TradeRuleAccount> {
  const info = await client.connection.getAccountInfo(address, 'confirmed');
  if (!info) {
    throw new Error(`trade rule ${address.toBase58()} was not found on chain`);
  }
  return decodeTradeRuleAccount(address.toBase58(), info.data);
}

export async function fetchOwnerTradeRules(
  client: ChainClient,
  owner: PublicKey,
): Promise<TradeRuleAccount[]> {
  const accounts = await client.connection.getProgramAccounts(client.programId, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 8, bytes: owner.toBase58() } }],
  });
  const rules: TradeRuleAccount[] = [];
  for (const account of accounts) {
    try {
      rules.push(decodeTradeRuleAccount(account.pubkey.toBase58(), account.account.data));
    } catch {
      // Payment mandates and ledgers share this program.
    }
  }
  rules.sort((a, b) => (a.ruleId < b.ruleId ? 1 : a.ruleId > b.ruleId ? -1 : 0));
  return rules;
}

export async function fetchTradeLedgerRows(
  client: ChainClient,
  rule: TradeRuleAccount,
): Promise<{ snapshot: LedgerSnapshot; rows: LedgerRow[] }> {
  const ledgerKey = tradeLedgerPda(client.programId, new PublicKey(rule.address));
  const info = await client.connection.getAccountInfo(ledgerKey, 'confirmed');
  if (!info) {
    throw new Error(`trade ledger ${ledgerKey.toBase58()} was not found on chain`);
  }
  const decimals = outputDecimals(rule);
  const snapshot = decodeTradeLedgerAccount(ledgerKey.toBase58(), info.data, {
    outMint: rule.outMint,
    outDecimals: decimals,
  });
  const decisions = await decisionsForAddress(client, ledgerKey);
  const rows = withTradeOutput(attachSignatures(snapshot.entries, decisions), rule.outMint, decimals);
  return { snapshot, rows };
}

function requireKnownPool(input: OpenTradeInput): KnownPool {
  const pool = poolById(input.cluster, input.poolId);
  if (!pool) {
    throw new Error('Pick a pool from the list.');
  }
  return pool;
}

function sameKey(left: PublicKey, right: PublicKey, label: string): void {
  if (!left.equals(right)) {
    throw new Error(`This pool's ${label} does not match the pool this app knows.`);
  }
}

export async function openTradeRule(
  client: ChainClient,
  signAndSend: SignAndSend,
  input: OpenTradeInput,
): Promise<OpenTradeResult> {
  if (!Number.isInteger(input.floorPercent) || input.floorPercent < 1 || input.floorPercent > 99) {
    throw new Error('Floor percent must be a whole number from 1 to 99.');
  }
  if (input.cap <= 0n || input.perTradeMax <= 0n || input.dailyLimit <= 0n) {
    throw new Error('Most per trade, per day, and the total set aside must be above zero.');
  }
  if (input.perTradeMax > input.dailyLimit || input.dailyLimit > input.cap) {
    throw new Error('Most per trade, the daily limit, and the total are out of order.');
  }
  if (input.purpose.length === 0 || Array.from(input.purpose).length > PURPOSE_MAX_LEN) {
    throw new Error('Enter a purpose.');
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (input.expiresAt <= now) {
    throw new Error('Expiry must be in the future.');
  }
  const known = requireKnownPool(input);
  const agent = input.agent;
  if (agent.equals(input.owner)) {
    throw new Error('The agent address is the owner. Pick the agent address.');
  }

  const poolInfo = await client.connection.getAccountInfo(known.pool, 'confirmed');
  if (!poolInfo) {
    throw new Error('The pool account was not found on chain.');
  }
  if (!poolInfo.owner.equals(SPL_TOKEN_SWAP_PROGRAM_ID)) {
    throw new Error('The pool account is not owned by the token swap program.');
  }
  const parsed = poolSides(parseSwapPool(known.pool, poolInfo.data, poolInfo.owner), known.inputMint);
  if (!parsed.outputMint.equals(known.outputMint)) {
    throw new Error('This pool does not pay the output token this app knows.');
  }
  sameKey(parsed.authority, known.authority, 'authority');
  sameKey(parsed.inputVault, known.inputVault, 'input vault');
  sameKey(parsed.outputVault, known.outputVault, 'output vault');
  sameKey(parsed.poolMint, known.poolMint, 'pool mint');
  sameKey(parsed.feeAccount, known.feeAccount, 'fee account');

  const [inVaultInfo, outVaultInfo, mintInfo] = await Promise.all([
    client.connection.getAccountInfo(parsed.inputVault, 'confirmed'),
    client.connection.getAccountInfo(parsed.outputVault, 'confirmed'),
    client.connection.getAccountInfo(known.inputMint, 'confirmed'),
  ]);
  if (!inVaultInfo || !outVaultInfo) {
    throw new Error('A pool vault was not found on chain.');
  }
  if (!mintInfo) {
    throw new Error('The input mint was not found on chain.');
  }
  const inReserve = readTokenAmount(inVaultInfo.data);
  const outReserve = readTokenAmount(outVaultInfo.data);
  if (inReserve == null || outReserve == null) {
    throw new Error('A pool vault could not be read, so the floor was not set.');
  }
  const floor = floorFromSpot(outReserve, inReserve, input.floorPercent);
  const decimals = readMintDecimals(mintInfo.data);
  const tokenProgram = mintInfo.owner;
  const native = known.inputMint.equals(NATIVE_MINT);
  const ownerAta = getAssociatedTokenAddressSync(known.inputMint, input.owner, false, tokenProgram);
  const destination = getAssociatedTokenAddressSync(known.outputMint, input.owner, false, tokenProgram);
  const [ataInfo, destinationInfo] = await Promise.all([
    native ? Promise.resolve(null) : client.connection.getAccountInfo(ownerAta, 'confirmed'),
    client.connection.getAccountInfo(destination, 'confirmed'),
  ]);
  if (!native) {
    const balance = ataInfo ? readTokenAmount(ataInfo.data) : 0n;
    if (balance == null || balance < input.cap) {
      throw new Error('The owner account does not hold the total set aside for this rule.');
    }
  }

  const tokenRent = await quotedRent(client, ACCOUNT_SIZE);
  const ruleRent = await quotedRent(client, TRADE_RULE_ACCOUNT_SIZE);
  const ledgerRent = await quotedRent(client, TRADE_LEDGER_ACCOUNT_SIZE);
  const ataRent = destinationInfo ? 0 : await quotedRent(client, ACCOUNT_SIZE);
  const wrapped = native ? Number(input.cap) : 0;
  const needed = tokenRent + wrapped + ruleRent + ledgerRent + ataRent + OPEN_FEE_MARGIN_LAMPORTS;
  const solBalance = await ownerLamports(client, input.owner);
  const floorLamports = solBalance > needed ? await quotedRent(client, 0) : null;
  if (solBalance < needed || (floorLamports != null && solBalance - needed < floorLamports)) {
    throw new Error(
      `Opening this trade rule needs ${needed} lamports for rent, the fee, and the wrapped total. The wallet holds ${solBalance} lamports.`,
    );
  }

  let ruleId = BigInt(Date.now());
  let source = await deriveTradeTokenAccount(input.owner, ruleId, tokenProgram);
  let rule = tradeRulePda(client.programId, input.owner, ruleId);
  let free = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [ruleInfo, sourceInfo] = await Promise.all([
      client.connection.getAccountInfo(rule, 'confirmed'),
      client.connection.getAccountInfo(source, 'confirmed'),
    ]);
    if (!ruleInfo && !sourceInfo) {
      free = true;
      break;
    }
    ruleId += 1n;
    source = await deriveTradeTokenAccount(input.owner, ruleId, tokenProgram);
    rule = tradeRulePda(client.programId, input.owner, ruleId);
  }
  if (!free) {
    throw new Error('No free rule id was found for a new trade account.');
  }
  const ledger = tradeLedgerPda(client.programId, rule);
  const built = await buildOpenTradeInstructions({
    programId: client.programId,
    owner: input.owner,
    agent,
    rule,
    ledger,
    ruleId,
    poolAccount: known.pool,
    pool: parsed,
    exchangeProgram: SPL_TOKEN_SWAP_PROGRAM_ID,
    cap: input.cap,
    perTradeMax: input.perTradeMax,
    dailyLimit: input.dailyLimit,
    floorNum: floor.floorNum,
    floorDen: floor.floorDen,
    expiresAt: input.expiresAt,
    purpose: input.purpose,
    tokenRent,
    destinationExists: destinationInfo != null,
    decimals,
    ownerInputAta: ownerAta,
  });
  if (!built.source.equals(source) || !built.destination.equals(destination)) {
    throw new Error('The trade accounts did not match the owner accounts, so nothing was submitted.');
  }

  const latest = await client.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = input.owner;
  tx.recentBlockhash = latest.blockhash;
  tx.add(...built.instructions);
  const [signature] = await signAndSend([tx]);
  if (!signature) {
    throw new Error('wallet returned no signature');
  }
  await confirmSignature(client, signature, latest.blockhash, latest.lastValidBlockHeight);
  const opened = await fetchTradeRule(client, rule);
  if (opened.exchangeKind !== EXCHANGE_KIND_SPL_TOKEN_SWAP) {
    throw new Error('The opened rule is not the token swap this app asked for.');
  }
  return { signature, rule: opened, ledger: ledger.toBase58() };
}

async function submit(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  instructions: Transaction['instructions'],
): Promise<string> {
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
  return signature;
}

export async function revokeTradeRule(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  rule: TradeRuleAccount,
): Promise<{ signature: string; rule: TradeRuleAccount }> {
  const live = await fetchTradeRule(client, new PublicKey(rule.address));
  if (live.status === STATUS_REVOKED) {
    throw new Error('This trade rule is already stopped.');
  }
  const mintInfo = await client.connection.getAccountInfo(new PublicKey(live.inMint), 'confirmed');
  if (!mintInfo) {
    throw new Error('The input mint was not found on chain.');
  }
  const signature = await submit(client, signAndSend, owner, [
    revokeTradeRuleInstruction({
      programId: client.programId,
      owner,
      rule: new PublicKey(live.address),
      source: new PublicKey(live.source),
      tokenProgram: mintInfo.owner,
    }),
  ]);
  return { signature, rule: await fetchTradeRule(client, new PublicKey(live.address)) };
}

export async function closeTradeRule(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  rule: TradeRuleAccount,
): Promise<{ signature: string }> {
  const live = await fetchTradeRule(client, new PublicKey(rule.address));
  if (!owner.equals(new PublicKey(live.owner))) {
    throw new Error('Only the owner can close this rule.');
  }
  const mint = new PublicKey(live.inMint);
  const source = new PublicKey(live.source);
  const mintInfo = await client.connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) {
    throw new Error('The input mint was not found on chain.');
  }
  const tokenProgram = mintInfo.owner;
  const sourceInfo = await client.connection.getAccountInfo(source, 'confirmed');
  if (isTradeActive(live, BigInt(Math.floor(Date.now() / 1000))) && !sourceInfo) {
    throw new Error('The input account is not on chain, so this active rule cannot be closed.');
  }
  const amount = sourceInfo ? readTokenAmount(sourceInfo.data) : 0n;
  if (sourceInfo && amount == null) {
    throw new Error('The input account could not be read, so nothing was submitted.');
  }
  const decimals = readMintDecimals(mintInfo.data);
  const native = mint.equals(NATIVE_MINT);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const ataInfo = native ? null : await client.connection.getAccountInfo(ata, 'confirmed');
  const instructions = buildCloseTradeInstructions({
    programId: client.programId,
    owner,
    rule: new PublicKey(live.address),
    source,
    inputMint: mint,
    tokenProgram,
    status: live.status,
    amount: amount ?? 0n,
    decimals,
    sourceExists: sourceInfo != null,
    ownerAtaExists: ataInfo != null,
  });
  const signature = await submit(client, signAndSend, owner, instructions);
  return { signature };
}

export async function probeTradeOverride(
  client: ChainClient,
  ruleAddress: PublicKey,
  row: LedgerRow,
  decimals: number,
  nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<OverrideAssessment> {
  const live = await fetchTradeRule(client, ruleAddress);
  return assessOverride({ row, mandate: tradeRuleAsMandate(live), decimals, nowSec });
}

export async function grantTradeOverride(
  client: ChainClient,
  signAndSend: SignAndSend,
  owner: PublicKey,
  rule: TradeRuleAccount,
  row: LedgerRow,
  decimals: number,
): Promise<{ signature: string; rule: TradeRuleAccount; row: LedgerRow }> {
  const live = await fetchTradeRule(client, new PublicKey(rule.address));
  const assessment = assessOverride({
    row,
    mandate: tradeRuleAsMandate(live),
    decimals,
    nowSec: BigInt(Math.floor(Date.now() / 1000)),
  });
  if (assessment.status !== 'ready') {
    throw new Error(assessment.why);
  }
  const signature = await submit(client, signAndSend, owner, [
    grantTradeOverrideInstruction({
      programId: client.programId,
      owner,
      rule: new PublicKey(live.address),
      amount: assessment.amount,
      nonce: assessment.nonce,
    }),
  ]);
  const next = await fetchTradeRule(client, new PublicKey(live.address));
  const ledger = await fetchTradeLedgerRows(client, next);
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
  return { signature, rule: next, row: confirmed };
}
