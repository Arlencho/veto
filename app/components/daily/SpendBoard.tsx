import { StyleSheet, Text, View } from 'react-native';

import { roundShownAmounts } from '../../lib/format';
import { BlockBar } from '../backglass/BlockBar';
import { BrassFrame } from '../backglass/BrassFrame';
import { colors, fonts, space } from '../theme';
import { DimLamps } from './DimLamps';
import { homeBlockCaption } from './facts';

export function SpendBoard({
  kicker,
  remainingText,
  ofText,
  spentText,
  spentCaption,
  remaining,
  cap,
  accessibilityLabel,
  leftCaption,
  rightCaption,
  aside,
  dimmed = false,
}: {
  kicker: string;
  remainingText: string;
  ofText: string;
  spentText: string;
  spentCaption: string;
  remaining: number;
  cap: number;
  accessibilityLabel: string;
  leftCaption: string;
  rightCaption: string;
  aside?: string;
  dimmed?: boolean;
}) {
  const blockLine = roundShownAmounts(homeBlockCaption(leftCaption, rightCaption) ?? leftCaption);
  const perLine = roundShownAmounts(rightCaption);
  const remainingLine = roundShownAmounts(remainingText, 'floor');
  const ofLine = roundShownAmounts(ofText);
  const spentLine = roundShownAmounts(spentText);
  return (
    <BrassFrame accessibilityLabel={roundShownAmounts(accessibilityLabel, 'floor')} padding={16}>
      {dimmed ? <DimLamps /> : null}
      <View style={styles.head}>
        <Text style={styles.kicker}>{kicker}</Text>
        {aside ? <Text style={styles.aside}>{aside}</Text> : null}
      </View>
      <View style={styles.figures}>
        <Text style={styles.remaining} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>
          {remainingLine}
        </Text>
        <Text style={styles.of}>{ofLine}</Text>
        <Text style={styles.spent}>
          <Text style={styles.spentFigure}>{spentLine}</Text>
          {` ${spentCaption}`}
        </Text>
      </View>
      <View style={dimmed ? styles.dim : undefined}>
        <BlockBar remaining={remaining} cap={cap} accessibilityLabel={accessibilityLabel} />
      </View>
      <View style={styles.captions}>
        <Text style={styles.caption}>{blockLine}</Text>
        <Text style={styles.caption}>{perLine}</Text>
      </View>
    </BrassFrame>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.lg,
  },
  kicker: {
    flex: 1,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  aside: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
    textAlign: 'right',
  },
  figures: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: space.lg,
  },
  remaining: {
    fontFamily: fonts.serifLight,
    fontSize: 64,
    lineHeight: 64,
    letterSpacing: -1.2,
    color: colors.bone,
  },
  of: {
    flexShrink: 1,
    fontFamily: fonts.serifLight,
    fontSize: 22,
    lineHeight: 26,
    color: colors.muted,
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
  captions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: space.md,
  },
  caption: {
    flexShrink: 1,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
});
