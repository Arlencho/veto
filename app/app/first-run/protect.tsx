import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { ProtectScreen } from '../../components/firstrun/ProtectScreen';
import { Screen } from '../../components/Screen';
import { secureStore } from '../../lib/mwa';
import {
  holdOnboardingNext,
  rememberHoldChoice,
  secondSeekerSetup,
} from '../../lib/onboardingHold';
import { useWallet } from '../../lib/useWallet';

export default function ProtectRoute() {
  const router = useRouter();
  const wallet = useWallet();
  const owner = wallet.ownerPublicKey;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!wallet.ready) return;
    if (!owner) {
      router.replace('/first-run/connect');
      return;
    }
    void holdOnboardingNext(secureStore, owner)
      .then((next) => {
        if (!alive) return;
        if (next === '/first-run/finish') router.replace(next);
        else setReady(true);
      })
      .catch(() => {
        if (alive) {
          setReady(true);
          setError('Your saved choice could not be read. Please try again.');
        }
      });
    return () => {
      alive = false;
    };
  }, [owner, router, wallet.ready]);
  async function choose(address?: string, phone = false) {
    if (!owner) return;
    try {
      await rememberHoldChoice(secureStore, owner);
      if (phone)
        router.replace({ pathname: '/hold/amount', params: { onboarding: '1', mode: 'phone' } });
      else if (address) router.replace(secondSeekerSetup(address));
      else router.replace('/first-run/finish');
    } catch {
      setError('Your choice could not be saved. Please try again.');
    }
  }
  return (
    <Screen>
      {ready && owner ? (
        <ProtectScreen
          cluster={wallet.cluster}
          owner={owner}
          error={error}
          onSeeker={(address) => {
            void choose(address);
          }}
          onPhone={() => {
            void choose(undefined, true);
          }}
          onLater={() => {
            void choose();
          }}
        />
      ) : (
        <ActivityIndicator accessibilityLabel="Loading" />
      )}
    </Screen>
  );
}
