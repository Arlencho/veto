import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Lamp } from '../backglass/Lamp';
import { colors, fonts, radii, space } from '../theme';
import { HoldSign, HoldTop, ReelValue, StatusBlock } from './chrome';
import type { Countdown } from '../../lib/hold';

export function HeldScreen({
  network,
  status,
  error,
  empty,
  amountLabel,
  tokenName,
  destinationLabel,
  waitLabel,
  countdown,
  untilLabel,
  reasons,
  toldLine,
  dailyLabel,
  onClose,
  onAlerts,
  onSkip,
  onStop,
  onFreeze,
  signingDisabled = false,
}: {
  network: string;
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  empty?: string;
  amountLabel: string;
  tokenName: string;
  destinationLabel: string;
  waitLabel: string;
  countdown: Countdown;
  untilLabel: string;
  reasons: readonly string[];
  toldLine: string;
  dailyLabel: string;
  onClose: () => void;
  onAlerts: () => void;
  onSkip: () => void;
  onStop: () => Promise<void>;
  onFreeze: () => Promise<void>;
  signingDisabled?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <HoldTop title="Held withdrawal" network={network} onBack={onClose} backLabel="Close" />
      <StatusBlock status={status} error={error} empty={empty ?? 'No withdrawal is waiting.'}>
        <View style={styles.plate}>
          <Lamp state="pulse" litColor={colors.tilt} size={14} accessibilityLabel="Held" />
          <Text style={styles.plateWord}>Held</Text>
          <Text style={styles.plateRest}>Waiting {waitLabel}, by your rule</Text>
        </View>
        <Text style={styles.h1}>Nothing has moved yet.</Text>
        <Text style={styles.body}>
          Your key asked to send {amountLabel} {tokenName} to {destinationLabel}. Veto is holding it.
        </Text>
        <View style={styles.card} accessibilityLabel={countdown.accessibilityLabel}>
          <Text style={styles.kicker}>Goes in</Text>
          <View style={styles.reels}>
            <ReelValue value={String(countdown.days)} />
            <Text style={styles.unit}>day</Text>
            <ReelValue value={String(countdown.hours)} />
            <Text style={styles.unit}>h</Text>
            <ReelValue value={String(countdown.minutes)} />
            <Text style={styles.unit}>min</Text>
          </View>
          <Text style={styles.hint}>{untilLabel}</Text>
          <Text style={styles.kicker}>Why it is held</Text>
          <View style={styles.chips}>
            {reasons.map((reason) => (
              <Text key={reason} style={styles.chip}>
                {reason}
              </Text>
            ))}
          </View>
        </View>
        <View style={styles.note}>
          <Text style={styles.body}>{toldLine}</Text>
          <Pressable accessibilityRole="link" accessibilityLabel="See plan" onPress={onAlerts}>
            <Text style={styles.link}>See plan</Text>
          </Pressable>
        </View>
        <HoldSign
          name="stop"
          label="Hold to stop this withdrawal"
          hint="One fingerprint on this phone. Saved on the blockchain."
          disabled={signingDisabled}
          onSign={onStop}
        />
        <HoldSign
          name="freeze"
          label="Hold to freeze the whole vault"
          hint={`Nothing leaves, not even the everyday ${dailyLabel} a day`}
          disabled={signingDisabled}
          onSign={onFreeze}
        />
        <Text style={styles.center}>
          It was you?{' '}
          <Text style={styles.link} onPress={onSkip} accessibilityRole="link">
            Let it go now with both keys
          </Text>
          .
        </Text>
      </StatusBlock>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  plate: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radii.plaque,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.7)',
    backgroundColor: colors.reelWell,
    paddingVertical: space.lg,
    paddingHorizontal: space.xxxl,
  },
  plateWord: {
    color: colors.tilt,
    fontFamily: fonts.sansBold,
    fontSize: 14,
    letterSpacing: 3,
    textTransform: 'uppercase',
  },
  plateRest: { color: colors.body, fontFamily: fonts.sans, fontSize: 13 },
  h1: {
    color: colors.bone,
    fontFamily: fonts.serifRegular,
    fontSize: 34,
    lineHeight: 38,
    textAlign: 'center',
  },
  body: { color: colors.body, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  card: {
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.brassSoft,
    backgroundColor: colors.surface,
    padding: space.xxxl,
    gap: space.md,
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  reels: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, flexWrap: 'wrap' },
  unit: { color: colors.muted, fontFamily: fonts.sans, fontSize: 11, paddingBottom: 6 },
  hint: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    color: colors.amber,
    fontFamily: fonts.sansSemibold,
    fontSize: 12,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.5)',
    borderRadius: radii.pill,
    paddingVertical: 4,
    paddingHorizontal: space.lg,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.xl,
  },
  link: { color: colors.brass, fontFamily: fonts.sansBold, fontSize: 14 },
  center: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});
