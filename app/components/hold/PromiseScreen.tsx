import { GUARDIAN_RECOVERY_COPY, SAFE_WALLET_GUIDANCE, OWNER_SAFE_WARNING } from '../../lib/holdSafeAddress';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from '../theme';
import { HoldTop } from './chrome';

export function PromiseScreen({
  network,
  onBack,
  onStart,
}: {
  network: string;
  onBack: () => void;
  onStart: () => void;
}) {
  return (
    <View style={styles.wrap}>
      <HoldTop title="Hold" network={network} onBack={onBack} backLabel="Close" />
      <Text style={styles.h1}>Hold: big money waits, and a second key can say no.</Text>
      <Text style={styles.body}>
        If someone gets your key, they can start a big withdrawal but they cannot finish it. Anything
        large waits 1, 2 or 3 days on the blockchain clock, and you or your second key can stop it,
        freeze the vault, or move everything to a safe address you chose while calm.
      </Text>
      <View style={styles.doors}>
        <View style={styles.fast}>
          <Text style={styles.fastKicker}>Everyday door: instant</Text>
          <Text style={styles.body}>Up to your daily limit, to addresses this vault has paid before. No wait.</Text>
        </View>
        <View style={styles.slow}>
          <Text style={styles.slowKicker}>Big door: held</Text>
          <Text style={styles.body}>Anything else waits. Held, not refused. It goes if nobody stops it.</Text>
        </View>
      </View>
      <Text style={styles.fact}>
        The wait runs on the blockchain clock. The program will not pay before it has passed, whether
        or not your phone was awake.
      </Text>
      <Text style={styles.fact}>
        {GUARDIAN_RECOVERY_COPY} {SAFE_WALLET_GUIDANCE} {OWNER_SAFE_WARNING} A stolen owner key can take at
        most the everyday amount until you freeze. Only money inside the vault is protected. Lose both
        keys and nobody, Veto included, can reach the money.
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Set up a vault" onPress={onStart} style={styles.cta}>
        <Text style={styles.ctaText}>Set up a vault</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xl },
  h1: {
    color: colors.bone,
    fontFamily: fonts.serifRegular,
    fontSize: 32,
    lineHeight: 36,
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  doors: { gap: space.md },
  fast: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: 'rgba(156, 201, 168, 0.45)',
    backgroundColor: 'rgba(156, 201, 168, 0.10)',
    padding: space.lg,
    gap: space.xs,
  },
  slow: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.brassLine,
    backgroundColor: 'rgba(201, 162, 77, 0.10)',
    padding: space.lg,
    gap: space.xs,
  },
  fastKicker: {
    color: colors.paid,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  slowKicker: {
    color: colors.amber,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  fact: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  cta: {
    height: 56,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    color: colors.forest,
    fontFamily: fonts.sansBold,
    fontSize: 17,
  },
});
