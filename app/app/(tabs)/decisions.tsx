import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Pill } from '../../components/backglass/Pill';
import { CatchMark } from '../../components/backglass/CatchMark';
import { ConnectGate } from '../../components/ConnectGate';
import { DecisionRow } from '../../components/DecisionRow';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { RuleReadPill } from '../../components/RuleReadPill';
import { ClusterPill, Kicker, Rise } from '../../components/records/chrome';
import { relativeDay } from '../../components/records/copy';
import { Screen } from '../../components/Screen';
import { colors, fonts, radii, touchTarget } from '../../components/theme';
import { KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import { KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, LEDGER_CAPACITY } from '../../lib/constants';
import { decisionTotals, groupByLocalDay, isListedDecision, newestFirst } from '../../lib/format';
import { formatTokenDisplay } from '../../lib/tokens';
import { mandateRemaining } from '../../lib/mandate';
import { liveMandateCount, showRulePill, tabPillFace } from '../../lib/mandateRead';
import type { LedgerRow } from '../../lib/ring';
import { displayPurpose } from '../../lib/ruleView';
import { useChain } from '../../lib/useChain';
import { useRefreshOnFocus } from '../../lib/useRefreshOnFocus';
import { truncateAddress } from '../../lib/wallet';

type FilterId = 'all' | 'paid' | 'refused' | 'allowed' | 'advisory';

const FILTERS: { id: FilterId; label: string; dot?: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'paid', label: 'Paid', dot: colors.paid },
  { id: 'refused', label: 'Refused', dot: colors.refused },
  { id: 'allowed', label: 'Allowed once', dot: colors.amber },
  { id: 'advisory', label: "Agent's own declines", dot: 'none' },
];

function matches(row: LedgerRow, filter: FilterId): boolean {
  if (filter === 'paid') {
    return row.kind === KIND_PAID;
  }
  if (filter === 'refused') {
    return row.kind === KIND_REFUSED;
  }
  if (filter === 'allowed') {
    return row.kind === KIND_OVERRIDE;
  }
  if (filter === 'advisory') {
    return row.kind === KIND_ADVISORY_DECLINE;
  }
  return true;
}

export default function DecisionsScreen() {
  const chain = useChain();
  useRefreshOnFocus(chain.refresh);
  const router = useRouter();
  const rpcUrl = chain.config?.rpcUrl ?? '';
  const cluster = chain.config?.explorerCluster ?? 'devnet';
  const mandate = chain.mandate;
  const [filter, setFilter] = useState<FilterId>('all');
  const [showOlder, setShowOlder] = useState(false);
  const charges = useMemo(
    () => newestFirst(chain.rows).filter((row) => isListedDecision(row.kind)),
    [chain.rows],
  );
  const shown = useMemo(() => charges.filter((row) => matches(row, filter)), [charges, filter]);
  const totals = decisionTotals(charges);
  const days = useMemo(() => groupByLocalDay(shown), [shown]);
  const visibleDays = showOlder ? days : days.slice(0, 2);

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  return (
    <Screen
      header={
        <Rise delayMs={50}>
          <View style={styles.mast}>
            <View style={styles.brand}>
              <CatchMark size={20} />
              <Text style={styles.word}>Veto</Text>
              <ClusterPill cluster={cluster} />
            </View>
            <View style={styles.mastActions}>
              {showRulePill(chain.mandateStatus, chain.loading) ? (
                <RuleReadPill
                  face={tabPillFace(chain.mandateStatus, chain.nowMs)}
                  liveCount={liveMandateCount(chain.mandates, chain.nowMs)}
                />
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Help"
                onPress={() => router.push('/help')}
                style={styles.hit}
              >
                <Text style={styles.help}>Help</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Export the record"
                onPress={() => router.push('/share')}
                style={styles.hit}
              >
                <Text style={styles.help}>Export</Text>
              </Pressable>
            </View>
          </View>
        </Rise>
      }
      refreshing={chain.loading}
      onRefresh={onRefresh}
    >
      <ConnectGate>
        {chain.configError ? <EmptyState>{chain.configError}</EmptyState> : null}
        <ReadState
          status={chain.mandateStatus}
          staleError={chain.error}
          empty="No rule on chain for this owner. Only decisions that actually ran appear here. This screen never invents rows."
        />
        {chain.snapshot && chain.snapshot.total > chain.snapshot.entries.length ? (
          <EmptyState>
            {`Showing the last ${LEDGER_CAPACITY} of ${chain.snapshot.total} decisions; the ring on chain keeps ${LEDGER_CAPACITY}. Export rebuilds the trail from transaction logs.`}
          </EmptyState>
        ) : null}
        {chain.mandateStatus === 'present' && !mandate && chain.tradeRule ? (
          <View style={styles.block}>
            <Kicker aside="Newest first">Decisions under the rule</Kicker>
            <Text style={styles.ruleTitle}>{displayPurpose(chain.tradeRule.purpose)}</Text>
            {shown.map((row) => (
              <DecisionRow
                key={`${row.kind}-${row.nonce.toString()}-${row.ts.toString()}`}
                row={row}
                decimals={chain.decimals}
                cluster={cluster}
                rpcUrl={rpcUrl}
                mandateAddress={chain.tradeRule?.address ?? ''}
                perTxMax={chain.tradeRule?.perTradeMax}
                mint={chain.tradeRule?.inMint}
              />
            ))}
          </View>
        ) : null}
        {chain.mandateStatus === 'present' && mandate ? (
          <View style={styles.block}>
            <Rise delayMs={180}>
              <Kicker aside="Newest first">Decisions under the rule</Kicker>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Change rule. Now showing ${displayPurpose(mandate.purpose)}`}
                onPress={() => router.push('/(tabs)/rules')}
                style={styles.rule}
              >
                <Text style={styles.ruleGlyph}>◆</Text>
                <View style={styles.ruleCopy}>
                  <Text style={styles.ruleTitle} numberOfLines={1}>
                    {displayPurpose(mandate.purpose)}
                  </Text>
                  <Text style={styles.ruleSub}>
                    {chain.mandates.length === 1 ? 'Your only rule' : `${chain.mandates.length} rules`}.{' '}
                    {formatTokenDisplay(mandateRemaining(mandate), chain.decimals, mandate.mint, 'floor')} left of your{' '}
                    {formatTokenDisplay(mandate.cap, chain.decimals, mandate.mint)} total. Agent{' '}
                    {truncateAddress(mandate.agent)}.
                  </Text>
                </View>
                <Text style={styles.chevron}>⌄</Text>
              </Pressable>
            </Rise>
            <Rise delayMs={300}>
              <View accessibilityRole="radiogroup" style={styles.filters}>
                {FILTERS.map((item) => (
                  <Pill
                    key={item.id}
                    label={item.label}
                    dot={item.dot}
                    selected={filter === item.id}
                    onPress={() => {
                      setFilter(item.id);
                      setShowOlder(false);
                    }}
                  />
                ))}
              </View>
              <Text style={styles.totals}>
                {totals.paid} paid, {totals.refused} refused, {totals.override} allowed once
              </Text>
            </Rise>
            {charges.length === 0 ? (
              <EmptyState>
                No decisions on this rule yet. This screen reads the on-chain ring and never invents rows.
              </EmptyState>
            ) : shown.length === 0 ? (
              <EmptyState>
                No decisions match this filter. This screen reads the on-chain ring and never invents rows.
              </EmptyState>
            ) : (
              <View style={styles.days}>
                {visibleDays.map((day) => (
                  <View key={day.key} style={styles.dayCard}>
                    <Text style={styles.day}>
                      {relativeDay(day.rows[0]?.ts ?? 0n, chain.nowMs).toUpperCase()}
                    </Text>
                    {day.rows.map((row, index) => (
                      <DecisionRow
                        key={`${row.ts.toString()}-${row.kind}-${row.nonce.toString()}-${index}`}
                        row={row}
                        decimals={chain.decimals}
                        cluster={cluster}
                        rpcUrl={rpcUrl}
                        mandateAddress={mandate.address}
                        perTxMax={mandate.perTxMax}
                        mint={mandate.mint}
                        payee={mandate.merchant}
                        nowMs={chain.nowMs}
                        bare
                        divider={index > 0}
                        fresh={index === 0 && row.kind === KIND_REFUSED && relativeDay(row.ts, chain.nowMs) === 'Today'}
                      />
                    ))}
                  </View>
                ))}
                {days.length > 2 && !showOlder ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Show older decisions"
                    onPress={() => setShowOlder(true)}
                    style={styles.older}
                  >
                    <Text style={styles.olderText}>Show older decisions</Text>
                  </Pressable>
                ) : null}
              </View>
            )}
          </View>
        ) : null}
      </ConnectGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mast: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  word: {
    fontFamily: fonts.serif,
    fontSize: 20,
    lineHeight: 24,
    color: colors.bone,
  },
  mastActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  hit: {
    width: touchTarget,
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  help: {
    color: colors.body,
    fontFamily: fonts.sansSemibold,
    fontSize: 12,
  },
  block: {
    gap: 10,
    alignSelf: 'stretch',
  },
  rule: {
    marginTop: 6,
    minHeight: 52,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 12,
    paddingVertical: 6,
  },
  ruleGlyph: {
    color: colors.brass,
    fontSize: 16,
  },
  ruleCopy: {
    flex: 1,
    gap: 2,
  },
  ruleTitle: {
    fontFamily: fonts.serifItalic,
    fontSize: 16,
    lineHeight: 20,
    color: colors.bone,
  },
  ruleSub: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  chevron: {
    color: colors.muted,
    fontSize: 16,
  },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  totals: {
    marginTop: 8,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  days: {
    gap: 10,
  },
  dayCard: {
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  day: {
    height: 26,
    paddingHorizontal: 14,
    textAlignVertical: 'center',
    lineHeight: 26,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    color: colors.muted,
    borderBottomWidth: 1,
    borderBottomColor: colors.boneLine,
  },
  older: {
    height: touchTarget,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  olderText: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 14,
  },
});
