import { Buffer } from 'buffer';
import { Transaction } from '@solana/web3.js';

import { secureStore, transact } from './mwa';
import {
  associationBaseUri,
  authorize,
  authorizeAccounts,
  configuredCluster,
  explainWalletFailure,
  loadSession,
  persistSession,
  type MwaWallet,
  type TransactFn,
  type WalletStore,
} from './wallet';

type SigningWallet = MwaWallet & {
  signTransactions?: (params: { transactions: Transaction[] }) => Promise<unknown>;
};

export function holdRequestPayload(transaction: Transaction): string {
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

export function holdRequestFromPayload(payload: string): Transaction {
  try {
    return Transaction.from(Buffer.from(payload.trim(), 'base64'));
  } catch {
    throw new Error('That request could not be read. Paste the whole request from the other phone.');
  }
}

function asTransaction(value: unknown, fallback: Transaction): Transaction {
  if (value instanceof Transaction) return value;
  if (typeof value === 'string') return Transaction.from(Buffer.from(value, 'base64'));
  if (value instanceof Uint8Array) return Transaction.from(Buffer.from(value));
  if (fallback) return fallback;
  throw new Error('The wallet returned a signature this app could not read.');
}

/**
 * One signature, without sending. Used when the other key is on another phone.
 * The session is the same Mobile Wallet Adapter authorize path as a send.
 */
export async function signHoldPartial(
  transactFn: TransactFn,
  store: WalletStore,
  transaction: Transaction,
): Promise<string> {
  const stored = await loadSession(store);
  const baseUri = associationBaseUri({ storedBaseUri: stored?.walletUriBase });
  try {
    return await transactFn(async (wallet) => {
      const session = await authorize(wallet, stored?.authToken, store);
      await persistSession(store, session);
      const signTransactions = (wallet as SigningWallet).signTransactions;
      if (!signTransactions) {
        throw new Error(
          'This wallet sends a signature only together with the transaction. Both keys have to be on this phone, or the other phone has to start from a wallet that can sign without sending.',
        );
      }
      const signed = await signTransactions({ transactions: [transaction] });
      const first = Array.isArray(signed) ? signed[0] : null;
      const tx = asTransaction(first, transaction);
      return holdRequestPayload(tx);
    }, baseUri ? { baseUri } : undefined);
  } catch (err) {
    throw new Error(explainWalletFailure(err, await configuredCluster()));
  }
}

export async function signHoldPartialWithSession(transaction: Transaction): Promise<string> {
  return signHoldPartial(transact, secureStore, transaction);
}

export async function exposedWalletAccounts(): Promise<string[]> {
  const { publicKeyFromAccount } = await import('./wallet');
  const stored = await loadSession(secureStore);
  const baseUri = associationBaseUri({ storedBaseUri: stored?.walletUriBase });
  try {
    return await transact(async (wallet) => {
      const result = await authorizeAccounts(wallet, stored?.authToken, secureStore);
      return result.accounts.map((account) => publicKeyFromAccount(account).toBase58());
    }, baseUri ? { baseUri } : undefined);
  } catch (err) {
    throw new Error(explainWalletFailure(err, await configuredCluster()));
  }
}
