import { useContext } from 'react';
import { ConfiguredTokenContext } from '../../lib/configuredToken';
import { StyleSheet, Text, View } from 'react-native';

import { connectNetworkLine } from '../../lib/onboarding';
import { truncateAddress } from '../../lib/wallet';
import { colors, fonts, radii, space, type as typeScale } from '../theme';
import { BrassButton, FirstRunChrome, type ScreenView } from './Chrome';

export function WalletConnectedScreen({
  cluster,
  owner,
  error = null,
  onAddAgent,
  view,
}: {
  cluster: string | null;
  owner: string | null;
  error?: string | null;
  onAddAgent: () => void;
  view?: ScreenView;
}) {
  const network = connectNetworkLine(cluster, useContext(ConfiguredTokenContext));
  const resolved = view ?? (error ? 'error' : owner ? 'normal' : 'empty');
  const shown = owner ? truncateAddress(owner, 4) : '';
  return (
    <FirstRunChrome
      stage="connect"
      cluster={cluster}
      view={resolved}
      error={error}
      empty="No wallet is connected on this phone."
      footer={
        <>
          <BrassButton label="Add your agent" onPress={onAddAgent} />
          <Text style={styles.note}>{`Next: your agent's code or address. Nothing moves yet.`}</Text>
        </>
      }
    >
      <Text style={styles.kicker}>Connected</Text>
      <Text style={styles.address}>{shown}</Text>
      <Text style={styles.subtitle}>Your Seeker ID, on this phone</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>You approve rules with Seed Vault</Text>
        <Text style={styles.body}>{`The phone's secure key store. Veto never sees your key.`}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Your money stays yours</Text>
        <Text style={styles.body}>Only a rule you approve can set any of it aside.</Text>
      </View>
      {network ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{`Network: ${cluster}`}</Text>
          <Text style={styles.body}>{network}</Text>
        </View>
      ) : null}
    </FirstRunChrome>
  );
}

const styles = StyleSheet.create({
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.paid,
  },
  address: {
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
    color: colors.bone,
  },
  subtitle: {
    ...typeScale.body,
  },
  card: {
    gap: space.xs,
    padding: space.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cardTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    lineHeight: 22,
    color: colors.bone,
  },
  body: {
    ...typeScale.body,
  },
  note: {
    ...typeScale.caption,
    textAlign: 'center',
  },
});
