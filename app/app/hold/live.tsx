import { useRouter } from 'expo-router';

import { LiveScreen } from '../../components/hold/LiveScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { holdSetupDone } from '../../lib/onboardingHold';
import { shortKey, waitLabel } from '../../lib/hold';
import { useHoldSession } from '../../lib/holdSession';
import { useHoldDraft } from './_layout';

export default function HoldLive() {
  const router = useRouter();
  const draft = useHoldDraft();
  const session = useHoldSession();
  const guardian = draft.mode === 'phone' ? draft.phoneKey ?? draft.guardianText : draft.guardianText;
  const safe = draft.safeText || guardian;
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
          safeLabel={safe ? shortKey(safe) : 'not set'}
          onBack={() => router.replace(holdSetupDone(draft.onboarding))}
          onDone={() => router.replace(holdSetupDone(draft.onboarding))}
        />
      </ConnectGate>
    </Screen>
  );
}
