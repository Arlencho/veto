import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Circle, Path, Svg } from 'react-native-svg';

import { ADVISORY_DECLINE_LABEL, KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import { KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, REASON_OVER_PER_TX_MAX } from '../../lib/constants';
import { encodeDecisionId } from '../../lib/exportRecord';
import { formatTokenAmount, formatTokenDisplay, tokenSymbol } from '../../lib/tokens';
import { overrideRowView, paidAboveLimit } from '../../lib/override';
import { ownerReasonText } from '../../lib/reasons';
import type { LedgerRow } from '../../lib/ring';
import { payeeLabel } from '../../lib/wallet';
import { colors, fonts, space } from '../theme';

export function LatestDecision({
  row,
  decimals,
  perTxMax,
  mandateAddress,
  payee,
  mint,
  remainingText,
  fresh,
  last,
}: {
  row: LedgerRow;
  decimals: number;
  perTxMax?: bigint;
  mandateAddress: string;
  payee: string;
  mint?: string | null;
  remainingText: string;
  fresh: boolean;
  last: boolean;
}) {
  const router = useRouter();
  const paid = row.kind === KIND_PAID;
  // Above the limit, round the paid amount up and show the limit exactly, so the two never read equal.
  const above = paid && paidAboveLimit(row.amount, perTxMax);
  const amount = formatTokenDisplay(row.amount, decimals, mint, above ? 'ceil' : 'nearest');
  const limit =
    perTxMax != null
      ? above
        ? formatTokenAmount(perTxMax, decimals, mint)
        : formatTokenDisplay(perTxMax, decimals, mint)
      : null;
  const zeroPaid = mint ? `0 ${tokenSymbol(mint)} paid` : '0 paid';
  const who = payeeLabel(payee);
  const refused = row.kind === KIND_REFUSED;
  const waived = row.kind === KIND_OVERRIDE;
  const advisory = row.kind === KIND_ADVISORY_DECLINE;
  const tone = refused || advisory ? colors.refused : colors.paid;

  let title = ownerReasonText(row.reason);
  let detail = 'Saved on the blockchain.';
  let side = amount;
  if (refused && row.reason === REASON_OVER_PER_TX_MAX && limit) {
    title = `Refused: agent asked ${amount}, limit is ${limit}`;
    detail = 'No money moved. Reason saved.';
    side = zeroPaid;
  } else if (refused) {
    title = `Refused: ${ownerReasonText(row.reason)}`;
    detail = 'No money moved. Reason saved.';
    side = zeroPaid;
  } else if (paid) {
    title = `Paid ${amount} to ${who}`;
    detail = limit
      ? above
        ? `Allowed once by you: above your limit of ${limit}. ${remainingText} left.`
        : `Within the limit of ${limit}. ${remainingText} left.`
      : `${remainingText} left.`;
    side = `${amount} paid`;
  } else if (waived) {
    const view = overrideRowView(row, decimals, mint);
    title = `${view.say} ${view.italic}`;
    detail = 'This one payment was allowed. The limit did not change.';
    side = `${view.amount} paid`;
  } else if (advisory) {
    title = ADVISORY_DECLINE_LABEL;
    detail = row.reasonText || 'The agent declined. No payment was made.';
    side = amount;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => {
        router.push(`/decision/${encodeURIComponent(encodeDecisionId(mandateAddress, row))}`);
      }}
      style={[styles.row, !last && styles.border]}
    >
      <View style={[styles.icon, { backgroundColor: refused || advisory ? colors.refusedWash : colors.paidWash }]}>
        {fresh ? <View style={styles.ping} /> : null}
        <Mark refused={refused || advisory} color={tone} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.detail}>{detail}</Text>
      </View>
      <Text style={[styles.side, { color: tone }]}>{side}</Text>
    </Pressable>
  );
}

function Mark({ refused, color }: { refused: boolean; color: string }) {
  if (refused) {
    return (
      <Svg width={18} height={18} viewBox="0 0 24 24">
        <Circle cx={12} cy={12} r={9} fill="none" stroke={color} strokeWidth={1.8} />
        <Path d="M5.6 5.6l12.8 12.8" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      </Svg>
    );
  }
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9} fill="none" stroke={color} strokeWidth={1.8} />
      <Path d="M8 12.5l2.6 2.5L16 9.5" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    paddingVertical: space.lg,
    paddingHorizontal: space.xxl,
    minHeight: 44,
  },
  border: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ping: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.refused,
  },
  copy: {
    flex: 1,
    gap: 2,
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
  side: {
    fontFamily: fonts.serif,
    fontSize: 18,
    lineHeight: 22,
  },
});
