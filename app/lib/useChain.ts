import { ConfiguredTokenContext } from './configuredToken';
import { redactRpc } from './rpcPrivacy';
import { PublicKey } from '@solana/web3.js';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { agentKeyForOpen } from './agentAddress';
import { tryLoadConfig, type AppConfig } from './config';
import {
  closeMandate,
  createClient,
  fetchGenesisHash,
  fetchLedgerRows,
  fetchMintDecimals,
  fetchOwnerMandates,
  grantOverride,
  openMandate,
  pickMandate,
  probeOverride,
  revokeMandate,
  type ChainClient,
  type CloseResult,
  type GrantOverrideResult,
  type OpenMandateInput,
  type OpenMandateResult,
  type RevokeResult,
} from './chain';
import {
  closeTradeRule,
  fetchOwnerTradeRules,
  fetchTradeLedgerRows,
  grantTradeOverride,
  openTradeRule,
  probeTradeOverride,
  revokeTradeRule,
  type OpenTradeInput,
  type OpenTradeResult,
} from './tradeChain';
import { tradeRuleAsMandate, type TradeRuleAccount } from './tradeRule';
import type { OverrideAssessment } from './override';
import {
  mandateReadStatus,
  RATE_LIMIT_GAVE_UP,
  RATE_LIMIT_RETRY_MS,
  type MandateReadStatus,
} from './mandateRead';
import type { MandateAccount } from './mandate';
import type { LedgerRow, LedgerSnapshot } from './ring';
import { isRateLimitError } from './rpcError';
import { secureStore } from './mwa';
import { useWallet } from './useWallet';
import { signatureNotYetVisibleMessage, type WalletStore } from './wallet';

/** The rule on screen now. The widget and the decision scan read it. */
export const SELECTED_MANDATE_KEY = 'veto.mandate.selected';
/**
 * The rule the user picked, or the rule they just opened. Kept apart from the rule on screen so
 * an automatic default is never mistaken for a choice and a newer rule can take over.
 */
export const CHOSEN_MANDATE_KEY = 'veto.mandate.chosen';

export type ChainState = {
  ready: boolean;
  loading: boolean;
  error: string | null;
  rateLimited: boolean;
  checkedOwner: string | null;
  mandateStatus: MandateReadStatus;
  config: AppConfig | null;
  configError: string | null;
  mandate: MandateAccount | null;
  mandates: MandateAccount[];
  tradeRule: TradeRuleAccount | null;
  tradeRules: TradeRuleAccount[];
  snapshot: LedgerSnapshot | null;
  rows: LedgerRow[];
  decimals: number;
  nowMs: number;
  genesisHash: string | null;
  submitHeld: boolean;
  refresh: () => Promise<void>;
  selectMandate: (address: string) => Promise<void>;
  open: (input: Omit<OpenMandateInput, 'owner' | 'agent'> & { agent?: PublicKey }) => Promise<OpenMandateResult>;
  openTrade: (input: Omit<OpenTradeInput, 'owner' | 'agent' | 'cluster'> & { agent?: PublicKey }) => Promise<OpenTradeResult>;
  revoke: (address?: string) => Promise<RevokeResult>;
  close: (address?: string) => Promise<CloseResult>;
  probeOverride: (mandateAddress: string, row: LedgerRow) => Promise<OverrideAssessment>;
  grantOverride: (mandateAddress: string, row: LedgerRow) => Promise<GrantOverrideResult>;
};

async function loadChosen(store: WalletStore): Promise<string | null> {
  return store.getItem(CHOSEN_MANDATE_KEY);
}

async function saveChosen(store: WalletStore, address: string): Promise<void> {
  await store.setItem(CHOSEN_MANDATE_KEY, address);
}

async function saveSelected(store: WalletStore, address: string): Promise<void> {
  await store.setItem(SELECTED_MANDATE_KEY, address);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function useChainState(): ChainState {
  const wallet = useWallet();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [checkedOwner, setCheckedOwner] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [mandate, setMandate] = useState<MandateAccount | null>(null);
  const [mandates, setMandates] = useState<MandateAccount[]>([]);
  const [tradeRule, setTradeRule] = useState<TradeRuleAccount | null>(null);
  const [tradeRules, setTradeRules] = useState<TradeRuleAccount[]>([]);
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [decimals, setDecimals] = useState(6);
  const [nowMs, setNowMs] = useState(0);
  const [genesisHash, setGenesisHash] = useState<string | null>(null);
  const [submitHeld, setSubmitHeld] = useState(false);
  const submitHeldRef = useRef(false);
  const submitEpoch = useRef(0);

  const holdIfPending = useCallback((err: unknown) => {
    const message = err instanceof Error ? redactRpc(err.message) : '';
    if (
      !message.startsWith('The transaction has not appeared on ') &&
      !message.startsWith('The transaction was seen on ')
    ) {
      return;
    }
    submitEpoch.current += 1;
    submitHeldRef.current = true;
    setSubmitHeld(true);
  }, []);

  const refresh = useCallback(async () => {
    const epochAtStart = submitEpoch.current;
    const releaseIfCurrent = () => {
      if (submitEpoch.current !== epochAtStart) {
        return;
      }
      submitHeldRef.current = false;
      setSubmitHeld(false);
    };
    setNowMs(Date.now());
    const loaded = tryLoadConfig();
    if (!loaded.ok) {
      setConfig(null);
      setConfigError(loaded.error);
      setMandate(null);
      setMandates([]);
      setTradeRule(null);
      setTradeRules([]);
      setSnapshot(null);
      setRows([]);
      setError(null);
      setRateLimited(false);
      setCheckedOwner(null);
      setGenesisHash(null);
      setReady(true);
      return;
    }
    setConfig(loaded.config);
    setConfigError(null);

    if (!wallet.ownerPublicKey) {
      setMandate(null);
      setMandates([]);
      setTradeRule(null);
      setTradeRules([]);
      setSnapshot(null);
      setRows([]);
      setError(null);
      setRateLimited(false);
      setCheckedOwner(null);
      setReady(true);
      return;
    }

    const ownerKey = wallet.ownerPublicKey;
    setLoading(true);
    setError(null);
    setRateLimited(false);

    const run = async () => {
      const client = createClient(loaded.config);
      const owner = new PublicKey(ownerKey);
      const preferred = await loadChosen(secureStore);
      const found = await fetchOwnerMandates(client, owner);
      const trades = await fetchOwnerTradeRules(client, owner);
      setMandates(found);
      setTradeRules(trades);
      releaseIfCurrent();
      const showTrade = async (rule: TradeRuleAccount) => {
        await saveSelected(secureStore, rule.address);
        const ledger = await fetchTradeLedgerRows(client, rule);
        let mintDecimals = loaded.config.mintDecimals;
        try {
          mintDecimals = await fetchMintDecimals(client, new PublicKey(rule.inMint));
        } catch {
          // Keep the configured fallback rather than inventing an amount.
        }
        setMandate(null);
        setTradeRule(rule);
        setSnapshot(ledger.snapshot);
        setRows(ledger.rows);
        setDecimals(mintDecimals);
      };
      const tradeHit = preferred ? trades.find((rule) => rule.address === preferred) : null;
      if (tradeHit) {
        await showTrade(tradeHit);
      } else {
        const selected = pickMandate(found, preferred);
        if (!selected) {
          const fallback = trades[0];
          if (!fallback) {
            setMandate(null);
            setTradeRule(null);
            setSnapshot(null);
            setRows([]);
            return;
          }
          await showTrade(fallback);
        } else {
          setTradeRule(null);
          await saveSelected(secureStore, selected.address);
          const ledger = await fetchLedgerRows(
            client,
            new PublicKey(selected.address),
            new PublicKey(selected.agent),
          );
          let mintDecimals = loaded.config.mintDecimals;
          try {
            mintDecimals = await fetchMintDecimals(client, new PublicKey(selected.mint));
          } catch {
            // Keep the configured fallback rather than inventing an amount.
          }
          setMandate(selected);
          setSnapshot(ledger.snapshot);
          setRows(ledger.rows);
          setDecimals(mintDecimals);
        }
      }
      let genesis: string | null = null;
      try {
        genesis = await fetchGenesisHash(client);
      } catch (err) {
        if (isRateLimitError(err)) {
          throw err;
        }
      }
      if (genesis) {
        setGenesisHash(genesis);
      }
    };

    try {
      await run();
    } catch (err) {
      if (isRateLimitError(err)) {
        setRateLimited(true);
        let last: unknown = err;
        for (const delay of RATE_LIMIT_RETRY_MS) {
          await wait(delay);
          try {
            await run();
            setRateLimited(false);
            last = null;
            break;
          } catch (retryErr) {
            last = retryErr;
            if (!isRateLimitError(retryErr)) {
              break;
            }
          }
        }
        if (last) {
          if (isRateLimitError(last)) {
            setError(RATE_LIMIT_GAVE_UP);
            setRateLimited(false);
          } else {
            setError(last instanceof Error ? redactRpc(last.message) : 'Chain read failed');
            setRateLimited(false);
          }
        }
      } else {
        setError(err instanceof Error ? redactRpc(err.message) : 'Chain read failed');
      }
    } finally {
      setLoading(false);
      setReady(true);
      setCheckedOwner(ownerKey);
    }
  }, [wallet.ownerPublicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectMandate = useCallback(
    async (address: string) => {
      await saveChosen(secureStore, address);
      await refresh();
    },
    [refresh],
  );

  const open = useCallback(
    async (input: Omit<OpenMandateInput, 'owner' | 'agent'> & { agent?: PublicKey }) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      if (submitHeldRef.current) {
        throw new Error(signatureNotYetVisibleMessage(loaded.config.explorerCluster));
      }
      const agentKey = await agentKeyForOpen(input.agent, () => wallet.createAgentKeypair());
      const client: ChainClient = createClient(loaded.config);
      try {
        const result = await openMandate(client, wallet.signAndSend, {
          owner: new PublicKey(wallet.ownerPublicKey),
          agent: agentKey,
          merchant: input.merchant,
          cap: input.cap,
          perTxMax: input.perTxMax,
          expiresAt: input.expiresAt,
          purpose: input.purpose,
          mint: input.mint,
        });
        await saveChosen(secureStore, result.mandate.address);
        await refresh();
        return result;
      } catch (err) {
        holdIfPending(err);
        throw err;
      }
    },
    [holdIfPending, refresh, wallet],
  );

  const openTrade = useCallback(
    async (input: Omit<OpenTradeInput, 'owner' | 'agent' | 'cluster'> & { agent?: PublicKey }) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      if (submitHeldRef.current) {
        throw new Error(signatureNotYetVisibleMessage(loaded.config.explorerCluster));
      }
      const agentKey = await agentKeyForOpen(input.agent, () => wallet.createAgentKeypair());
      const client: ChainClient = createClient(loaded.config);
      try {
        const result = await openTradeRule(client, wallet.signAndSend, {
          owner: new PublicKey(wallet.ownerPublicKey),
          agent: agentKey,
          cluster: loaded.config.explorerCluster,
          poolId: input.poolId,
          cap: input.cap,
          perTradeMax: input.perTradeMax,
          dailyLimit: input.dailyLimit,
          floorPercent: input.floorPercent,
          expiresAt: input.expiresAt,
          purpose: input.purpose,
        });
        await saveSelected(secureStore, result.rule.address);
        await refresh();
        return result;
      } catch (err) {
        holdIfPending(err);
        throw err;
      }
    },
    [holdIfPending, refresh, wallet],
  );

  const revoke = useCallback(
    async (address?: string) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      const tradeTarget =
        (address ? tradeRules.find((row) => row.address === address) : null) ??
        (address ? null : tradeRule);
      if (tradeTarget) {
        if (submitHeldRef.current) {
          throw new Error(signatureNotYetVisibleMessage(loaded.config.explorerCluster));
        }
        const client = createClient(loaded.config);
        try {
          const result = await revokeTradeRule(
            client,
            wallet.signAndSend,
            new PublicKey(wallet.ownerPublicKey),
            tradeTarget,
          );
          await refresh();
          return { signature: result.signature, mandate: tradeRuleAsMandate(result.rule) };
        } catch (err) {
          holdIfPending(err);
          throw err;
        }
      }
      const target =
        (address ? mandates.find((row) => row.address === address) : null) ?? mandate;
      if (!target) {
        throw new Error('No mandate on chain to revoke');
      }
      if (submitHeldRef.current) {
        throw new Error(signatureNotYetVisibleMessage(loaded.config.explorerCluster));
      }
      const client = createClient(loaded.config);
      try {
        const result = await revokeMandate(
          client,
          wallet.signAndSend,
          new PublicKey(wallet.ownerPublicKey),
          target,
        );
        await refresh();
        return result;
      } catch (err) {
        holdIfPending(err);
        throw err;
      }
    },
    [holdIfPending, mandate, mandates, refresh, tradeRule, tradeRules, wallet],
  );

  const close = useCallback(
    async (address?: string) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      const tradeTarget =
        (address ? tradeRules.find((row) => row.address === address) : null) ??
        (address ? null : tradeRule);
      if (tradeTarget) {
        if (submitHeldRef.current) {
          throw new Error(signatureNotYetVisibleMessage(loaded.config.explorerCluster));
        }
        const client = createClient(loaded.config);
        try {
          const result = await closeTradeRule(
            client,
            wallet.signAndSend,
            new PublicKey(wallet.ownerPublicKey),
            tradeTarget,
          );
          await refresh();
          return result;
        } catch (err) {
          holdIfPending(err);
          throw err;
        }
      }
      const target =
        (address ? mandates.find((row) => row.address === address) : null) ?? mandate;
      if (!target) {
        throw new Error('No mandate on chain to close');
      }
      if (submitHeldRef.current) {
        throw new Error(signatureNotYetVisibleMessage(loaded.config.explorerCluster));
      }
      const client = createClient(loaded.config);
      try {
        const result = await closeMandate(
          client,
          wallet.signAndSend,
          new PublicKey(wallet.ownerPublicKey),
          target,
        );
        await refresh();
        return result;
      } catch (err) {
        holdIfPending(err);
        throw err;
      }
    },
    [holdIfPending, mandate, mandates, refresh, tradeRule, tradeRules, wallet],
  );

  const probeLiveOverride = useCallback(
    async (mandateAddress: string, row: LedgerRow) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      const client = createClient(loaded.config);
      const trade = tradeRules.find((item) => item.address === mandateAddress);
      if (trade) {
        return probeTradeOverride(client, new PublicKey(mandateAddress), row, decimals);
      }
      return probeOverride(client, new PublicKey(mandateAddress), row, decimals);
    },
    [decimals, tradeRules],
  );

  const grantLiveOverride = useCallback(
    async (mandateAddress: string, row: LedgerRow) => {
      const loaded = tryLoadConfig();
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      if (!wallet.ownerPublicKey) {
        throw new Error('Connect with Seed Vault first');
      }
      const tradeTarget =
        tradeRules.find((item) => item.address === mandateAddress) ??
        (tradeRule?.address === mandateAddress ? tradeRule : null);
      if (tradeTarget) {
        if (submitHeldRef.current) {
          throw new Error(signatureNotYetVisibleMessage(loaded.config.explorerCluster));
        }
        const client = createClient(loaded.config);
        try {
          const result = await grantTradeOverride(
            client,
            wallet.signAndSend,
            new PublicKey(wallet.ownerPublicKey),
            tradeTarget,
            row,
            decimals,
          );
          await refresh();
          return { signature: result.signature, mandate: tradeRuleAsMandate(result.rule), row: result.row };
        } catch (err) {
          holdIfPending(err);
          throw err;
        }
      }
      const target =
        mandates.find((item) => item.address === mandateAddress) ??
        (mandate?.address === mandateAddress ? mandate : null);
      if (!target) {
        throw new Error('This rule is not loaded for this owner. Pull to retry.');
      }
      if (submitHeldRef.current) {
        throw new Error(signatureNotYetVisibleMessage(loaded.config.explorerCluster));
      }
      const client = createClient(loaded.config);
      try {
        const result = await grantOverride(
          client,
          wallet.signAndSend,
          new PublicKey(wallet.ownerPublicKey),
          target,
          row,
          decimals,
        );
        await refresh();
        return result;
      } catch (err) {
        holdIfPending(err);
        throw err;
      }
    },
    [decimals, holdIfPending, mandate, mandates, refresh, tradeRule, tradeRules, wallet],
  );

  const mandateStatus = mandateReadStatus({
    checkedOwner,
    ownerPublicKey: wallet.ownerPublicKey,
    loading,
    error,
    hasMandate: mandate != null || tradeRule != null,
    rateLimited,
  });

  return useMemo(
    () => ({
      ready,
      loading,
      error,
      rateLimited,
      checkedOwner,
      mandateStatus,
      config,
      configError,
      mandate,
      mandates,
      tradeRule,
      tradeRules,
      snapshot,
      rows,
      decimals,
      nowMs,
      genesisHash,
      submitHeld,
      refresh,
      selectMandate,
      open,
      openTrade,
      revoke,
      close,
      probeOverride: probeLiveOverride,
      grantOverride: grantLiveOverride,
    }),
    [
      ready,
      loading,
      error,
      rateLimited,
      checkedOwner,
      mandateStatus,
      config,
      configError,
      mandate,
      mandates,
      tradeRule,
      tradeRules,
      snapshot,
      rows,
      decimals,
      nowMs,
      genesisHash,
      submitHeld,
      refresh,
      selectMandate,
      open,
      openTrade,
      revoke,
      close,
      probeLiveOverride,
      grantLiveOverride,
    ],
  );
}

const ChainContext = createContext<ChainState | null>(null);

export function ChainProvider({ children }: { children: ReactNode }) {
  const value = useChainState();
  return createElement(ChainContext.Provider, { value },
    createElement(ConfiguredTokenContext.Provider, { value: value.config?.mint ?? null }, children),
  );
}

export function useChain(): ChainState {
  const ctx = useContext(ChainContext);
  if (!ctx) {
    throw new Error('useChain must be used within ChainProvider');
  }
  return ctx;
}
