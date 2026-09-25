import { useRouter } from 'expo-router';

import { RulesScreen } from '../../components/hold/RulesScreen';
import { ConnectGate } from '../../components/ConnectGate';
import { Screen } from '../../components/Screen';
import { shortKey, stepWhole } from '../../lib/hold';
import { useHoldSession } from '../../lib/holdSession';
import { useHoldDraft } from './_layout';

export default function HoldRules() {
  const router = useRouter();
  const draft = useHoldDraft();
  const session = useHoldSession();
  return (
    <Screen>
      <ConnectGate>
        <RulesScreen
          network={session.network}
          amountLabel={draft.amountText.trim() || '0'}
          tokenName={session.tokenName}
          walletLabel={session.owner ? shortKey(session.owner.toBase58()) : 'your wallet'}
          dailyLabel={`${draft.dailyText} ${session.tokenName}`}
          days={draft.days}
          onLower={() => draft.setDailyText(stepWhole(draft.dailyText, -1))}
          onRaise={() => draft.setDailyText(stepWhole(draft.dailyText, 1))}
          onDays={draft.setDays}
          onBack={() => router.back()}
          onNext={() => router.push('/hold/guardian')}
        />
      </ConnectGate>
    </Screen>
  );
}
