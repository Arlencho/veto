import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import * as RN from 'react-native';

import { ADVISORY_DECLINE_LABEL, KIND_ADVISORY_DECLINE } from '../lib/advisory';
import { KIND_OVERRIDE, KIND_REFUSED } from '../lib/constants';
import { encodeDecisionId } from '../lib/exportRecord';
import { explorerTxUrl } from '../lib/format';
import { formatTokenDisplay } from '../lib/tokens';
import { overrideRowView } from '../lib/override';
import type { LedgerRow } from '../lib/ring';
import { decisionFace, type RowTone } from './records/copy';
import { colors, fonts, radii } from './theme';

const TONE: Record<RowTone, { wash: string; ink: string; glyph: string }> = {
  paid: { wash: colors.paidWash, ink: colors.paid, glyph: '✓' },
  refused: { wash: colors.refusedWash, ink: colors.refused, glyph: '×' },
  allowed: { wash: colors.brassWash, ink: colors.amber, glyph: '1' },
  advisory: { wash: 'rgba(237, 230, 214, 0.06)', ink: colors.body, glyph: '✎' },
};

export function DecisionRow({
  row,
  decimals,
  cluster,
  rpcUrl,
  mandateAddress,
  perTxMax,
  mint,
  variant = 'list',
  nowMs,
  payee,
  fresh = false,
  bare = false,
  divider = false,
}: {
  row: LedgerRow;
  decimals: number;
  cluster: string;
  rpcUrl: string;
  mandateAddress: string;
  perTxMax?: bigint;
  mint?: string | null;
  variant?: 'list' | 'today';
  nowMs?: number;
  payee?: string;
  fresh?: boolean;
  bare?: boolean;
  divider?: boolean;
}) {
  const router = useRouter();
  const face = decisionFace(row, decimals, perTxMax, nowMs, { payee, mint });
  const tone = TONE[face.tone];
  const id = encodeDecisionId(mandateAddress, row);
  const amount = formatTokenDisplay(row.amount, decimals, mint);

  const openDetail = () => {
    router.push(`/decision/${encodeURIComponent(id)}`);
  };

  const openTx = () => {
    if (!row.signature) {
      return;
    }
    void RN.Linking.openURL(explorerTxUrl(row.signature, cluster, rpcUrl));
  };

  let accessibilityLabel = `Paid within rule ${amount}`;
  if (row.kind === KIND_ADVISORY_DECLINE) {
    accessibilityLabel = `${ADVISORY_DECLINE_LABEL} ${amount}`;
  } else if (row.kind === KIND_REFUSED) {
    accessibilityLabel = 'Refused, recorded';
  } else if (row.kind === KIND_OVERRIDE) {
    accessibilityLabel = `Waived by the owner ${overrideRowView(row, decimals, mint).amount}`;
  }

  return (
    <RN.Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={openDetail}
      style={[
        bare ? styles.bare : styles.card,
        variant === 'today' && !bare && styles.today,
        divider && styles.divider,
      ]}
    >
      <RN.View style={[styles.mark, { backgroundColor: tone.wash }, face.tone === 'advisory' && styles.noteMark]}>
        {fresh ? <FreshDot /> : null}
        <RN.Text style={[styles.glyph, { color: tone.ink }]}>{tone.glyph}</RN.Text>
      </RN.View>
      <RN.View style={styles.copy}>
        {face.badge ? <RN.Text style={styles.badge}>{face.badge}</RN.Text> : null}
        <RN.Text style={styles.title}>{face.title}</RN.Text>
        <RN.Text style={styles.detail}>{face.detail}</RN.Text>
        {face.chainLink ? (
          <RN.Pressable accessibilityRole="link" accessibilityLabel={face.chainLink} onPress={openTx} hitSlop={6}>
            <RN.Text style={styles.tx}>{face.chainLink}</RN.Text>
          </RN.Pressable>
        ) : null}
      </RN.View>
      <RN.View style={styles.figures}>
        <RN.Text style={[styles.figure, { color: tone.ink }]}>{face.figure}</RN.Text>
        <RN.Text style={styles.when}>{face.when}</RN.Text>
      </RN.View>
    </RN.Pressable>
  );
}

function FreshDot() {
  const reduced = useSafeReduced();
  const motionOn = reduced === false && RN.Animated != null;
  const [scale] = useState(() => (RN.Animated ? new RN.Animated.Value(1) : null));

  useEffect(() => {
    const Animated = RN.Animated;
    if (!motionOn || !Animated || !scale) {
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.8,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => {
      anim.stop();
    };
  }, [motionOn, scale]);

  return (
    <RN.View style={styles.fresh} pointerEvents="none">
      {motionOn && scale && RN.Animated?.View ? (
        <RN.Animated.View style={[styles.freshPing, { transform: [{ scale }] }]} />
      ) : null}
      <RN.View style={styles.freshDot} />
    </RN.View>
  );
}

function useSafeReduced(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    const info = RN.AccessibilityInfo;
    if (!info?.isReduceMotionEnabled) {
      return;
    }
    let alive = true;
    Promise.resolve(info.isReduceMotionEnabled())
      .then((value) => {
        if (alive) {
          setReduced(value);
        }
      })
      .catch(() => {
        if (alive) {
          setReduced(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  return reduced;
}

const styles = RN.StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 44,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  today: {
    paddingVertical: 10,
  },
  bare: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 44,
    backgroundColor: colors.surface,
  },
  divider: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  mark: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteMark: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(237, 230, 214, 0.35)',
  },
  glyph: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
  fresh: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 8,
    height: 8,
  },
  freshPing: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.refused,
    opacity: 0.45,
  },
  freshDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.refused,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  badge: {
    alignSelf: 'flex-start',
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.body,
    borderWidth: 1,
    borderColor: 'rgba(237, 230, 214, 0.3)',
    borderRadius: radii.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  title: {
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.bone,
  },
  detail: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  tx: {
    color: colors.body,
    fontSize: 12,
    fontFamily: fonts.sans,
    textDecorationLine: 'underline',
  },
  figures: {
    alignItems: 'flex-end',
    gap: 2,
  },
  figure: {
    fontFamily: fonts.serif,
    fontSize: 18,
    lineHeight: 22,
  },
  when: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 14,
    color: colors.muted,
  },
});
