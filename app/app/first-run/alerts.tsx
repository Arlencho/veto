import { useRouter } from 'expo-router';
import { useState } from 'react';

import { AlertsScreen } from '../../components/firstrun/AlertsScreen';
import { Screen } from '../../components/Screen';
import {
  explainOnceThenAsk,
  NOTIFICATION_CADENCE_LINE,
  NOTIFICATIONS_OFF_LINE,
} from '../../lib/notificationAsk';
import { askAfterFirstRuleOpened, hasAskedForDecisionNotifications } from '../../lib/decisionNotifyTask';
import { useWallet } from '../../lib/useWallet';

export default function AlertsRoute() {
  const router = useRouter();
  const wallet = useWallet();
  const [explanation, setExplanation] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Screen>
      <AlertsScreen
        cluster={wallet.cluster}
        explanation={explanation}
        statusLine={statusLine}
        exampleLimit={null}
        busy={busy}
        onNotNow={() => router.replace('/first-run/protect')}
        onTurnOn={() => {
          setBusy(true);
          void (async () => {
            const alreadyAsked = await hasAskedForDecisionNotifications();
            await explainOnceThenAsk({
              alreadyAsked,
              showExplanation: async (copy) => {
                setExplanation(copy);
              },
              ask: async () => {
                await askAfterFirstRuleOpened();
                const Notifications = await import('expo-notifications');
                const current = await Notifications.getPermissionsAsync();
                setStatusLine(current.granted ? NOTIFICATION_CADENCE_LINE : NOTIFICATIONS_OFF_LINE);
              },
            });
          })()
            .catch((err: unknown) => {
              setExplanation(err instanceof Error ? err.message : 'Alerts could not be turned on.');
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      />
    </Screen>
  );
}
