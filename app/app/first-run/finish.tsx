import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { BrassButton, FirstRunChrome } from '../../components/firstrun/Chrome';
import { Screen } from '../../components/Screen';
import { type as typeScale } from '../../components/theme';
import { isActive } from '../../lib/mandate';
import { listHoldVaults } from '../../lib/holdChain';
import { useHoldSession } from '../../lib/holdSession';

export default function FinishRoute() {
  const router = useRouter();
  const session = useHoldSession();
  const [now] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  const [hold, setHold] = useState('Checking your Hold vault');
  useEffect(() => {
    let alive = true;
    if (!session.client || !session.owner) return;
    void listHoldVaults(session.client, session.owner)
      .then((vaults) => {
        if (alive)
          setHold(
            vaults.some((vault) => vault.owner.equals(session.owner!))
              ? 'Hold vault live'
              : 'Hold vault not set up yet. You can set it up from Overview.',
          );
      })
      .catch(() => {
        if (alive)
          setHold('Hold vault status could not be checked. Open Hold on Overview to check.');
      });
    return () => {
      alive = false;
    };
  }, [session.client, session.owner]);
  const live = session.chain.mandates.some((rule) => isActive(rule, now));
  return (
    <Screen>
      <FirstRunChrome
        stage="live"
        cluster={session.wallet.cluster}
        footer={<BrassButton label="Go to overview" onPress={() => router.replace('/')} />}
      >
        <Text style={typeScale.body}>Your protections</Text>
        <Text style={typeScale.body}>
          {session.chain.error
            ? 'Agent rule status could not be checked'
            : session.chain.loading
              ? 'Checking your agent rule'
              : live
                ? 'Agent rule live'
                : 'Agent rule not live yet'}
        </Text>
        <Text style={typeScale.body}>
          {!session.client || !session.owner
            ? 'Hold vault status is unavailable. Connect your wallet and check Hold on Overview.'
            : hold}
        </Text>
      </FirstRunChrome>
    </Screen>
  );
}
