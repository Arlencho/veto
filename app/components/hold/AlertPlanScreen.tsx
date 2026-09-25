import { StyleSheet, Text, View } from 'react-native';

import { CatchMark } from '../backglass/CatchMark';
import { Lamp } from '../backglass/Lamp';
import { colors, fonts, radii, space } from '../theme';
import { HoldSign, HoldTop, StatusBlock } from './chrome';

export type AlertRow = {
  when: string;
  what: string;
  state: 'done' | 'next' | 'later';
};

export function AlertPlanScreen({
  network,
  status,
  error,
  empty,
  headline,
  noticeTitle,
  noticeBody,
  noticeWhen,
  rows,
  onBack,
  onStop,
  signingDisabled = false,
}: {
  network: string;
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  empty?: string;
  headline: string;
  noticeTitle: string;
  noticeBody: string;
  noticeWhen: string;
  rows: readonly AlertRow[];
  onBack: () => void;
  onStop: () => Promise<void>;
  signingDisabled?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <HoldTop title="Alerts for this hold" network={network} onBack={onBack} />
      <StatusBlock status={status} error={error} empty={empty ?? 'No withdrawal is waiting, so there is no alert plan.'}>
        <Text style={styles.h1}>You will be asked more than once.</Text>
        <Text style={styles.body}>{headline}</Text>
        <View
          accessibilityLabel={`Example notice: ${noticeTitle}. ${noticeBody}`}
          style={styles.notice}
        >
          <CatchMark size={20} />
          <View style={styles.noticeCopy}>
            <Text style={styles.noticeMeta}>Veto · {noticeWhen}</Text>
            <Text style={styles.noticeTitle}>{noticeTitle}</Text>
            <Text style={styles.body}>{noticeBody}</Text>
          </View>
        </View>
        <View style={styles.list} accessibilityLabel="Alert schedule for this hold">
          {rows.map((row) => (
            <View
              key={`${row.when}-${row.what}`}
              style={[styles.row, row.state === 'next' && styles.rowNext]}
              accessibilityState={row.state === 'next' ? { selected: true } : undefined}
            >
              <Text style={[styles.when, row.state === 'next' && styles.whenNext]}>{row.when}</Text>
              <Text style={[styles.what, row.state === 'next' && styles.whatNext]}>{row.what}</Text>
              {row.state === 'next' ? <Lamp state="pulse" litColor={colors.tilt} size={10} /> : null}
            </View>
          ))}
        </View>
        <View style={styles.source}>
          <Text style={styles.kicker}>Where these come from</Text>
          <Text style={styles.body}>
            Veto&apos;s watcher reads the blockchain and pushes at once. This app also checks about every
            15 minutes and raises the same alerts on this phone. Battery saving can delay that check.
            Hold alerts cannot be muted.
          </Text>
        </View>
        <HoldSign
          name="stop-plan"
          label="Hold to stop this withdrawal"
          hint="One fingerprint on this phone or on your second Seeker. Saved on the blockchain."
          disabled={signingDisabled}
          onSign={onStop}
        />
      </StatusBlock>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  h1: { color: colors.bone, fontFamily: fonts.serifRegular, fontSize: 28, lineHeight: 32 },
  body: { color: colors.body, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  notice: {
    flexDirection: 'row',
    gap: space.lg,
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.brassSoft,
    backgroundColor: colors.surface,
    padding: space.xl,
  },
  noticeCopy: { flex: 1, gap: 3 },
  noticeMeta: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  noticeTitle: { color: colors.bone, fontFamily: fonts.sansBold, fontSize: 14 },
  list: {
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 36,
    paddingHorizontal: space.xl,
    paddingVertical: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.boneLine,
  },
  rowNext: { backgroundColor: 'rgba(242, 185, 75, 0.06)' },
  when: {
    width: 108,
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  whenNext: { color: colors.tilt },
  what: { flex: 1, color: colors.body, fontFamily: fonts.sans, fontSize: 13 },
  whatNext: { color: colors.bone, fontFamily: fonts.sansSemibold },
  source: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.xl,
    gap: space.sm,
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
});
