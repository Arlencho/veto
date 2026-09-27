import { redactRpc } from '../../lib/rpcPrivacy';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Circle, Path, Svg } from 'react-native-svg';

import { ScoreReel } from '../backglass/ScoreReel';
import { colors, fonts, radii, space } from '../theme';
import { networkBadge } from '../../lib/grade';
import { trackRecordFor, trackRecordPng } from '../../lib/trackRecord';
import { weekAria, weekFileText, weekReviewFor } from '../../lib/weekReview';
import type { AgentScreenData } from './useAgentHistories';
import { BrassButton, Cabinet, CloseButton, GhostButton, NetworkPill, StatusLine } from './chrome';

export function WeekScreen({
  data,
  agent,
  onBack,
  onSaveFile,
  onShareCard,
  onReason,
}: {
  data: AgentScreenData;
  agent: string;
  onBack: () => void;
  onSaveFile: (name: string, text: string) => Promise<void>;
  onShareCard: (bytes: Uint8Array) => Promise<void>;
  onReason: (ruleAddress: string) => void;
}) {
  const record = data.agents.find((item) => item.agent === agent) ?? null;
  const missing = data.status === 'ready' && record == null;
  const [ruleAddress, setRuleAddress] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const rule = record?.rules.find((item) => item.address === ruleAddress) ?? record?.rules[0] ?? null;
  const review = rule && record ? weekReviewFor(rule, record.name, data.nowSec) : null;

  async function run(action: () => Promise<void>) {
    setShareError(null);
    try {
      await action();
    } catch (err) {
      setShareError(err instanceof Error ? redactRpc(err.message) : 'The share did not finish.');
    }
  }

  return (
    <Cabinet refreshing={data.refreshing} onRefresh={data.refresh}>
      <View style={styles.header}>
        <CloseButton onPress={onBack} />
        <Text style={styles.headerTitle}>Week in review</Text>
        <NetworkPill label={networkBadge(data.cluster, 'tokens')} />
      </View>
      {data.status === 'loading' ? <StatusLine>Reading this week from the blockchain.</StatusLine> : null}
      {data.status === 'error' ? <StatusLine>{data.error ?? 'The record could not be read.'}</StatusLine> : null}
      {data.status === 'empty' || missing ? <StatusLine>This agent is not on a rule for this wallet.</StatusLine> : null}
      {record && rule && review ? (
        <View style={styles.body}>
          {record.rules.length > 1 ? (
            <View style={styles.picker}>
              {record.rules.map((item) => (
                <Pressable
                  key={item.address}
                  accessibilityRole="button"
                  accessibilityLabel={item.purpose}
                  accessibilityState={{ selected: item.address === rule.address }}
                  onPress={() => setRuleAddress(item.address)}
                >
                  <Text style={item.address === rule.address ? styles.picked : styles.pick}>{item.purpose}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <Text style={styles.kicker}>{review.kicker}</Text>
          <Text style={styles.h1}>{review.heading}</Text>
          <Text style={styles.intro}>Seven days of your rule. Every line below is read from the blockchain.</Text>
          <View style={styles.frame}>
            <View accessibilityLabel={weekAria(review)} style={styles.days}>
              {review.days.map((day) => (
                <View key={day.key} style={styles.day}>
                  <Text style={styles.wd}>{day.narrow}</Text>
                  <DayMark paid={day.paid} refused={day.refused} />
                  <Text style={styles.dayCount}>{day.label}</Text>
                </View>
              ))}
            </View>
            <View style={styles.legend}>
              <Text style={styles.legendText}>a day with payments</Text>
              <Text style={styles.legendText}>a refusal that day</Text>
            </View>
            <View style={styles.reels}>
              <View style={styles.reel}>
                <ScoreReel value={review.paidCount} tone="paid" accessibilityLabel={`${review.paidCount} payments paid`} />
                <View style={styles.reelCopy}>
                  <Text style={styles.reelKicker}>Paid</Text>
                  <Text style={styles.reelValue}>{review.paidAmountLabel} in total</Text>
                  <Text style={styles.reelMeta}>all within the rule</Text>
                </View>
              </View>
              <View style={styles.reel}>
                <ScoreReel value={review.refusedCount} tone="refused" accessibilityLabel={`${review.refusedCount} payments refused`} />
                <View style={styles.reelCopy}>
                  <Text style={styles.reelKicker}>Refused</Text>
                  <Text style={styles.reelValue}>0 moved</Text>
                  <Text style={styles.reelMeta}>{review.allowances === 0 ? 'none allowed after' : `${review.allowances} allowed after`}</Text>
                </View>
              </View>
            </View>
            <Text style={styles.left}>
              Your agent can still spend <Text style={styles.leftNum}>{review.remainingLabel}</Text> of {review.capLabel}, {review.dayLabel}
            </Text>
          </View>
          <Text style={styles.why}>Why it was refused</Text>
          <View style={styles.reasons}>
            {review.reasons.length === 0 ? <Text style={styles.quiet}>Nothing was refused.</Text> : null}
            {review.reasons.map((reason) => (
              <Pressable
                key={reason.reason}
                accessibilityRole="button"
                accessibilityLabel={`${reason.title}, ${reason.count}`}
                onPress={() => onReason(reason.ruleAddress)}
                style={styles.reason}
              >
                <View style={styles.reasonIcon}>
                  <Svg width={18} height={18} viewBox="0 0 24 24">
                    <Circle cx={12} cy={12} r={9} fill="none" stroke={colors.refused} strokeWidth={1.8} />
                    <Path d="M5.6 5.6l12.8 12.8" fill="none" stroke={colors.refused} strokeWidth={1.8} />
                  </Svg>
                </View>
                <View style={styles.reasonCopy}>
                  <Text style={styles.reasonTitle}>{reason.title}</Text>
                  <Text style={styles.reasonDetail}>{reason.detail}</Text>
                </View>
                <Text style={styles.reasonCount}>{reason.count}</Text>
              </Pressable>
            ))}
          </View>
          <BrassButton
            label="Save this week as a file"
            onPress={() => {
              if (!review) return;
              void run(() => onSaveFile('week-in-review.txt', weekFileText(review)));
            }}
          />
          <GhostButton
            label="Share this week as a card"
            onPress={() => {
              const base = trackRecordFor(rule, record.name, data.cluster, data.nowSec, false);
              void run(() =>
                onShareCard(
                  trackRecordPng({
                    ...base,
                    title: review.heading,
                    kicker: review.kicker,
                    lead: `${review.paidCount} paid, ${review.paidAmountLabel} in total.`,
                    follow: `${review.refusedCount} refused, 0 moved.`,
                    paid: review.paidCount,
                    refused: review.refusedCount,
                    allowances: review.allowances,
                    badge: networkBadge(data.cluster, 'card'),
                  }),
                ),
              );
            }}
          />
          {shareError ? <Text style={styles.error}>{shareError}</Text> : null}
          <Text style={styles.footer}>
            Arrives every Monday at 08:00. Change the day or turn it off. Refusals still reach you the moment they happen.
          </Text>
        </View>
      ) : null}
    </Cabinet>
  );
}

function DayMark({ paid, refused }: { paid: number; refused: number }) {
  if (paid === 0 && refused === 0) {
    return <View style={styles.quietLamp} />;
  }
  if (refused > 0) {
    return (
      <View style={styles.ring}>
        <View style={styles.paidLamp} />
      </View>
    );
  }
  return <View style={styles.paidLamp} />;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xxxl,
    paddingHorizontal: space.xl,
  },
  headerTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  body: { gap: 10, paddingHorizontal: space.screen, paddingTop: 8 },
  picker: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pick: { fontFamily: fonts.sans, fontSize: 13, color: colors.muted },
  picked: { fontFamily: fonts.sansBold, fontSize: 13, color: colors.brass },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  h1: { fontFamily: fonts.serifRegular, fontSize: 32, lineHeight: 35, color: colors.bone },
  intro: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 21, color: colors.body },
  frame: {
    borderRadius: radii.frame,
    borderWidth: 2,
    borderColor: colors.brass,
    backgroundColor: colors.surface,
    padding: 14,
    gap: 12,
  },
  days: { flexDirection: 'row', gap: 4 },
  day: { flex: 1, alignItems: 'center', gap: 6 },
  wd: { fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 0.8, color: colors.muted },
  dayCount: { fontFamily: fonts.sans, fontSize: 11, lineHeight: 14, color: colors.body, textAlign: 'center' },
  paidLamp: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.paid },
  quietLamp: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(237, 230, 214, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(237, 230, 214, 0.25)',
  },
  ring: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.refused,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.boneLine,
    paddingBottom: 10,
  },
  legendText: { fontFamily: fonts.sans, fontSize: 11, color: colors.muted },
  reels: { flexDirection: 'row', gap: 10 },
  reel: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  // The copy takes the width the reel leaves, so a long amount wraps inside the tile instead of clipping.
  reelCopy: { flex: 1, minWidth: 0 },
  reelKicker: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  reelValue: { fontFamily: fonts.sansSemibold, fontSize: 14, color: colors.bone },
  reelMeta: { fontFamily: fonts.sans, fontSize: 11, color: colors.muted },
  left: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted, borderTopWidth: 1, borderTopColor: colors.boneLine, paddingTop: 8 },
  leftNum: { fontFamily: fonts.serifRegular, fontSize: 22, color: colors.bone },
  why: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  reasons: {
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  quiet: { padding: 14, fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, paddingHorizontal: 14, minHeight: 44 },
  reasonIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.refusedWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reasonCopy: { flex: 1, gap: 2 },
  reasonTitle: { fontFamily: fonts.sansSemibold, fontSize: 14, color: colors.bone },
  reasonDetail: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted },
  reasonCount: { fontFamily: fonts.serifRegular, fontSize: 18, color: colors.refused },
  error: { fontFamily: fonts.sans, fontSize: 13, color: colors.refused },
  footer: { textAlign: 'center', fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, color: colors.muted },
});
