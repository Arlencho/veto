import { useContext } from 'react';
import { ConfiguredTokenContext } from '../../lib/configuredToken';
import { StyleSheet, Text } from 'react-native';

import { CONNECT_WALLET_BODY, connectNetworkLine } from '../../lib/onboarding';
import { SEEKER_APPROVAL_LINE, clusterNotice } from '../../lib/wallet';
import { colors, fonts, type as typeScale } from '../theme';
import { BrassButton, FirstRunChrome, QuietButton, type ScreenView } from './Chrome';

export function ConnectWalletScreen({
  cluster,
  busy = false,
  error = null,
  showOtherWallet = false,
  onConnect,
  onConnectOther,
  onBack,
  view,
}: {
  cluster: string | null;
  busy?: boolean;
  error?: string | null;
  showOtherWallet?: boolean;
  onConnect: () => void;
  onConnectOther?: () => void;
  onBack?: () => void;
  view?: ScreenView;
}) {
  const network = connectNetworkLine(cluster, useContext(ConfiguredTokenContext));
  const resolved = view ?? (cluster ? 'normal' : 'empty');
  return (
    <FirstRunChrome
      stage="connect"
      cluster={cluster}
      title="Connect wallet"
      onBack={onBack}
      view={resolved}
      error={error}
      empty="Waiting for the network."
      footer={
        <>
          <BrassButton
            label={busy ? 'Connecting...' : 'Open Solana Mobile wallet'}
            accessibilityLabel="Open Solana Mobile wallet"
            busy={busy}
            onPress={onConnect}
          />
          {showOtherWallet && onConnectOther ? (
            <QuietButton label="Use another wallet" busy={busy} onPress={onConnectOther} />
          ) : null}
        </>
      }
    >
      <Text style={styles.kicker}>Your key stays on your phone</Text>
      <Text style={styles.title}>Connect your wallet.</Text>
      <Text style={styles.body}>{SEEKER_APPROVAL_LINE}</Text>
      <Text style={styles.body}>{CONNECT_WALLET_BODY}</Text>
      {cluster ? <Text style={styles.body}>{clusterNotice(cluster)}</Text> : null}
      {network ? <Text style={styles.body}>{network}</Text> : null}
      <Text style={styles.note}>Veto never sees your key.</Text>
    </FirstRunChrome>
  );
}

const styles = StyleSheet.create({
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  title: {
    fontFamily: fonts.serifRegular,
    fontSize: 34,
    lineHeight: 37,
    color: colors.bone,
  },
  body: {
    ...typeScale.body,
  },
  note: {
    ...typeScale.caption,
  },
});
