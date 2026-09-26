import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatTokenDisplay } from '../lib/tokens';
import { isActive, mandateRemaining } from '../lib/mandate';
import type { MandateAccount } from '../lib/mandate';
import { displayPurpose, ruleCardTimeLeft, ruleStatusLabel, spendRatio } from '../lib/ruleView';
import { truncateAddress } from '../lib/wallet';
import { BrassFrame } from './backglass/BrassFrame';
import { BlockBar } from './backglass/BlockBar';
import { barUnits } from './daily/facts';
import { LivePill } from './daily/LivePill';
import { colors, fonts, radii, space } from './theme';

export function RuleListItem({
  mandate,
  decimals,
  nowSec,
  current,
  onPress,
}: {
  mandate: MandateAccount;
  decimals: number;
  nowSec: bigint;
  current: boolean;
  onPress: () => void;
}) {
  const purpose = displayPurpose(mandate.purpose);
  const mint = mandate.mint;
  const spent = formatTokenDisplay(mandate.spent, decimals, mint);
  const cap = formatTokenDisplay(mandate.cap, decimals, mint);
  const per = formatTokenDisplay(mandate.perTxMax, decimals, mint);
  const remaining = mandateRemaining(mandate);
  const bars = barUnits(remaining, mandate.cap);
  const status = ruleStatusLabel(mandate, nowSec, current);
  const timeLeft = ruleCardTimeLeft(mandate.expiresAt, nowSec);
  const live = isActive(mandate, nowSec);
  const spentShare = Math.round(spendRatio(mandate.spent, mandate.cap) * 100);

  const body = (
    <View style={styles.inner}>
      <View style={styles.head}>
        <View style={styles.titles}>
          <Text style={styles.purpose}>{purpose}</Text>
          <Text style={styles.agent}>{`Your agent: ${truncateAddress(mandate.agent)}`}</Text>
        </View>
        <LivePill
          label={live ? 'Live' : status === 'revoked' ? 'Stopped' : 'Ended'}
          tone={live ? 'live' : 'stopped'}
        />
      </View>
      <View style={styles.figures}>
        <Text style={styles.remaining} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>
          {formatTokenDisplay(remaining, decimals, mint, 'floor')}
        </Text>
        <View style={styles.subFigures}>
          <Text style={styles.of}>{`left of your ${cap} total`}</Text>
          <Text style={styles.spent}>
            <Text style={styles.spentFigure}>{spent}</Text>
            {' spent'}
          </Text>
        </View>
      </View>
      <View style={live ? undefined : styles.dim}>
        <BlockBar
          remaining={bars.remaining}
          cap={bars.cap}
          accessibilityLabel={`${formatTokenDisplay(remaining, decimals, mint, 'floor')} left of ${cap}. ${spentShare} percent of the total is spent.`}
        />
      </View>
      <View style={styles.foot}>
        <Text style={styles.meta}>{`Most ${per} per payment\nPayee ${truncateAddress(mandate.merchant)} only`}</Text>
        <Text style={styles.day}>{timeLeft}</Text>
      </View>
    </View>
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${purpose}, ${status}`}
      onPress={onPress}
    >
      {live ? <BrassFrame padding={14}>{body}</BrassFrame> : <View style={styles.quiet}>{body}</View>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  inner: {
    gap: space.md,
  },
  quiet: {
    borderRadius: radii.frame,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.lg,
  },
  titles: {
    flex: 1,
    gap: 3,
  },
  purpose: {
    fontFamily: fonts.serifItalic,
    fontSize: 17,
    lineHeight: 22,
    color: colors.bone,
  },
  agent: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  figures: {
    gap: space.xs,
  },
  subFigures: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space.md,
    rowGap: 2,
  },
  remaining: {
    fontFamily: fonts.serifLight,
    fontSize: 44,
    lineHeight: 46,
    color: colors.bone,
  },
  of: {
    flexShrink: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
  spent: {
    flexShrink: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.body,
  },
  spentFigure: {
    fontFamily: fonts.serif,
    fontSize: 18,
    lineHeight: 22,
    color: colors.bone,
  },
  dim: {
    opacity: 0.55,
  },
  foot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: space.md,
  },
  meta: {
    flexShrink: 1,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  day: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    lineHeight: 16,
    color: colors.brass,
    textAlign: 'right',
  },
});
