import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

import { onWalletActionSuccess } from './walletActionStatus';
import { isSolanaMobileWalletInstalled, SOLANA_MOBILE_WALLET_BASE_URI } from './installedPackage';
import { secureStore, transact } from './mwa';
import {
  configuredCluster,
  connect,
  createAgentKeypair,
  disconnect,
  explainWalletFailure,
  agentPublicKey as readAgentPublicKey,
  signWithAgent as signAgentTransaction,
  restore,
  signAndSendTransactions,
} from './wallet';

export type WalletState = {
  ready: boolean;
  busy: boolean;
  error: string | null;
  cluster: string | null;
  solanaMobileInstalled: boolean;
  ownerPublicKey: string | null;
  agentPublicKey: string | null;
  connect: (choice?: { chooser?: boolean }) => Promise<void>;
  disconnect: () => Promise<void>;
  signAndSend: (transactions: Transaction[]) => Promise<string[]>;
  getAgentPublicKey: () => Promise<PublicKey | null>;
  signWithAgent: (transaction: Transaction) => Promise<Transaction>;
  createAgentKeypair: () => Promise<Keypair>;
};

async function plainFailure(error: unknown): Promise<string> {
  try {
    return explainWalletFailure(error, await configuredCluster());
  } catch {
    return explainWalletFailure(error, 'devnet');
  }
}

function useWalletState(): WalletState {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cluster, setCluster] = useState<string | null>(null);
  const [solanaMobileInstalled, setSolanaMobileInstalled] = useState(false);
  const [ownerPublicKey, setOwnerPublicKey] = useState<string | null>(null);
  const [agentPublicKey, setAgentPublicKey] = useState<string | null>(null);

  useEffect(() => onWalletActionSuccess(() => setError(null)), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [snapshot, clusterName, mobileInstalled] = await Promise.all([
          restore(secureStore),
          configuredCluster(),
          isSolanaMobileWalletInstalled(),
        ]);
        if (cancelled) {
          return;
        }
        setAgentPublicKey(snapshot.agentPublicKey);
        setOwnerPublicKey(snapshot.session?.ownerPublicKey ?? null);
        setCluster(clusterName);
        setSolanaMobileInstalled(mobileInstalled);
      } catch (err) {
        if (!cancelled) {
          setError(await plainFailure(err));
        }
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onConnect = useCallback(async (choice?: { chooser?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const direct =
        choice?.chooser || !(await isSolanaMobileWalletInstalled())
          ? undefined
          : SOLANA_MOBILE_WALLET_BASE_URI;
      const next = await connect(transact, secureStore, Keypair.generate, {
        chooser: choice?.chooser,
        baseUri: direct,
      });
      setOwnerPublicKey(next.ownerPublicKey);
      setAgentPublicKey(next.agentPublicKey);
      setCluster(await configuredCluster());
    } catch (err) {
      setError(await plainFailure(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const onDisconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnect(transact, secureStore);
    } catch (err) {
      setError(await plainFailure(err));
    } finally {
      setOwnerPublicKey(null);
      setBusy(false);
    }
  }, []);

  const signAndSend = useCallback(async (transactions: Transaction[]) => {
    setBusy(true);
    setError(null);
    try {
      return await signAndSendTransactions(transact, secureStore, transactions);
    } catch (err) {
      const message = await plainFailure(err);
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }, []);

  const getAgentPublicKey = useCallback(() => readAgentPublicKey(secureStore), []);
  const signWithAgent = useCallback((transaction: Transaction) => signAgentTransaction(secureStore, transaction), []);

  const onCreateAgent = useCallback(async () => {
    const created = await createAgentKeypair(secureStore);
    setAgentPublicKey(created.publicKey.toBase58());
    return created;
  }, []);

  return useMemo(
    () => ({
      ready,
      busy,
      error,
      cluster,
      solanaMobileInstalled,
      ownerPublicKey,
      agentPublicKey,
      connect: onConnect,
      disconnect: onDisconnect,
      signAndSend,
      getAgentPublicKey,
      signWithAgent,
      createAgentKeypair: onCreateAgent,
    }),
    [
      ready,
      busy,
      error,
      cluster,
      solanaMobileInstalled,
      ownerPublicKey,
      agentPublicKey,
      onConnect,
      onDisconnect,
      signAndSend,
      getAgentPublicKey,
      signWithAgent,
      onCreateAgent,
    ],
  );
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const value = useWalletState();
  return createElement(WalletContext.Provider, { value }, children);
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error('useWallet must be used within WalletProvider');
  }
  return ctx;
}
