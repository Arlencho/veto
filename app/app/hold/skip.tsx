import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
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
import { signHoldPartialWithSession } from '../../lib/holdSign';
import { readHoldRequest, type PastedHoldRequest } from '../../lib/holdVerify';
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
  // The partial this phone produced. It carries only this phone's signature, so it is not checked as a pasted request.
  const [ownPartial, setOwnPartial] = useState<string | null>(null);
  const showingOwnPartial = ownPartial != null && payload.trim() === ownPartial.trim();
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

  const pasted = useMemo<PastedHoldRequest | null>(() => {
    if (payload.trim().length === 0 || showingOwnPartial) return null;
    if (!loaded.client || !loaded.owner || !bundle) {
      return { ok: false, reason: 'The vault is not ready to check this request. Nothing was signed.' };
    }
    return readHoldRequest(payload, {
      purpose,
      programId: loaded.client.programId,
      owner: bundle.account.owner,
      guardian: bundle.account.guardian,
      vaultId: bundle.account.vaultId,
      mint: bundle.account.mint,
      tokenProgram: bundle.tokenProgram,
      withdrawal: row ? { id: row.id, destination: row.destination } : null,
      connected: loaded.owner,
    });
  }, [payload, showingOwnPartial, loaded.client, loaded.owner, bundle, purpose, row]);

  const request = !pasted
    ? null
    : !pasted.ok
      ? { ok: false as const, reason: pasted.reason }
      : {
          ok: true as const,
          lines:
            pasted.facts.action === 'skip'
              ? [
                  'Action: skip the wait and pay now.',
                  `Vault: ${pasted.facts.vault.toBase58()}`,
                  `Withdrawal: #${pasted.facts.withdrawalId?.toString() ?? ''}, ${amountLabel} ${loaded.tokenName}`,
                  `Destination: ${pasted.facts.destination?.toBase58() ?? ''}`,
                ]
              : ['Action: unfreeze the vault.', `Vault: ${pasted.facts.vault.toBase58()}`],
        };

  async function onSign() {
    if (!loaded.client || !loaded.owner || !bundle) {
      throw new Error('The vault is not ready to sign.');
    }
    if (pasted) {
      // Sign only a request that is exactly the one this screen shows, already signed by the other key.
      if (!pasted.ok) throw new Error(pasted.reason);
      await loaded.wallet.signAndSend([pasted.tx]);
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
    setOwnPartial(partial);
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
          request={request}
          ownPartial={showingOwnPartial}
          onBack={() => router.back()}
          onCancel={() => router.back()}
          signLabel="Press and hold to sign with your key on this phone"
          signHint="Each signature uses Seed Vault. Veto never sees the key."
          signingDisabled={loaded.wallet.busy}
          onSign={onSign}
        />
      </ConnectGate>
    </Screen>
  );
}
