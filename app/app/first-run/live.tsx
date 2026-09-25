import { useRouter } from 'expo-router';

import { liveFactsFromMandate, RuleLiveScreen } from '../../components/firstrun/RuleLiveScreen';
import { Screen } from '../../components/Screen';
import { FIRST_RUN_ROUTES } from '../../lib/onboarding';
import { useChain } from '../../lib/useChain';
import { useWallet } from '../../lib/useWallet';

export default function LiveRoute() {
  const router = useRouter();
  const wallet = useWallet();
  const chain = useChain();
  return (
    <Screen>
      <RuleLiveScreen
        cluster={wallet.cluster}
        facts={
          chain.mandate
            ? liveFactsFromMandate({
                mandate: chain.mandate,
                decimals: chain.ready ? chain.decimals : null,
                signature: null,
                cluster: wallet.cluster,
                rpcUrl: chain.config?.rpcUrl ?? null,
                agentName: null,
              })
            : null
        }
        onSetup={() => router.push(FIRST_RUN_ROUTES.setup)}
        onOverview={() => router.replace('/first-run/protect')}
      />
    </Screen>
  );
}
