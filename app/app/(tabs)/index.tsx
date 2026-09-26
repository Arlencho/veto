import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { ConnectGate } from '../../components/ConnectGate';
import { ContextBar } from '../../components/ContextBar';
import { CatchMark } from '../../components/backglass/CatchMark';
import { ScoreReel } from '../../components/backglass/ScoreReel';
import { ClusterPill } from '../../components/daily/ClusterPill';
import { DayClock } from '../../components/daily/DayClock';
import { LatestDecision } from '../../components/daily/LatestDecision';
import { SpendBoard } from '../../components/daily/SpendBoard';
import { StreakCall } from '../../components/daily/StreakCall';
import { barUnits, openedAtSec, refusalStreak, ruleDay } from '../../components/daily/facts';
import { HoldEntry } from '../../components/hold/HoldEntry';
import { HomeStay } from '../../components/renewal/RenewalBanner';
import { EmptyState } from '../../components/EmptyState';
import { GetDevnetUsdc } from '../../components/GetDevnetUsdc';
import { OpenFirstRule } from '../../components/OpenFirstRule';
import { ReadState } from '../../components/ReadState';
import { RuleReadPill } from '../../components/RuleReadPill';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts, radii, space } from '../../components/theme';
import { KIND_REFUSED } from '../../lib/constants';
import { isListedDecision, timeLeftParts, todaysAgentDecisions } from '../../lib/format';
import { showDevnetUsdcFaucet } from '../../lib/faucet';
import { mainnetPreviewNote, devnetTestTokenNote, formatTokenDisplay } from '../../lib/tokens';
import { useWallet } from '../../lib/useWallet';
import { isActive, mandateRemaining } from '../../lib/mandate';
import { liveMandateCount, showRulePill, tabPillFace } from '../../lib/mandateRead';
import { NOTIFICATIONS_OFF_LINE } from '../../lib/notificationAsk';
import { displayPurpose, spendRatio } from '../../lib/ruleView';
import { tradePairLabel } from '../../lib/tradeRule';
import { useChain } from '../../lib/useChain';
import { useNotificationOffer } from '../../lib/useNotificationOffer';
import { useRefreshOnFocus } from '../../lib/useRefreshOnFocus';
import { truncateAddress } from '../../lib/wallet';

export default function OverviewScreen() {
  const chain = useChain();
  const wallet = useWallet();
  const router = useRouter();
  useRefreshOnFocus(chain.refresh);
  const notifications = useNotificationOffer(chain.mandate != null);
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const today = todaysAgentDecisions(chain.rows, chain.nowMs);
  const mandate = chain.mandate;
  const index =
    mandate != null ? chain.mandates.findIndex((row) => row.address === mandate.address) : -1;
  const ratio = mandate ? spendRatio(mandate.spent, mandate.cap) : 0;
  const left = mandate ? timeLeftParts(mandate.expiresAt, nowSec) : null;
  const remaining = mandate ? mandateRemaining(mandate) : 0n;
  const bars = mandate ? barUnits(remaining, mandate.cap) : { remaining: 0, cap: 1 };
  const clock = mandate ? ruleDay(openedAtSec(chain.rows), mandate.expiresAt, nowSec) : null;
  const streak = refusalStreak(chain.rows);
  const listed = today.filter((row) => isListedDecision(row.kind));
  const live = mandate ? isActive(mandate, nowSec) : false;
  const liveCount = liveMandateCount(chain.mandates, chain.nowMs);
  const spentShare = Math.round(ratio * 100);
  const mint = mandate?.mint;
  const remainingText = formatTokenDisplay(remaining, chain.decimals, mint);
  const capText = formatTokenDisplay(mandate?.cap ?? 0n, chain.decimals, mint);
  const spentText = formatTokenDisplay(mandate?.spent ?? 0n, chain.decimals, mint);
  const perText = formatTokenDisplay(mandate?.perTxMax ?? 0n, chain.decimals, mint);
  const tokenNote = mainnetPreviewNote(mint, chain.config?.explorerCluster ?? null) ?? devnetTestTokenNote(mint, chain.config?.explorerCluster ?? null);
  const offerFaucet =
    chain.mandateStatus === 'empty' &&
    wallet.ownerPublicKey != null &&
    showDevnetUsdcFaucet({
      cluster: chain.config?.explorerCluster,
      mint: chain.config?.mint,
    });

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  return (
    <Screen
      header={
        <TopBar
          leading={<CatchMark size={20} />}
          accessory={
            <>
              {chain.config ? <ClusterPill cluster={chain.config.explorerCluster} /> : null}
              {showRulePill(chain.mandateStatus, chain.loading) ? (
                <RuleReadPill face={tabPillFace(chain.mandateStatus, chain.nowMs)} liveCount={liveCount} />
              ) : null}
            </>
          }
        />
      }
      refreshing={chain.loading}
      onRefresh={onRefresh}
    >
      <ConnectGate>
        <HoldEntry cluster={wallet.cluster} />
        {chain.configError ? <EmptyState>{chain.configError}</EmptyState> : null}
        {chain.mandateStatus === 'empty' ? (
          <View style={styles.block}>
            <OpenFirstRule onOpen={() => router.push('/rule/new')} />
            {offerFaucet && wallet.ownerPublicKey ? <GetDevnetUsdc owner={wallet.ownerPublicKey} /> : null}
          </View>
        ) : (
          <ReadState
            status={chain.mandateStatus}
            staleError={chain.error}
            empty="No rule on chain for this owner yet. This screen reads real history only and never invents rows."
          />
        )}
        {chain.mandateStatus === 'present' && !mandate && chain.tradeRule ? (
          <View style={styles.block}>
            <ContextBar
              title={displayPurpose(chain.tradeRule.purpose)}
              subtitle={`${tradePairLabel(chain.tradeRule)} · agent ${truncateAddress(chain.tradeRule.agent)}`}
              onSwitch={() => router.push('/(tabs)/rules')}
            />
            <Button
              label="Open this trade rule"
              invert={false}
              onPress={() => router.push(`/rule/${chain.tradeRule?.address}`)}
            />
          </View>
        ) : null}
        {chain.mandateStatus === 'present' && mandate && left ? (
          <View style={styles.block}>
            {notifications.show ? (
              <View style={styles.block}>
                <EmptyState>{NOTIFICATIONS_OFF_LINE}</EmptyState>
                <Button
                  label="Turn notifications on"
                  accessibilityLabel="Turn notifications on"
                  invert={false}
                  onPress={() => {
                    void notifications.turnOn();
                  }}
                />
              </View>
            ) : null}
            <ContextBar
              title={displayPurpose(mandate.purpose)}
              subtitle={`rule ${index + 1} of ${chain.mandates.length} · agent ${truncateAddress(mandate.agent)}`}
              onSwitch={() => router.push('/(tabs)/rules')}
            />
            {tokenNote ? <Text style={styles.tokenNote}>{tokenNote}</Text> : null}
            {live ? (
              <HomeStay
                mandate={mandate}
                decimals={chain.decimals}
                nowSec={nowSec}
                onRenew={() => router.push(`/renew/${mandate.address}`)}
                onQuietNote={() => router.push('/settings/quiet-note')}
              />
            ) : null}
            <SpendBoard
              kicker="Your agent can still spend"
              aside={`Pays only ${truncateAddress(mandate.merchant)}`}
              remainingText={remainingText}
              ofText={`of ${capText}`}
              spentText={spentText}
              spentCaption="spent so far"
              remaining={bars.remaining}
              cap={bars.cap}
              accessibilityLabel={`${remainingText} left of ${capText}. ${spentShare} percent of the total is spent.`}
              leftCaption={`1 block is one share of ${capText}`}
              rightCaption={`Most per payment: ${perText}`}
            />
            <View style={styles.pair}>
              <DayClock
                day={clock?.day ?? null}
                total={clock?.total ?? null}
                leftValue={left.value}
                leftLabel={left.label}
                ended={left.label === 'expired'}
              />
              <View style={styles.paid}>
                <ScoreReel
                  value={mandate.spendCount}
                  tone="paid"
                  height={48}
                  accessibilityLabel={`${mandate.spendCount} payments paid by your agent`}
                />
                <View style={styles.paidCopy}>
                  <Text style={styles.kicker}>Paid</Text>
                  <Text style={styles.paidTitle}>by your agent</Text>
                  <Text style={styles.hint}>all within the rule</Text>
                </View>
              </View>
            </View>
            <StreakCall count={streak} />
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Latest decisions</Text>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="See all"
                onPress={() => router.push('/(tabs)/decisions')}
                style={styles.seeAll}
              >
                <Text style={styles.seeAllText}>See all</Text>
              </Pressable>
            </View>
            {listed.length === 0 ? (
              <EmptyState>
                No payments, refusals, or overrides on this rule today. This screen never invents
                rows.
              </EmptyState>
            ) : (
              <View style={styles.list}>
                {listed.map((row, i) => (
                  <LatestDecision
                    key={`${row.nonce.toString()}-${row.kind}-${i}`}
                    row={row}
                    decimals={chain.decimals}
                    perTxMax={mandate.perTxMax}
                    mandateAddress={mandate.address}
                    payee={mandate.merchant}
                    mint={mandate.mint}
                    remainingText={remainingText}
                    fresh={i === 0 && row.kind === KIND_REFUSED}
                    last={i === listed.length - 1}
                  />
                ))}
              </View>
            )}
          </View>
        ) : null}
      </ConnectGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: space.xl,
    alignSelf: 'stretch',
  },
  pair: {
    flexDirection: 'row',
    gap: space.lg,
  },
  paid: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.xl,
    paddingHorizontal: space.xxl,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  paidCopy: {
    flex: 1,
    gap: 2,
  },
  paidTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.bone,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  tokenNote: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.body,
  },
  hint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  seeAll: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  seeAllText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.brass,
  },
  list: {
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
});
