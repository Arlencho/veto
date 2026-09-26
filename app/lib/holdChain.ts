import { Buffer } from 'buffer';
import { HOLD_VAULT_DISC } from './holdIdl';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';

import {
  createClient,
  fetchMintDecimals,
  ledgerBodyFetch,
  tokenProgramOfMint,
  type ChainClient,
} from './chain';
import type { AppConfig } from './config';
import { isRateLimitError } from './rpcError';
import {
  decodeHoldLedger,
  decodeHoldVault,
  HOLD_GUARDIAN_OFFSET,
  HOLD_OWNER_OFFSET,
  holdLedgerPda,
  readU64,
  type HoldAccount,
  type HoldLedger,
} from './holdRead';

export type HoldVaultBundle = {
  account: HoldAccount;
  ledger: HoldLedger;
  balance: bigint;
  decimals: number;
  tokenProgram: PublicKey;
};

export function holdClient(config: AppConfig): ChainClient {
  return createClient(config);
}

export async function readChainClock(connection: Connection): Promise<bigint> {
  const slot = await connection.getSlot('confirmed');
  const time = await connection.getBlockTime(slot);
  if (time === null) {
    throw new Error('The blockchain clock has no time for the latest slot yet.');
  }
  return BigInt(time);
}

export async function readTokenAmount(connection: Connection, account: PublicKey): Promise<bigint | null> {
  const info = await connection.getAccountInfo(account, 'confirmed');
  if (!info) return null;
  if (info.data.length < 72) {
    throw new Error('That token account is too short to read.');
  }
  return readU64(Buffer.from(info.data), 64);
}

/** Vaults this wallet owns. Vaults it only guards come from listGuardedVaults. */
export async function listHoldVaults(client: ChainClient, wallet: PublicKey): Promise<HoldAccount[]> {
  return sortByVaultId(await accountsFor(client, HOLD_OWNER_OFFSET, wallet));
}

/** Vaults that name this wallet as the guardian key, found by the guardian field. */
export async function listGuardedVaults(client: ChainClient, wallet: PublicKey): Promise<HoldAccount[]> {
  if (wallet.equals(PublicKey.default)) return [];
  return sortByVaultId(await accountsFor(client, HOLD_GUARDIAN_OFFSET, wallet));
}

/** Reads known vault addresses in one call. Missing or unreadable accounts are left out. */
export async function readHoldVaults(client: ChainClient, addresses: readonly PublicKey[]): Promise<HoldAccount[]> {
  if (addresses.length === 0) return [];
  const infos = await withRateLimitRetry(() =>
    client.connection.getMultipleAccountsInfo([...addresses], 'confirmed'),
  );
  const found: HoldAccount[] = [];
  infos.forEach((info, index) => {
    const address = addresses[index];
    if (!info || !address) return;
    try {
      found.push(decodeHoldVault(Buffer.from(info.data), address, true));
    } catch {
      // Closed or reused account. Leave it out.
    }
  });
  return sortByVaultId(found);
}

function sortByVaultId(rows: HoldAccount[]): HoldAccount[] {
  return rows.sort((a, b) => (a.vaultId < b.vaultId ? -1 : a.vaultId > b.vaultId ? 1 : 0));
}

async function withRateLimitRetry<T>(run: () => Promise<T>): Promise<T> {
  const delays = ledgerBodyFetch.retryMs;
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      const delay = delays[attempt];
      if (delay == null || !isRateLimitError(err)) throw err;
      attempt += 1;
      await ledgerBodyFetch.sleep(delay);
    }
  }
}

async function accountsFor(client: ChainClient, offset: number, wallet: PublicKey): Promise<HoldAccount[]> {
  const rows = await withRateLimitRetry(() =>
    client.connection.getProgramAccounts(client.programId, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 0, bytes: HOLD_VAULT_DISC.toString('base64'), encoding: 'base64' } }, { memcmp: { offset, bytes: wallet.toBase58() } }],
    }),
  );
  return rows.map((row) => decodeHoldVault(Buffer.from(row.account.data), row.pubkey, true));
}

export async function readHoldVault(client: ChainClient, address: PublicKey): Promise<HoldVaultBundle> {
  const info = await client.connection.getAccountInfo(address, 'confirmed');
  if (!info) {
    throw new Error('That vault is not on the blockchain.');
  }
  const account = decodeHoldVault(Buffer.from(info.data), address, true);
  const ledgerAddress = holdLedgerPda(client.programId, account.address);
  const ledgerInfo = await client.connection.getAccountInfo(ledgerAddress, 'confirmed');
  if (!ledgerInfo) {
    throw new Error('The vault record is not on the blockchain.');
  }
  const ledger = decodeHoldLedger(Buffer.from(ledgerInfo.data), ledgerAddress);
  const balance = (await readTokenAmount(client.connection, account.vaultToken)) ?? 0n;
  const tokenProgram = await tokenProgramOfMint(client, account.mint);
  const decimals = await fetchMintDecimals(client, account.mint);
  return { account, ledger, balance, decimals, tokenProgram };
}

export async function compileHoldTransaction(
  connection: Connection,
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
): Promise<Transaction> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
  tx.add(...instructions);
  return tx;
}

export type ResolvedDestination = {
  tokenAccount: PublicKey;
  owner: PublicKey;
  create: boolean;
};

export async function resolveHoldDestination(
  connection: Connection,
  mint: PublicKey,
  tokenProgram: PublicKey,
  text: string,
): Promise<ResolvedDestination> {
  let key: PublicKey;
  try {
    key = new PublicKey(text.trim());
  } catch {
    throw new Error('That address could not be read.');
  }
  const info = await connection.getAccountInfo(key, 'confirmed');
  if (info && info.owner.equals(tokenProgram) && info.data.length >= 64) {
    const data = Buffer.from(info.data);
    const accountMint = new PublicKey(data.subarray(0, 32));
    if (!accountMint.equals(mint)) {
      throw new Error('That token account is for a different token.');
    }
    return {
      tokenAccount: key,
      owner: new PublicKey(data.subarray(32, 64)),
      create: false,
    };
  }
  let ata: PublicKey;
  try {
    ata = getAssociatedTokenAddressSync(mint, key, false, tokenProgram);
  } catch {
    throw new Error('That address cannot hold this token.');
  }
  const ataInfo = await connection.getAccountInfo(ata, 'confirmed');
  return { tokenAccount: ata, owner: key, create: ataInfo === null };
}

export function createTokenAccountIx(args: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenAccount: PublicKey;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    args.payer,
    args.tokenAccount,
    args.owner,
    args.mint,
    args.tokenProgram,
  );
}

export function ownerTokenAccount(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
}

export function nextVaultId(vaults: readonly HoldAccount[], owner: PublicKey): bigint {
  let max = 0n;
  for (const vault of vaults) {
    if (vault.owner.equals(owner) && vault.vaultId > max) max = vault.vaultId;
  }
  return max + 1n;
}
