import { useLocalSearchParams, useRouter } from 'expo-router';
import { PublicKey } from '@solana/web3.js';

import { HeldScreen } from '../../components/hold/HeldScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { freezeHoldVault, stopHoldWithdrawal } from '../../lib/holdActions';
import {
  countdownFromChain,
  daysFromDelay,
  formatChainInstant,
  formatHoldAmount,
  heldGoneCopy,
  heldReasonChips,
  isDefaultKey,
  routeParam,
  shortKey,
  vaultShareText,
  waitLabel,
} from '../../lib/hold';
import { holdCreatedAt, holdWithdrawalOutlook } from '../../lib/holdRead';
import { useHoldBundle } from '../../lib/holdSession';

export default function HoldHeld() {
  const router = useRouter();
  const params = useLocalSearchParams<{ vault?: string; id?: string }>();
  const address = routeParam(params.vault);
  const idText = routeParam(params.id);
  const loaded = useHoldBundle(address);
  const bundle = loaded.bundle;
  const row =
    bundle?.account.pending.find((item) => (idText ? item.id.toString() === idText : true)) ??
    bundle?.account.pending[0] ??
    null;
  const decimals = bundle?.decimals ?? 0;
  const amountLabel = row ? formatHoldAmount(row.amount, decimals) : '0';
  const dailyLabel = `${bundle ? formatHoldAmount(bundle.account.dailyLimit, decimals) : '0'} ${loaded.tokenName}`;
  const days = bundle ? daysFromDelay(bundle.account.delaySecs) : null;
  const now = loaded.nowSec ?? 0n;
  const countdown = row ? countdownFromChain(now, row.unlockAt) : countdownFromChain(1n, 0n);
  const outlook =
    bundle && row && loaded.nowSec !== null
      ? holdWithdrawalOutlook(bundle.account, {
          amount: row.amount,
          destination: row.destination,
          balance: bundle.balance,
          now: loaded.nowSec,
        })
      : null;
  const reasons =
    outlook && outlook.outcome === 'held'
      ? heldReasonChips({
          reasons: outlook.reasons,
          amountLabel: `${amountLabel} ${loaded.tokenName}`,
          dailyLabel,
          shareLabel: vaultShareText(row?.amount ?? 0n, bundle?.balance ?? 0n),
        })
      : [];
  const created =
    bundle && row ? holdCreatedAt(bundle.account, row, bundle.ledger.entries) : null;
  const hasGuardian = bundle ? !isDefaultKey(bundle.account.guardian.toBase58()) : false;
  const toldLine = `${created ? `Held at ${formatChainInstant(created)}. ` : ''}This phone checks for held withdrawals and schedules the remaining reminders: at 1 hour, at 12 hours, every 12 hours, then 6 hours and 1 hour before it goes. Notifications need to be allowed.`;
  const empty = bundle && !row ? heldGoneCopy(bundle.ledger.entries, idText) : undefined;
  const status = loaded.status === 'ready' && !row ? 'empty' : loaded.status;

  async function withAuthority(run: (authority: PublicKey, owner: PublicKey, vaultId: bigint, id: bigint) => Promise<void>) {
    if (!loaded.client || !loaded.owner || !bundle || !row) {
      throw new Error('The vault is not ready to sign.');
    }
    await run(loaded.owner, bundle.account.owner, bundle.account.vaultId, row.id);
    await loaded.reload();
  }

  return (
    <Screen onRefresh={() => void loaded.reload()} refreshing={loaded.status === 'loading'}>
      <ConnectGate>
        <HeldScreen
          network={loaded.network}
          status={status}
          error={loaded.error}
          empty={empty}
          amountLabel={amountLabel}
          tokenName={loaded.tokenName}
          destinationLabel={row ? shortKey(row.destination.toBase58()) : ''}
          waitLabel={days ? waitLabel(days) : 'the chosen wait'}
          countdown={countdown}
          untilLabel={
            row
              ? `${formatChainInstant(row.unlockAt)}, unless stopped. Blockchain clock.`
              : 'Blockchain clock.'
          }
          reasons={reasons.length > 0 ? reasons : ['The vault is holding it']}
          toldLine={toldLine}
          guardianLine={hasGuardian ? "Your guardian's phone is told when it next checks, and it can stop this." : null}
          dailyLabel={dailyLabel}
          onClose={() => router.back()}
          onAlerts={() => router.push(`/hold/alerts?vault=${address}&id=${row?.id.toString() ?? ''}`)}
          onSkip={() => router.push(`/hold/skip?vault=${address}&id=${row?.id.toString() ?? ''}`)}
          signingDisabled={loaded.wallet.busy}
          onStop={() =>
            withAuthority(async (authority, owner, vaultId, id) => {
              if (!loaded.client) return;
              await stopHoldWithdrawal({
                client: loaded.client,
                signAndSend: loaded.wallet.signAndSend,
                authority,
                owner,
                vaultId,
                id,
              });
            })
          }
          onFreeze={async () => {
            await withAuthority(async (authority, owner, vaultId) => {
              if (!loaded.client) return;
              await freezeHoldVault({
                client: loaded.client,
                signAndSend: loaded.wallet.signAndSend,
                authority,
                owner,
                vaultId,
              });
            });
            router.replace(`/hold/frozen?vault=${address}`);
          }}
        />
      </ConnectGate>
    </Screen>
  );
}
