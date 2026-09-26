import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { LiveScreen } from '../../components/hold/LiveScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { holdSetupDone, rememberHoldChoice } from '../../lib/onboardingHold';
import { shortKey, waitLabel } from '../../lib/hold';
import { secureStore } from '../../lib/mwa';
import { useHoldSession } from '../../lib/holdSession';
import { useHoldDraft } from './_layout';

export default function HoldLive() {
  const router = useRouter();
  const draft = useHoldDraft();
  const session = useHoldSession();
  const owner = session.owner;
  const guardian = draft.mode === 'phone' ? draft.phoneKey ?? draft.guardianText : draft.guardianText;
  const safe = draft.safeText.trim();
  useEffect(() => {
    if (!draft.onboarding || !owner) return;
    void rememberHoldChoice(secureStore, owner.toBase58()).catch(() => undefined);
  }, [draft.onboarding, owner]);
  return (
    <Screen>
      <ConnectGate>
        <LiveScreen
          network={session.network}
          amountLabel={draft.amountText.trim() || '0'}
          tokenName={session.tokenName}
          dailyLabel={`${draft.dailyText} ${session.tokenName}`}
          waitLabel={waitLabel(draft.days)}
          guardianLabel={guardian ? shortKey(guardian) : 'not set'}
          safeLabel={safe || 'not set'}
          onBack={() => router.replace(holdSetupDone(draft.onboarding))}
          onDone={() => router.replace(holdSetupDone(draft.onboarding))}
        />
      </ConnectGate>
    </Screen>
  );
}
