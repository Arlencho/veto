import { validateHoldAddresses } from '../../lib/holdSafeAddress';
import { redactRpc } from '../../lib/rpcPrivacy';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';

import { GuardianScreen } from '../../components/hold/GuardianScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { fetchMintDecimals, tokenProgramOfMint } from '../../lib/chain';
import {
  amountToBase,
  delaySecsForDays,
  secondSeedVaultAccount,
  wholeTokensToBase,
} from '../../lib/hold';
import { listHoldVaults, nextVaultId } from '../../lib/holdChain';
import { openHoldVault } from '../../lib/holdActions';
import { exposedWalletAccounts } from '../../lib/holdSign';
import { useHoldSession } from '../../lib/holdSession';
import { useHoldDraft } from './_layout';

export default function HoldGuardian() {
  const router = useRouter();
  const draft = useHoldDraft();
  const session = useHoldSession();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);
  const setPhoneKey = draft.setPhoneKey;

  useEffect(() => {
    if (!session.wallet.ready || !session.owner) return;
    const owner = session.owner.toBase58();
    let alive = true;
    void (async () => {
      try {
        const accounts = await exposedWalletAccounts();
        if (!alive) return;
        setPhoneKey(secondSeedVaultAccount(owner, accounts));
        setError(null);
        setStatus('ready');
      } catch (err) {
        if (!alive) return;
        setPhoneKey(null);
        setError(err instanceof Error ? redactRpc(err.message) : 'The wallet did not list its accounts.');
        setStatus('ready');
      }
    })();
    return () => {
      alive = false;
    };
  }, [setPhoneKey, session.owner, session.wallet.ready]);

  async function onSign() {
    if (!session.client || !session.config?.mint || !session.owner) {
      throw new Error(session.chain.configError ?? 'Connect a wallet before signing.');
    }
    const guardianText = draft.mode === 'phone' ? draft.phoneKey ?? '' : draft.guardianText.trim();
    const { guardian, safeAddress } = validateHoldAddresses(
      session.owner.toBase58(), guardianText, draft.safeText,
    );
    const mint = new PublicKey(session.config.mint);
    const tokenProgram = await tokenProgramOfMint(session.client, mint);
    const decimals = await fetchMintDecimals(session.client, mint);
    const amount = amountToBase(draft.amountText, decimals);
    const dailyLimit = wholeTokensToBase(draft.dailyText, decimals);
    const existing = await listHoldVaults(session.client, session.owner);
    const opened = await openHoldVault({
      client: session.client,
      signAndSend: session.wallet.signAndSend,
      owner: session.owner,
      vaultId: nextVaultId(existing, session.owner),
      guardian,
      safeAddress,
      dailyLimit,
      delaySecs: delaySecsForDays(draft.days),
      amount,
      mint,
      tokenProgram,
    });
    draft.setOpenedVault(opened.vault.toBase58());
    router.replace('/hold/live');
  }

  return (
    <Screen>
      <ConnectGate>
        <GuardianScreen
          network={session.network}
          status={status === 'loading' ? 'loading' : 'ready'}
          error={error}
          owner={session.owner?.toBase58() ?? ''}
          phoneKey={draft.phoneKey}
          days={draft.days}
          mode={draft.mode}
          guardianText={draft.mode === 'phone' ? draft.phoneKey ?? '' : draft.guardianText}
          safeText={draft.safeText}
          onMode={(mode) => {
            const address = mode === 'phone' ? draft.phoneKey ?? '' : draft.guardianText;
            draft.chooseGuardian(mode, address);
          }}
          onGuardian={(address) => draft.chooseGuardian('seeker', address)}
          onSafe={draft.setSafeText}
          onBack={() => router.back()}
          onSign={onSign}
          signingDisabled={session.wallet.busy}
        />
      </ConnectGate>
    </Screen>
  );
}
