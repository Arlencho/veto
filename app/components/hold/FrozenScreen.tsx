import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { HoldRecordLine } from '../../lib/hold';
import { Lamp } from '../backglass/Lamp';
import { colors, fonts, radii, space } from '../theme';
import { HoldSign, HoldTop, StatusBlock } from './chrome';

export function FrozenScreen({
  network,
  status,
  error,
  empty,
  frozenBy,
  amountLabel,
  tokenName,
  stoppedLine,
  sinceLabel,
  safeLabel,
  records,
  unfreezeHint,
  onClose,
  onRecover,
  onUnfreeze,
  signingDisabled = false,
}: {
  network: string;
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  empty?: string;
  frozenBy: string;
  amountLabel: string;
  tokenName: string;
  stoppedLine: string;
  sinceLabel: string;
  safeLabel: string;
  records: readonly HoldRecordLine[];
  unfreezeHint: string;
  onClose: () => void;
  onRecover: () => Promise<void>;
  onUnfreeze: () => void | Promise<void>;
  signingDisabled?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <HoldTop title="Vault frozen" network={network} onBack={onClose} backLabel="Close" />
      <StatusBlock status={status} error={error} empty={empty ?? 'This vault is not frozen.'}>
        <View style={styles.plate}>
          <Lamp state="pulse" litColor={colors.refused} size={14} accessibilityLabel="Frozen" />
          <Text style={styles.plateWord}>Frozen</Text>
          <Text style={styles.plateRest}>{frozenBy}</Text>
        </View>
        <Text style={styles.h1}>Nothing leaves. Not even the everyday amount.</Text>
        <Text style={styles.body}>{stoppedLine}</Text>
        <View style={styles.balance}>
          <Text style={styles.kicker}>In your vault</Text>
          <Text style={styles.amount}>
            {amountLabel} <Text style={styles.unit}>{tokenName}</Text>
          </Text>
          <Text style={styles.hint}>{sinceLabel}</Text>
        </View>
        <View style={styles.record}>
          <Text style={styles.kicker}>The record so far</Text>
          <Text style={styles.onChain}>On the blockchain</Text>
          {records.map((row) => (
            <View key={`${row.time}-${row.title}`} style={styles.row}>
              <Text style={styles.time}>{row.time}</Text>
              <View style={styles.rowCopy}>
                <Text style={[styles.rowTitle, row.tone === 'stop' && styles.stop, row.tone === 'good' && styles.good]}>
                  {row.title}
                </Text>
                <Text style={styles.hint}>{row.detail}</Text>
              </View>
            </View>
          ))}
        </View>
        <HoldSign
          name="recover"
          label={`Hold to recover: move all ${amountLabel} to your safe address`}
          hint={`${safeLabel}. One key, at once.`}
          disabled={signingDisabled}
          onSign={onRecover}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Unfreeze" onPress={() => void onUnfreeze()} style={styles.ghost}>
          <Text style={styles.ghostTitle}>Unfreeze</Text>
          <Text style={styles.hint}>{unfreezeHint}</Text>
        </Pressable>
        <Text style={styles.center}>
          Recover only ever goes to the safe address you chose. Changing that address waits.
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
    borderColor: 'rgba(228, 164, 142, 0.7)',
    backgroundColor: colors.reelWell,
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
  },
  plateWord: {
    color: colors.refused,
    fontFamily: fonts.sansBold,
    fontSize: 14,
    letterSpacing: 3,
    textTransform: 'uppercase',
  },
  plateRest: { color: colors.body, fontFamily: fonts.sans, fontSize: 13 },
  h1: {
    color: colors.bone,
    fontFamily: fonts.serifRegular,
    fontSize: 30,
    lineHeight: 34,
    textAlign: 'center',
  },
  body: { color: colors.body, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  balance: {
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.brass,
    backgroundColor: colors.surface,
    padding: space.xxxl,
    gap: space.xs,
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  amount: { color: colors.bone, fontFamily: fonts.serifLight, fontSize: 40, lineHeight: 44 },
  unit: { fontFamily: fonts.sans, fontSize: 13, color: colors.body },
  hint: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  record: {
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    paddingTop: space.md,
  },
  onChain: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    paddingHorizontal: space.xl,
    paddingBottom: space.sm,
  },
  row: {
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.boneLine,
  },
  time: { width: 48, color: colors.muted, fontFamily: fonts.sansBold, fontSize: 11 },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { color: colors.bone, fontFamily: fonts.sansSemibold, fontSize: 14 },
  stop: { color: colors.refused },
  good: { color: colors.paid },
  ghost: {
    minHeight: 52,
    borderRadius: radii.cta,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.md,
  },
  ghostTitle: { color: colors.bone, fontFamily: fonts.sansBold, fontSize: 15 },
  center: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
