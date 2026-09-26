import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

import { CatchMark } from '../../components/backglass/CatchMark';
import { HoldEntry } from '../../components/hold/HoldEntry';
import { Button } from '../../components/Button';
import { ClusterPill } from '../../components/daily/ClusterPill';
import { ConnectGate } from '../../components/ConnectGate';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { RuleListItem } from '../../components/RuleListItem';
import { RuleReadPill } from '../../components/RuleReadPill';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts, radii, space } from '../../components/theme';
import { liveMandateCount, showRulePill, tabPillFace } from '../../lib/mandateRead';
import { displayPurpose, rulesHeading } from '../../lib/ruleView';
import { PAYEE_NOT_IN_RULESET, PAYEE_PREFILL, RULESET_ENVELOPE } from '../../lib/ruleset';
import { TEMPLATES } from '../../lib/templates';
import { poolByAddress } from '../../lib/pools';
import { formatTokenDisplay, rulesTokenSummary, tokenSymbol } from '../../lib/tokens';
import { isTradeActive, tradePairLabel } from '../../lib/tradeRule';
import { useChain } from '../../lib/useChain';
import { useRefreshOnFocus } from '../../lib/useRefreshOnFocus';
import { useRulesets } from '../../lib/useRulesets';
import { useWallet } from '../../lib/useWallet';

export default function RulesScreen() {
  const chain = useChain();
  useRefreshOnFocus(chain.refresh);
  const wallet = useWallet();
  const rulesets = useRulesets();
  const router = useRouter();
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const tradeRules = chain.tradeRules ?? [];
  const selected = chain.mandate?.address ?? chain.tradeRule?.address ?? null;
  const liveCount =
    liveMandateCount(chain.mandates, chain.nowMs) +
    tradeRules.filter((rule) => isTradeActive(rule, nowSec)).length;

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  const heading = rulesHeading([...chain.mandates, ...tradeRules]);
  const tokenLine = rulesTokenSummary([
    ...chain.mandates.map((row) => row.mint),
    ...tradeRules.map((rule) => rule.inMint),
  ]);
  const rulesetUnit = chain.config?.mint ? ` ${tokenSymbol(chain.config.mint)}` : '';

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
        <ReadState
          status={chain.mandateStatus}
          staleError={chain.error}
          empty="Nothing on chain for this owner yet. A template is an empty starting point. This screen does not invent a rule."
        />

        {chain.mandateStatus === 'present' || chain.mandateStatus === 'empty' ? (
          <View style={styles.block}>
            <View style={styles.section}>
              <Text style={styles.kicker}>Your rules</Text>
              <Text style={styles.meta}>{`${liveCount} active`}</Text>
            </View>
            <Text style={styles.h2}>{heading}</Text>
            {tokenLine ? <Text style={styles.tokenLine}>{tokenLine}</Text> : null}
            <EmptyState>
              Each rule has its own agent key and its own history. A rule opened from this app keeps its
              budget in its own token account. Pick one and Overview and Decisions are about it.
            </EmptyState>

            <View style={styles.list}>
              {chain.mandates.map((row) => (
                <RuleListItem
                  key={row.address}
                  mandate={row}
                  decimals={chain.decimals}
                  nowSec={nowSec}
                  current={row.address === selected}
                  onPress={() => {
                    void chain.selectMandate(row.address);
                    router.push(`/rule/${row.address}`);
                  }}
                />
              ))}
              {tradeRules.map((rule) => {
                const known = poolByAddress(rule.pool);
                const decimals = known?.inputDecimals ?? chain.decimals;
                return (
                  <Pressable
                    key={rule.address}
                    accessibilityRole="button"
                    accessibilityLabel={`${displayPurpose(rule.purpose)}, ${tradePairLabel(rule)}`}
                    onPress={() => {
                      void chain.selectMandate(rule.address);
                      router.push(`/rule/${rule.address}`);
                    }}
                    style={styles.tpl}
                  >
                    <View style={styles.tplText}>
                      <Text style={styles.tplName}>{displayPurpose(rule.purpose)}</Text>
                      <Text style={styles.tplSum}>
                        {`${tradePairLabel(rule)}. ${formatTokenDisplay(rule.spent, decimals, rule.inMint)} of ${formatTokenDisplay(rule.cap, decimals, rule.inMint)} sent.`}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Scan a request"
                onPress={() => router.push('/scan?target=request')}
                style={styles.scan}
              >
                <Svg width={20} height={20} viewBox="0 0 24 24">
                  <Path
                    d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"
                    fill="none"
                    stroke={colors.forest}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </Svg>
                <Text style={styles.scanText}>Scan a request</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Write a rule"
                onPress={() => router.push('/rule/new')}
                style={styles.write}
              >
                <Text style={styles.writeText}>Write a rule</Text>
              </Pressable>
            </View>

            <View style={styles.section}>
              <Text style={styles.kicker}>Starting points</Text>
              <Text style={styles.badge}>Templates</Text>
            </View>
            <Text style={styles.note}>
              Picking one sets no rule. You fill in the numbers, then sign in Seed Vault.
            </Text>
            <View style={styles.templates}>
              {TEMPLATES.map((template, index) => (
                <Pressable
                  key={template.id}
                  accessibilityRole="button"
                  accessibilityLabel={template.title}
                  onPress={() => router.push(`/rule/new?template=${template.id}`)}
                  style={[styles.tpl, index < TEMPLATES.length - 1 && styles.tplBorder]}
                >
                  <View style={styles.tplText}>
                    <Text style={styles.tplName}>{template.title}</Text>
                    <Text style={styles.tplSum}>{template.summary}</Text>
                  </View>
                  <Text style={styles.use}>use</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.kicker}>Rulesets on this phone</Text>
            <EmptyState>
              {`${RULESET_ENVELOPE} ${PAYEE_NOT_IN_RULESET} ${PAYEE_PREFILL} Applying one to a new agent is one action. The ruleset itself is not on chain. Its name and version are written into the purpose, which is on chain and cannot change after the rule is opened.`}
            </EmptyState>
            {rulesets.rulesets.length === 0 ? (
              <EmptyState>No rulesets saved on this phone yet.</EmptyState>
            ) : (
              rulesets.rulesets.map((set) => (
                <Pressable
                  key={`${set.id}-v${set.version}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${set.name} version ${set.version}`}
                  onPress={() =>
                    router.push(`/rule/new?ruleset=${encodeURIComponent(set.id)}&version=${set.version}`)
                  }
                  style={styles.tpl}
                >
                  <View style={styles.tplText}>
                    <Text style={styles.tplName}>
                      {set.name} v{set.version}
                    </Text>
                    <Text style={styles.tplSum}>
                      {`${set.cap}${rulesetUnit} total, ${set.perTxMax}${rulesetUnit} per payment, ${set.expiryDays} days. Apply to a new agent.`}
                    </Text>
                  </View>
                  <Text style={styles.use}>apply</Text>
                </Pressable>
              ))
            )}
            <Button
              label="Author a ruleset"
              accessibilityLabel="Author a ruleset"
              invert={false}
              onPress={() => router.push('/rule/new?ruleset=new')}
            />

            <Button
              label={wallet.busy ? 'Disconnecting...' : 'Disconnect'}
              accessibilityLabel="Disconnect"
              busy={wallet.busy}
              invert={false}
              quiet
              onPress={() => {
                void wallet.disconnect();
              }}
            />
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
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  meta: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  h2: {
    fontFamily: fonts.serifRegular,
    fontSize: 28,
    lineHeight: 32,
    color: colors.bone,
  },
  tokenLine: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.body,
  },
  list: {
    gap: space.lg,
  },
  actions: {
    flexDirection: 'row',
    gap: space.lg,
  },
  scan: {
    flex: 1,
    height: 56,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
  },
  scanText: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.forest,
  },
  write: {
    flex: 1,
    height: 56,
    borderRadius: radii.cta,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.55)',
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  writeText: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    lineHeight: 18,
    color: colors.bone,
  },
  badge: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.muted,
    borderWidth: 1,
    borderColor: 'rgba(237, 230, 214, 0.22)',
    borderRadius: radii.pill,
    paddingHorizontal: space.md,
    paddingVertical: 3,
  },
  note: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.muted,
  },
  templates: {
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  tpl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    paddingVertical: space.lg,
    paddingHorizontal: space.xxl,
    minHeight: 44,
  },
  tplBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  tplText: {
    flex: 1,
    gap: 2,
  },
  tplName: {
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.bone,
  },
  tplSum: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  use: {
    fontFamily: fonts.sansSemibold,
    fontSize: 12,
    lineHeight: 16,
    color: colors.brass,
  },
});
