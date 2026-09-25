import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';

import { SkipScreen } from '../../components/hold/SkipScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { compileSkip, compileUnfreeze } from '../../lib/holdActions';
import {
  formatChainInstant,
  formatHoldAmount,
  isDefaultKey,
  routeParam,
  shortKey,
} from '../../lib/hold';
import { holdRequestFromPayload, signHoldPartialWithSession } from '../../lib/holdSign';
import { useHoldBundle } from '../../lib/holdSession';

export default function HoldSkip() {
  const router = useRouter();
  const params = useLocalSearchParams<{ vault?: string; id?: string; purpose?: string }>();
  const address = routeParam(params.vault);
  const idText = routeParam(params.id);
  const purpose = routeParam(params.purpose) === 'unfreeze' ? 'unfreeze' : 'skip';
  const loaded = useHoldBundle(address);
  const bundle = loaded.bundle;
  const row = bundle?.account.pending.find((item) => item.id.toString() === idText) ?? bundle?.account.pending[0] ?? null;
  const [payload, setPayload] = useState('');
  const [signedHere, setSignedHere] = useState(false);
  const [waitingLine, setWaitingLine] = useState('1 of 2 signed. Waiting for the other key.');
  const guardian = bundle?.account.guardian.toBase58() ?? '';
  const hasGuardian = guardian.length > 0 && !isDefaultKey(guardian);
  const decimals = bundle?.decimals ?? 0;
  const amountLabel = row ? formatHoldAmount(row.amount, decimals) : '';
  const destinationLabel = row ? shortKey(row.destination.toBase58()) : '';
  const status =
    loaded.status === 'ready' && purpose === 'skip' && !row
      ? 'empty'
      : loaded.status === 'ready' && purpose === 'unfreeze' && bundle && !bundle.account.frozen
        ? 'empty'
        : loaded.status;

  async function onSign() {
    if (!loaded.client || !loaded.owner || !bundle) {
      throw new Error('The vault is not ready to sign.');
    }
    if (payload.trim().length > 0) {
      const tx = holdRequestFromPayload(payload);
      await loaded.wallet.signAndSend([tx]);
      router.replace(purpose === 'unfreeze' ? `/hold/frozen?vault=${address}` : '/hold');
      return;
    }
    if (!hasGuardian && purpose === 'unfreeze') {
      const tx = await compileUnfreeze({
        client: loaded.client,
        owner: bundle.account.owner,
        guardian: null,
        vaultId: bundle.account.vaultId,
        feePayer: loaded.owner,
      });
      await loaded.wallet.signAndSend([tx]);
      router.replace(`/hold/frozen?vault=${address}`);
      return;
    }
    if (!hasGuardian) {
      throw new Error('No guardian key is set, so one key cannot skip the wait.');
    }
    if (purpose === 'skip' && !row) {
      throw new Error('That withdrawal is no longer waiting.');
    }
    const tx =
      purpose === 'unfreeze'
        ? await compileUnfreeze({
            client: loaded.client,
            owner: bundle.account.owner,
            guardian: bundle.account.guardian,
            vaultId: bundle.account.vaultId,
            feePayer: loaded.owner,
          })
        : await compileSkip({
            client: loaded.client,
            owner: bundle.account.owner,
            guardian: bundle.account.guardian,
            vaultId: bundle.account.vaultId,
            destination: row?.destination ?? bundle.account.safeAddress,
            mint: bundle.account.mint,
            id: row?.id ?? 0n,
            tokenProgram: bundle.tokenProgram,
            feePayer: loaded.owner,
          });
    const partial = await signHoldPartialWithSession(tx);
    setPayload(partial);
    setSignedHere(true);
    setWaitingLine('1 of 2 signed. Waiting for the other key.');
    try {
      await Clipboard.setStringAsync(partial);
    } catch {
      // The request stays on screen if the copy fails.
    }
  }

  const until = row ? formatChainInstant(row.unlockAt) : '';
  return (
    <Screen onRefresh={() => void loaded.reload()} refreshing={loaded.status === 'loading'}>
      <ConnectGate>
        <SkipScreen
          network={loaded.network}
          purpose={purpose}
          status={status}
          error={loaded.error}
          headline={
            purpose === 'skip'
              ? `To pay ${amountLabel} ${loaded.tokenName} to ${destinationLabel} before ${until}, both keys must sign. One key alone can never skip the wait.`
              : 'Unfreezing needs your key and the guardian key, signed separately. One key alone cannot open the vault.'
          }
          yourKey={loaded.owner ? `Key ${shortKey(loaded.owner.toBase58())}.` : 'This phone is not connected.'}
          guardianKey={hasGuardian ? `Key ${shortKey(guardian)}.` : 'No guardian key is set.'}
          signedHere={signedHere}
          waitingLine={waitingLine}
          whenBoth={
            purpose === 'skip'
              ? [
                  `${amountLabel} ${loaded.tokenName} goes to ${destinationLabel} at once.`,
                  'The record says released early by both keys. That address becomes known to this vault.',
                ]
              : ['The vault unfreezes at once.', 'The everyday door and the big door work again.']
          }
          payload={payload}
          onPayload={setPayload}
          onBack={() => router.back()}
          onCancel={() => router.back()}
          signLabel="Hold to sign with your key on this phone"
          signHint="Each signature uses Seed Vault. Veto never sees the key."
          signingDisabled={loaded.wallet.busy}
          onSign={onSign}
        />
      </ConnectGate>
    </Screen>
  );
}
