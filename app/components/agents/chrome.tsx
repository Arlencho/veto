import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Circle, Path, Svg } from 'react-native-svg';

import { QuietReading, quietRefreshControl } from '../QuietRefresh';
import { SafeTop } from '../SafeTop';
import { CatchMark } from '../backglass/CatchMark';
import { Lamp } from '../backglass/Lamp';
import { motionAllowed, useReducedMotion } from '../backglass/motion';
import { colors, fonts, radii, space, touchTarget } from '../theme';
import type { Grade } from '../../lib/grade';

export function Cabinet({
  children,
  refreshing = false,
  onRefresh,
  edges = ['top'],
  showReading = true,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  showReading?: boolean;
}) {
  return (
    <SafeTop style={styles.safe} edges={edges}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        refreshControl={quietRefreshControl(onRefresh)}
      >
        {showReading ? <QuietReading busy={refreshing} /> : null}
        {children}
      </ScrollView>
    </SafeTop>
  );
}

export function StatusLine({ children }: { children: string }) {
  return <Text style={styles.status}>{children}</Text>;
}

export function NetworkPill({ label }: { label: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

export function LiveRules({
  count,
  label,
  pending = false,
}: {
  count: number;
  label: string;
  pending?: boolean;
}) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const live = count > 0 && !pending;
  const tone = pending ? colors.brass : live ? colors.paid : colors.muted;
  const shell = pending ? styles.livePending : live ? styles.liveOn : styles.liveOff;
  return (
    <View style={[styles.live, shell]}>
      {live && motionOn ? (
        <Lamp state="pulse" size={8} litColor={colors.paid} accessibilityLabel={label} />
      ) : (
        <View style={[styles.liveDot, { backgroundColor: tone }]} />
      )}
      <Text style={[styles.liveText, { color: tone }]}>{label}</Text>
    </View>
  );
}

export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.iconButton}>
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Path d="M15 6l-6 6 6 6" fill="none" stroke={colors.bone} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </Pressable>
  );
}

export function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onPress} style={styles.iconButton}>
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Path d="M6 6l12 12M18 6L6 18" fill="none" stroke={colors.bone} strokeWidth={1.8} strokeLinecap="round" />
      </Svg>
    </Pressable>
  );
}

export function HelpMark({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="How grades work" onPress={onPress} style={styles.iconButton}>
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Circle cx={12} cy={12} r={9} fill="none" stroke={colors.body} strokeWidth={1.6} />
        <Path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" fill="none" stroke={colors.body} strokeWidth={1.6} strokeLinecap="round" />
        <Circle cx={12} cy={17} r={0.8} fill={colors.body} />
      </Svg>
    </Pressable>
  );
}

export function Wordmark() {
  return (
    <View style={styles.wordmark}>
      <CatchMark size={20} />
      <Text style={styles.word}>Veto</Text>
    </View>
  );
}

const LAMP: Record<Grade['id'], { color: string; hollow: boolean }> = {
  stayed: { color: colors.paid, hollow: false },
  tested: { color: colors.amber, hollow: false },
  pushed: { color: colors.refused, hollow: false },
  'too-new': { color: 'transparent', hollow: true },
};

const BORDER: Record<Grade['id'], { color: string; dashed: boolean }> = {
  stayed: { color: 'rgba(156, 201, 168, 0.65)', dashed: false },
  tested: { color: 'rgba(201, 162, 77, 0.65)', dashed: false },
  pushed: { color: 'rgba(228, 164, 142, 0.65)', dashed: false },
  'too-new': { color: 'rgba(237, 230, 214, 0.35)', dashed: true },
};

export function GradeFace({
  grade,
  detail,
  compact = false,
}: {
  grade: Grade;
  detail: string;
  compact?: boolean;
}) {
  const lamp = LAMP[grade.id];
  const border = BORDER[grade.id];
  return (
    <View
      style={[
        styles.grade,
        { borderColor: border.color, borderStyle: border.dashed ? 'dashed' : 'solid' },
        compact ? styles.gradeCompact : null,
      ]}
    >
      <View style={styles.gradeHead}>
        <View
          style={[
            styles.gradeLamp,
            lamp.hollow
              ? { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.body }
              : { backgroundColor: lamp.color },
          ]}
        />
        <Text style={[styles.gradeTitle, compact ? styles.gradeTitleCompact : null]}>{grade.label}</Text>
      </View>
      <Text style={styles.gradeDetail}>{detail}</Text>
    </View>
  );
}

export function BrassButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.brass}>
      <Text style={styles.brassText}>{label}</Text>
    </Pressable>
  );
}

export function GhostButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.ghost}>
      <Text style={styles.ghostText}>{label}</Text>
    </Pressable>
  );
}

export function Chevron() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path d="M9 6l6 6-6 6" fill="none" stroke={colors.muted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: space.bottom, flexGrow: 1 },
  status: {
    marginHorizontal: space.screen,
    marginTop: space.xl,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
  },
  pill: {
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.5)',
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pillText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.brass,
  },
  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  liveOn: {
    backgroundColor: 'rgba(156, 201, 168, 0.10)',
    borderColor: 'rgba(156, 201, 168, 0.45)',
  },
  liveOff: {
    borderColor: colors.line,
  },
  livePending: {
    borderColor: 'rgba(201, 162, 77, 0.45)',
  },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  liveText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  iconButton: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  word: {
    fontFamily: fonts.serif,
    fontSize: 20,
    color: colors.bone,
  },
  grade: {
    gap: 3,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radii.plaque,
    borderWidth: 1,
    backgroundColor: colors.forestLift,
  },
  gradeCompact: { paddingVertical: 5, borderRadius: radii.stat },
  gradeHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  gradeLamp: { width: 10, height: 10, borderRadius: 5 },
  gradeTitle: {
    fontFamily: fonts.serifRegular,
    fontSize: 17,
    lineHeight: 20,
    color: colors.bone,
    flexShrink: 1,
  },
  gradeTitleCompact: { fontSize: 16 },
  gradeDetail: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.body,
  },
  brass: {
    minHeight: 52,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  brassText: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.forest,
  },
  ghost: {
    minHeight: 48,
    borderRadius: radii.plaque,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  ghostText: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    color: colors.bone,
  },
});
