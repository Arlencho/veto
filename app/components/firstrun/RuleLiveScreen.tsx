import { StyleSheet, Text, View } from 'react-native';

import { explorerTxUrl } from '../../lib/format';
import { formatTokenDisplay } from '../../lib/tokens';
import type { MandateAccount } from '../../lib/mandate';
import { truncateAddress } from '../../lib/wallet';
import { ScoreReel, SealRow, StatTile } from '../backglass';
import { colors, fonts, space, type as typeScale } from '../theme';
import { BrassButton, FirstRunChrome, QuietButton, type ScreenView } from './Chrome';

export function liveFactsFromMandate(args: {
  mandate: MandateAccount;
  decimals: number | null;
  signature: string | null;
  cluster: string | null;
  rpcUrl: string | null;
  agentName: string | null;
  nowSec?: bigint;
}): LiveRuleFacts {
  const now = args.nowSec ?? BigInt(Math.floor(Date.now() / 1000));
  const remaining = args.mandate.expiresAt > now ? args.mandate.expiresAt - now : 0n;
  const totalDays = Math.max(1, Math.ceil(Number(remaining) / 86400));
  const who = args.agentName?.trim() ? args.agentName.trim() : 'Your agent';
  const payee = truncateAddress(args.mandate.merchant, 4);
  const amountsKnown = args.decimals != null;
  const cap = amountsKnown ? formatTokenDisplay(args.mandate.cap, args.decimals ?? 0, args.mandate.mint) : null;
  const max = amountsKnown ? formatTokenDisplay(args.mandate.perTxMax, args.decimals ?? 0, args.mandate.mint) : null;
  const summary =
    cap && max
      ? `${who} can now ask to pay ${payee}, at most ${max} per payment and ${cap} in total, for ${totalDays} days. It can only ask. It cannot take.`
      : `${who} can now ask to pay ${payee}. It can only ask. It cannot take.`;
  const seeUrl =
    args.signature && args.cluster && args.rpcUrl
      ? explorerTxUrl(args.signature, args.cluster, args.rpcUrl)
      : null;
  return {
    setAside: cap ?? 'Reading the amount',
    setAsideWhole: amountsKnown ? wholeTokenAmount(args.mandate.cap, args.decimals ?? 0) : null,
    day: 1,
    totalDays,
    paid: args.mandate.spendCount,
    refused: args.mandate.refusalCount,
    summary,
    seeUrl,
  };
}

function wholeTokenAmount(amount: bigint, decimals: number): number | null {
  if (decimals < 0 || decimals > 18) {
    return null;
  }
  const scale = 10n ** BigInt(decimals);
  if (amount % scale !== 0n) {
    return null;
  }
  const whole = amount / scale;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(whole);
}

export type LiveRuleFacts = {
  setAside: string;
  setAsideWhole: number | null;
  day: number;
  totalDays: number;
  paid: number;
  refused: number;
  summary: string;
  seeUrl: string | null;
};

export function RuleLiveScreen({
  cluster,
  facts,
  error = null,
  onSetup,
  onOverview,
  view,
}: {
  cluster: string | null;
  facts: LiveRuleFacts | null;
  error?: string | null;
  onSetup: () => void;
  onOverview: () => void;
  view?: ScreenView;
}) {
  const resolved = view ?? (error ? 'error' : facts ? 'normal' : 'empty');
  return (
    <FirstRunChrome
      stage="live"
      cluster={cluster}
      view={resolved}
      error={error}
      empty="No rule is live yet."
      footer={
        <>
          <BrassButton label="Give your agent its setup" onPress={onSetup} />
          <QuietButton label="Next: protect your money" onPress={onOverview} />
          <Text style={styles.note}>No money has moved yet. Your agent has to ask first.</Text>
        </>
      }
    >
      <Text style={styles.kicker}>Signed on this phone</Text>
      <Text style={styles.live}>Rule live</Text>
      <Text style={styles.title}>Your rule is live.</Text>
      {facts ? (
        <>
          <Text style={styles.section}>Set aside for this rule only</Text>
          {facts.setAsideWhole != null ? (
            <ScoreReel
              value={facts.setAsideWhole}
              tone="amber"
              accessibilityLabel={`${facts.setAside} set aside`}
            />
          ) : (
            <Text style={styles.amount}>{facts.setAside}</Text>
          )}
          <Text style={styles.body}>Your agent can never spend more than this.</Text>
          <View style={styles.stats}>
            <StatTile value={String(facts.day)} suffix={`of ${facts.totalDays}`} label="day of rule" />
            <StatTile value={String(facts.paid)} label="payments paid" valueColor={colors.paid} />
            <StatTile value={String(facts.refused)} label="payments refused" valueColor={colors.refused} />
          </View>
          <Text style={styles.body}>{facts.summary}</Text>
          <SealRow
            text="Saved on the blockchain. Anyone can check the rule and every payment or refusal under it."
            linkLabel="See it"
            href={facts.seeUrl ?? undefined}
          />
        </>
      ) : null}
    </FirstRunChrome>
  );
}

const styles = StyleSheet.create({
  kicker: {
    ...typeScale.kicker,
  },
  live: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.paid,
  },
  title: {
    fontFamily: fonts.serifRegular,
    fontSize: 34,
    lineHeight: 37,
    color: colors.bone,
  },
  section: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  amount: {
    fontFamily: fonts.serif,
    fontSize: 40,
    lineHeight: 44,
    color: colors.amber,
  },
  body: {
    ...typeScale.body,
  },
  stats: {
    flexDirection: 'row',
    gap: space.md,
  },
  note: {
    ...typeScale.caption,
    textAlign: 'center',
  },
});
