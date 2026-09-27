import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { showsIntroduction } from '../lib/onboarding';
import { useOnboarding } from '../lib/useOnboarding';
import { useWallet } from '../lib/useWallet';
import { clusterNotice } from '../lib/wallet';
import { ConnectWalletScreen } from './firstrun/ConnectWalletScreen';
import { SafeTop, useTopInset } from './SafeTop';
import { colors, fonts, space } from './theme';

type IntroProps = {
  showConnect: boolean;
  connectBusy: boolean;
  onSkip: () => Promise<void> | void;
  showOtherWallet: boolean;
  onConnect: () => Promise<void> | void;
  onConnectOther: () => Promise<void> | void;
};

function IntroCards(props: IntroProps) {
  const [View, setView] = useState<ComponentType<IntroProps> | null>(null);
  useEffect(() => {
    let alive = true;
    void import('./OnboardingCards').then((mod) => {
      if (alive) {
        setView(() => mod.OnboardingCards);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!View) {
    return <ActivityIndicator color={colors.text} accessibilityLabel="Loading" />;
  }
  return <View {...props} />;
}

function Guide({ onFinish }: { onFinish: () => void }) {
  const [View, setView] = useState<ComponentType<{ onFinish: () => void }> | null>(null);
  useEffect(() => {
    let alive = true;
    void import('./firstrun/Guide').then((mod) => {
      if (alive) {
        setView(() => mod.FirstRunGuide);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!View) {
    return <ActivityIndicator color={colors.text} accessibilityLabel="Loading" />;
  }
  return <View onFinish={onFinish} />;
}

export function ConnectGate({
  children,
  showNetwork = true,
}: {
  children: ReactNode;
  showNetwork?: boolean;
}) {
  const insetAbove = useTopInset();
  const wallet = useWallet();
  const onboarding = useOnboarding();
  const connected = wallet.ownerPublicKey !== null;
  const networkLine = wallet.cluster ? clusterNotice(wallet.cluster) : null;
  const [freshRun, setFreshRun] = useState(false);
  const [guideDone, setGuideDone] = useState(false);
  const intro = showsIntroduction({ connected, seen: onboarding.seen });
  if (wallet.ready && onboarding.ready && intro && !freshRun) {
    setFreshRun(true);
  }

  // Tab screens wrap the gate in their own safe area. Stack routes such as /week/<agent> put the
  // gate outside the screen shell, so every branch the gate renders insets itself once, and the
  // shell inside drops its top edge.
  const pad = (node: ReactNode) => (insetAbove ? node : <SafeTop style={styles.safe}>{node}</SafeTop>);

  if (!wallet.ready || !onboarding.ready) {
    return pad(<ActivityIndicator color={colors.text} accessibilityLabel="Loading" />);
  }

  if (intro) {
    return pad(
      <IntroCards
        showConnect
        connectBusy={wallet.busy}
        onSkip={() => onboarding.markSeen()}
        showOtherWallet={wallet.solanaMobileInstalled}
        onConnect={async () => {
          await onboarding.markSeen();
          try {
            await wallet.connect();
          } catch {
            // The flag is already stored. The Connect screen below shows the wallet error.
          }
        }}
        onConnectOther={async () => {
          await onboarding.markSeen();
          try {
            await wallet.connect({ chooser: true });
          } catch {
            // The flag is already stored. The Connect screen below shows the wallet error.
          }
        }}
      />
    );
  }

  if (freshRun && connected && wallet.ownerPublicKey && !guideDone) {
    return pad(<Guide onFinish={() => setGuideDone(true)} />);
  }

  if (!connected || !wallet.ownerPublicKey) {
    return pad(
      <ConnectWalletScreen
        cluster={wallet.cluster}
        busy={wallet.busy}
        error={wallet.error}
        showOtherWallet={wallet.solanaMobileInstalled}
        onConnect={() => {
          void wallet.connect();
        }}
        onConnectOther={() => {
          void wallet.connect({ chooser: true });
        }}
      />
    );
  }

  const body = (
    <View style={styles.block}>
      {showNetwork && networkLine ? (
        <Text style={insetAbove ? styles.thesis : [styles.thesis, styles.thesisOwn]}>{networkLine}</Text>
      ) : null}
      {children}
    </View>
  );
  return pad(body);
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    alignSelf: 'stretch',
    backgroundColor: colors.bg,
  },
  block: {
    gap: 16,
    alignSelf: 'stretch',
    flex: 1,
  },
  // Outside a Screen (stack routes) the gate owns the line, so it takes the screen's side margin.
  thesisOwn: {
    paddingHorizontal: space.screen,
  },
  thesis: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.sans,
  },
});
