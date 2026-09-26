import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';

import { SendScreen } from '../../components/hold/SendScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { sendHoldWithdrawal } from '../../lib/holdActions';
import { resolveHoldDestination, readHoldVault } from '../../lib/holdChain';
import {
  amountToBase,
  daysFromDelay,
  formatHoldAmount,
  heldReasonChips,
  routeParam,
  sendPreview,
  shortKey,
  vaultShareText,
  type HoldOutlook,
} from '../../lib/hold';
import { holdWithdrawalOutlook } from '../../lib/holdRead';
import { useHoldBundle } from '../../lib/holdSession';

export default function HoldSend() {
  const router = useRouter();
  const params = useLocalSearchParams<{ vault?: string }>();
  const address = routeParam(params.vault);
  const loaded = useHoldBundle(address);
  const [amountText, setAmountText] = useState('');
  const [destinationText, setDestinationText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    outlook: HoldOutlook;
    headline: string;
    lines: string[];
    signLabel: string;
  } | null>(null);
  const bundle = loaded.bundle;
  const decimals = bundle?.decimals ?? 0;

  useEffect(() => {
    const bundleNow = bundle;
    const client = loaded.client;
    const nowSec = loaded.nowSec;
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      if (!bundleNow || !client || nowSec === null) {
        setPreview(null);
        return;
      }
      try {
        const amount = amountToBase(amountText, decimals);
        const resolved = await resolveHoldDestination(
          client.connection,
          bundleNow.account.mint,
          bundleNow.tokenProgram,
          destinationText,
        );
        const outlook = holdWithdrawalOutlook(bundleNow.account, {
          amount,
          destination: resolved.tokenAccount,
          balance: bundleNow.balance,
          now: nowSec,
        });
        const described = sendPreview({
          outlook,
          chips:
            outlook.outcome === 'held'
              ? heldReasonChips({
                  reasons: outlook.reasons,
                  amountLabel: `${formatHoldAmount(amount, decimals)} ${loaded.tokenName}`,
                  dailyLabel: `${formatHoldAmount(bundleNow.account.dailyLimit, decimals)} ${loaded.tokenName}`,
                  shareLabel: vaultShareText(amount, bundleNow.balance),
                })
              : [],
          days: daysFromDelay(bundleNow.account.delaySecs),
          destinationLabel: shortKey(resolved.owner.toBase58()),
          createsAccount: resolved.create,
        });
        if (!alive) return;
        setPreview({
          outlook,
          ...described,
          signLabel: outlook.outcome === 'held' ? 'Press and hold to sign. This will be held.' : 'Press and hold to sign and send',
        });
      } catch {
        if (alive) setPreview(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [amountText, bundle, decimals, destinationText, loaded.client, loaded.nowSec, loaded.tokenName]);

  return (
    <Screen onRefresh={() => void loaded.reload()} refreshing={loaded.status === 'loading'}>
      <ConnectGate>
        <SendScreen
          network={loaded.network}
          status={loaded.status}
          error={formError ?? loaded.error}
          amountText={amountText}
          destinationText={destinationText}
          headline={preview?.headline ?? null}
          lines={preview?.lines ?? []}
          onAmount={(text) => {
            setFormError(null);
            setAmountText(text);
          }}
          onDestination={(text) => {
            setFormError(null);
            setDestinationText(text);
          }}
          onBack={() => router.back()}
          tokenName={loaded.tokenName}
          signLabel={preview?.signLabel ?? 'Press and hold to sign and send'}
          signingDisabled={loaded.wallet.busy || !preview || preview.outlook.outcome === 'refused'}
          onSign={async () => {
            if (!loaded.client || !loaded.owner || !bundle || !preview) {
              throw new Error('The vault is not ready to sign.');
            }
            if (!loaded.owner.equals(bundle.account.owner)) {
              throw new Error('Only your key can ask the vault to send. The guardian key cannot start a withdrawal.');
            }
            const before = new Set(bundle.account.pending.map((row) => row.id.toString()));
            await sendHoldWithdrawal({
              client: loaded.client,
              signAndSend: loaded.wallet.signAndSend,
              owner: loaded.owner,
              vaultId: bundle.account.vaultId,
              amount: amountToBase(amountText, decimals),
              destinationText,
              mint: bundle.account.mint,
              tokenProgram: bundle.tokenProgram,
            });
            const fresh = await readHoldVault(loaded.client, new PublicKey(address));
            const added = fresh.account.pending.find((row) => !before.has(row.id.toString()));
            if (added) {
              router.replace(`/hold/held?vault=${address}&id=${added.id.toString()}`);
              return;
            }
            if (preview.outlook.outcome === 'at_once') {
              router.replace('/hold');
              return;
            }
            router.replace(`/hold/held?vault=${address}`);
          }}
        />
      </ConnectGate>
    </Screen>
  );
}
