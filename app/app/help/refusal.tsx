import { useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { BrassWell, Glow, ScreenHeader, TopicRow } from '../../components/records/chrome';
import { networkFoot } from '../../components/records/copy';
import { Screen } from '../../components/Screen';
import { colors, fonts } from '../../components/theme';

export default function HelpRefusalScreen() {
  const router = useRouter();
  const cluster = process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER;
  return (
    <Screen>
      <Glow />
      <ScreenHeader title="Help" cluster={cluster} onBack={() => router.back()} />
      <BrassWell>
        <Text style={styles.kicker}>A recorded no</Text>
        <Text style={styles.h1}>Why a refusal is recorded</Text>
      </BrassWell>
      <Text style={styles.body}>
        When a payment would break the rule, the program does not pay. It records the refusal on
        chain with the reason and the override that would have cleared it. Elsewhere the same
        block is a failed transaction that leaves no trace. Here the no is the product.
      </Text>
      <Text style={styles.body}>
        A refusal is a success. It is the rule holding. It is never an error.
      </Text>
      <Text style={styles.h1}>The two keys</Text>
      <Text style={styles.body}>
        The owner key lives in Seed Vault and never leaves it. It is the only key that can open a
        rule, grant an override, or revoke.
      </Text>
      <Text style={styles.body}>
        The agent key holds authority and none of your money. It can pay inside the rule, and nothing else.
        It cannot widen any limit. Each rule has its own agent. An override the owner grants is a
        recorded decision for one request, not a settings change. It allows one payment, used once, never above the remaining cap.
        The per-payment maximum does not change. The total cap does not.
      </Text>
      <TopicRow
        tone="brass"
        glyph="›"
        title="Next"
        body="What the export proves."
        accessibilityLabel="Next"
        onPress={() => router.push('/help/export')}
      />
      <Text style={styles.foot}>{networkFoot()}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kicker: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  h1: {
    color: colors.bone,
    fontFamily: fonts.serif,
    fontSize: 32,
    lineHeight: 36,
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 16,
    lineHeight: 24,
  },
  foot: {
    textAlign: 'center',
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
  },
});
