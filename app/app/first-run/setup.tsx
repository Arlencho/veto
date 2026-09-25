import { useRouter } from 'expo-router';

import { AgentSetupScreen } from '../../components/firstrun/AgentSetupScreen';
import { Screen } from '../../components/Screen';
import { FIRST_RUN_ROUTES } from '../../lib/onboarding';
import { useChain } from '../../lib/useChain';
import { useWallet } from '../../lib/useWallet';

export default function SetupRoute() {
  const router = useRouter();
  const wallet = useWallet();
  const chain = useChain();
  const mandate = chain.mandate;
  return (
    <Screen>
      <AgentSetupScreen
        cluster={wallet.cluster}
        rows={[]}
        configJson={null}
        status={
          mandate
            ? 'Your agent can find this rule by itself when it runs the Veto companion. Keep your agent running.'
            : null
        }
        onCopy={() => undefined}
        onAlerts={() => router.push(FIRST_RUN_ROUTES.alerts)}
        onOverview={() => router.replace('/first-run/protect')}
        view={chain.loading ? 'loading' : mandate ? 'normal' : 'empty'}
      />
    </Screen>
  );
}
