import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { AdvisoryDeclineDetail } from '../../components/AdvisoryDecline';
import { ConnectGate } from '../../components/ConnectGate';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { AllowOnce } from '../../components/records/AllowOnce';
import { GhostButton, Glow, Rise, ScreenHeader, SealNote } from '../../components/records/chrome';
import { barSplit, decisionWhen, refusalBody, whyRefused } from '../../components/records/copy';
import { Screen } from '../../components/Screen';
import { colors, fonts, radii } from '../../components/theme';
import { KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import {
  KIND_OVERRIDE,
  KIND_PAID,
  KIND_REFUSED,
  REASON_OUTPUT_ACCOUNT_NOT_ALLOWED,
  REASON_OVER_PER_TX_MAX,
  REASON_POOL_NOT_ALLOWED,
} from '../../lib/constants';
import { findLedgerDecision, parseDecisionId } from '../../lib/exportRecord';
import { useOverrideGrant } from '../../lib/useOverrideGrant';
import { explorerTxUrl, formatClock, formatUnix, isListedDecision } from '../../lib/format';
import { formatTokenAmount } from '../../lib/tokens';
import { mandateRemaining } from '../../lib/mandate';
import { tradeDecisionDetail, tradeDecisionTitle } from '../../lib/tradeCopy';
import { tradeRuleAsMandate } from '../../lib/tradeRule';
import { mayClaimAbsence } from '../../lib/mandateRead';
import { paidDecisionBody } from '../../lib/notify';
import { nonceSequence, overrideRowView, sequenceLine } from '../../lib/override';
import { renderReason } from '../../lib/reasons';
import { useChain } from '../../lib/useChain';
import { payeeLabel, truncateAddress } from '../../lib/wallet';

export default function DecisionDetailScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ? decodeURIComponent(rawId) : '';
  const parsed = id ? parseDecisionId(id) : null;
  const chain = useChain();
  const router = useRouter();
  const rpcUrl = chain.config?.rpcUrl ?? '';
  const cluster = chain.config?.explorerCluster ?? 'devnet';
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const loadedAddress = chain.mandate?.address ?? chain.tradeRule?.address ?? null;
  const row = findLedgerDecision(chain.rows, parsed, loadedAddress);
  const trade =
    parsed != null
      ? (chain.tradeRules ?? []).find((item) => item.address === parsed.mandate) ??
        (chain.tradeRule?.address === parsed.mandate ? chain.tradeRule : null)
      : chain.tradeRule;
  const mandate =
    parsed != null
      ? chain.mandates.find((item) => item.address === parsed.mandate) ??
        (chain.mandate?.address === parsed.mandate ? chain.mandate : null) ??
        (trade ? tradeRuleAsMandate(trade) : null)
      : chain.mandate ?? (trade ? tradeRuleAsMandate(trade) : null);
  const grant = useOverrideGrant({
    row,
    mandate,
    nowSec,
    probeOverride: chain.probeOverride,
    grantOverride: chain.grantOverride,
  });

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  const wantedMandate = parsed?.mandate ?? null;
  const { loading, mandateStatus, mandates, selectMandate } = chain;
  const wantedIsLoaded = wantedMandate
    ? mandates.some((item) => item.address === wantedMandate) ||
      (chain.tradeRules ?? []).some((item) => item.address === wantedMandate)
    : false;
  const switching =
    wantedMandate != null &&
    loadedAddress !== wantedMandate &&
    (loading || wantedIsLoaded || mandateStatus === 'not-read');

  useEffect(() => {
    if (!wantedMandate || !wantedIsLoaded) {
      return;
    }
    if (loadedAddress === wantedMandate || loading) {
      return;
    }
    void selectMandate(wantedMandate);
  }, [wantedMandate, wantedIsLoaded, loadedAddress, loading, selectMandate]);

  const onShare = () => {
    if (!parsed) {
      return;
    }
    router.push(`/share?id=${encodeURIComponent(id)}`);
  };

  const onExplorer = () => {
    if (!row?.signature) {
      return;
    }
    void Linking.openURL(explorerTxUrl(row.signature, cluster, rpcUrl));
  };

  const seq = row && row.kind !== KIND_ADVISORY_DECLINE ? nonceSequence(chain.rows, row.nonce) : null;
  const seqText = seq ? sequenceLine(seq, chain.decimals, mandate?.mint) : null;
  const overrideView = row && row.kind === KIND_OVERRIDE ? overrideRowView(row, chain.decimals, mandate?.mint) : null;
  const when = row ? decisionWhen(row.ts, chain.nowMs) : '';
  const payee = payeeLabel(mandate?.merchant);
  // A charge writes the destination token account as counterparty. The payee is the rule wallet.
  const tokenAccount = chargeTokenAccount(row, mandate?.merchant);

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <Glow />
      <ScreenHeader
        title="Decision"
        cluster={cluster}
        backLabel="Decisions"
        onBack={() => router.back()}
        onHelp={() => router.push('/help')}
      />
      <ConnectGate>
        {switching || !mayClaimAbsence(chain.mandateStatus) ? (
          <ReadState
            status={switching ? 'not-read' : chain.mandateStatus}
            empty="This decision is not on the ring for the selected rule. The app does not invent one."
          />
        ) : !row || !isListedDecision(row.kind) ? (
          <EmptyState>
            This decision is not on the ring for the selected rule. The app does not invent one.
          </EmptyState>
        ) : (
          <View style={styles.block}>
            {row.kind === KIND_ADVISORY_DECLINE ? (
              <AdvisoryDeclineDetail
                when={`${formatUnix(row.ts)} · ${formatClock(row.ts)}`}
                reason={row.reasonText}
                amount={formatTokenAmount(row.amount, chain.decimals, mandate?.mint)}
              />
            ) : row.kind === KIND_REFUSED ? (
              <Rise delayMs={80}>
                <RefusedBody
                  row={row}
                  decimals={chain.decimals}
                  perTxMax={mandate?.perTxMax}
                  mint={mandate?.mint}
                  when={when}
                  payee={payee}
                />
              </Rise>
            ) : row.kind === KIND_OVERRIDE && overrideView ? (
              <Rise delayMs={80}>
                <View style={styles.stack}>
                  <StatusPill label="Allowed once" tone="allowed" when={when} />
                  <Text style={styles.headline}>Allowed once.</Text>
                  <Text style={styles.body}>
                    {overrideView.say} {overrideView.italic}. {overrideView.why}
                  </Text>
                </View>
              </Rise>
            ) : (
              <Rise delayMs={80}>
                <View style={styles.stack}>
                  <StatusPill label={row.family === 'trade' ? 'Traded' : 'Paid'} tone="paid" when={when} />
                  <Text style={styles.headline}>
                    {row.family === 'trade'
                      ? `${tradeDecisionTitle({
                          kind: row.kind,
                          amountIn: row.amount,
                          amountOut: row.amountOut ?? 0n,
                          inDecimals: chain.decimals,
                          outDecimals: row.outDecimals ?? chain.decimals,
                          inMint: mandate?.mint,
                          outMint: row.outMint,
                          reason: row.reason,
                          counterparty: row.counterparty,
                          perTradeMax: mandate?.perTxMax,
                        })}.`
                      : `Paid ${formatTokenAmount(row.amount, chain.decimals, mandate?.mint)}.`}
                  </Text>
                  <Text style={styles.body}>
                    {row.family === 'trade' && mandate
                      ? tradeDecisionDetail({
                          amountIn: row.amount,
                          amountOut: row.amountOut,
                          inDecimals: chain.decimals,
                          outDecimals: row.outDecimals ?? chain.decimals,
                          inMint: mandate.mint,
                          outMint: row.outMint,
                          perTradeMax: mandate.perTxMax,
                        })
                      : mandate
                        ? paidDecisionBody({
                            amount: row.amount,
                            decimals: chain.decimals,
                            perTxMax: mandate.perTxMax,
                            merchant: mandate.merchant,
                            mint: mandate.mint,
                          })
                        : `${formatTokenAmount(row.amount, chain.decimals, undefined)}. The payee for this rule is the rule.`}
                  </Text>
                </View>
              </Rise>
            )}

            {seqText ? (
              <View style={styles.sequence}>
                <Text style={styles.kicker}>The record of this request</Text>
                <Text style={styles.body}>{seqText}</Text>
              </View>
            ) : null}

            <SealNote
              linkLabel="See it on the blockchain"
              onPress={onExplorer}
              linkDisabled={!row.signature}
            >
              Saved on the blockchain with the reason and the time. Anyone can check it.
            </SealNote>

            <View style={styles.proofs}>
              <Text style={styles.kicker}>Proof</Text>
              {row.kind === KIND_ADVISORY_DECLINE ? null : (
                <ProofRow
                  label="program"
                  value={chain.config?.programId ? truncateAddress(chain.config.programId) : 'from config'}
                />
              )}
              <ProofRow label="rule" value={mandate ? truncateAddress(mandate.address) : 'unknown'} />
              <ProofRow
                label="transaction"
                value={row.signature ? truncateAddress(row.signature) : 'not returned by this RPC'}
                ok={Boolean(row.signature)}
              />
              {row.slot != null ? <ProofRow label="slot" value={String(row.slot)} /> : null}
              {row.kind === KIND_ADVISORY_DECLINE ? null : (
                <ProofRow label="payee" value={payee} />
              )}
              {tokenAccount ? <ProofRow label="Payee token account" value={tokenAccount} /> : null}
            </View>

            {row.kind === KIND_REFUSED ? (
              <AllowOnce
                view={grant}
                decimals={chain.decimals}
                submitHeld={chain.submitHeld}
                payee={payee}
                perTxMax={mandate?.perTxMax ?? 0n}
                remaining={mandate ? mandateRemaining(mandate) : 0n}
                mint={mandate?.mint}
              />
            ) : null}

            {row.kind === KIND_ADVISORY_DECLINE ? null : (
              <GhostButton label="Share this decision" onPress={onShare} />
            )}
            <Text style={styles.foot}>Allowing signs in Seed Vault. Veto never sees your key.</Text>
          </View>
        )}
      </ConnectGate>
    </Screen>
  );
}

function chargeTokenAccount(
  row: { kind: number; counterparty: string } | null | undefined,
  merchant: string | null | undefined,
): string | null {
  if (!row || (row.kind !== KIND_PAID && row.kind !== KIND_REFUSED)) {
    return null;
  }
  const account = row.counterparty.trim();
  const wallet = merchant?.trim() ?? '';
  if (!account || account === wallet) {
    return null;
  }
  return truncateAddress(account);
}

function RefusedBody({
  row,
  decimals,
  perTxMax,
  mint,
  when,
  payee,
}: {
  row: NonNullable<ReturnType<typeof findLedgerDecision>>;
  decimals: number;
  perTxMax?: bigint;
  mint?: string | null;
  when: string;
  payee: string;
}) {
  const asked = formatTokenAmount(row.amount, decimals, mint);
  const limit = perTxMax != null ? formatTokenAmount(perTxMax, decimals, mint) : null;
  const reason = renderReason(row.reason, row.suggestedOverride, decimals, mint, row.family === 'trade' ? 'trade' : 'payment');
  const split = perTxMax != null ? barSplit(row.amount, perTxMax) : null;
  const needed =
    row.reason === REASON_OVER_PER_TX_MAX && row.suggestedOverride > 0n
      ? formatTokenAmount(row.suggestedOverride, decimals, mint)
      : 'No one-time allowance would have cleared this.';
  return (
    <View style={styles.stack}>
      <StatusPill label="Refused" tone="refused" when={when} />
      <Text style={styles.headline}>No money moved.</Text>
      <Text style={styles.body}>
        {refusalBody({
          amount: row.amount,
          decimals,
          perTxMax,
          reason: row.reason,
          suggestedOverride: row.suggestedOverride,
          mint,
          unit: row.family === 'trade' ? 'trade' : 'payment',
        })}
      </Text>
      <View style={styles.compare}>
        <View style={styles.compareTop}>
          <View style={styles.compareCol}>
            <Text style={styles.kicker}>Your agent asked</Text>
            <Text style={[styles.figure, { color: colors.refused }]}>{asked}</Text>
          </View>
          <View style={styles.compareColEnd}>
            <Text style={styles.kicker}>{row.family === 'trade' ? 'Your limit per trade' : 'Your limit per payment'}</Text>
            <Text style={[styles.figure, { color: colors.brass }]}>{limit ?? 'on the rule'}</Text>
          </View>
        </View>
        {split ? <LimitTrack allowedPct={split.allowedPct} overPct={split.overPct} /> : null}
        <View style={styles.grid}>
          <Fact
            label={row.family === 'trade'
              ? (row.reason === REASON_OUTPUT_ACCOUNT_NOT_ALLOWED || row.reason === REASON_POOL_NOT_ALLOWED
                ? 'Tried account' : 'Output account')
              : 'To payee'}
            value={
              row.family === 'trade' &&
              (row.reason === REASON_OUTPUT_ACCOUNT_NOT_ALLOWED || row.reason === REASON_POOL_NOT_ALLOWED)
                ? truncateAddress(row.counterparty)
                : payee
            }
          />
          <Fact label="Money moved" value={formatTokenAmount(0n, decimals, mint)} />
          <Fact
            label="Why it was refused"
            value={whyRefused({
              reason: row.reason,
              decimals,
              perTxMax,
              mint,
              unit: row.family === 'trade' ? 'trade' : 'payment',
              fallback: reason.text,
            })}
          />
          <Fact label="Needed to allow it" value={needed} />
        </View>
      </View>
    </View>
  );
}

function LimitTrack({ allowedPct, overPct }: { allowedPct: number; overPct: number }) {
  return (
    <View style={styles.trackWrap}>
      <View style={styles.track}>
        <View style={[styles.allowed, { width: `${allowedPct}%` }]} />
        {overPct > 0 ? <View style={[styles.over, { width: `${overPct}%` }]} /> : null}
      </View>
      <View style={[styles.marker, { left: `${allowedPct}%` }]} />
      <Text style={[styles.limitLabel, { left: `${allowedPct}%` }]}>LIMIT</Text>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function StatusPill({
  label,
  tone,
  when,
}: {
  label: string;
  tone: 'refused' | 'paid' | 'allowed';
  when: string;
}) {
  const color = tone === 'paid' ? colors.paid : tone === 'allowed' ? colors.amber : colors.refused;
  return (
    <View style={styles.statusRow}>
      <View style={[styles.pill, { borderColor: color, backgroundColor: `${color}22` }]}>
        <View style={[styles.pillDot, { backgroundColor: color }]} />
        <Text style={[styles.pillText, { color }]}>{label}</Text>
      </View>
      <Text style={styles.when}>{when}</Text>
    </View>
  );
}

function ProofRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <View style={styles.prow}>
      <Text style={styles.pk}>{label}</Text>
      <Text selectable style={styles.pv}>
        {ok ? `✓ ${value}` : value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 12,
    alignSelf: 'stretch',
  },
  stack: {
    gap: 8,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  pillDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pillText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  when: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
  },
  headline: {
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
    color: colors.bone,
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
  },
  compare: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  compareTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  compareCol: {
    gap: 2,
    flex: 1,
  },
  compareColEnd: {
    gap: 2,
    flex: 1,
    alignItems: 'flex-end',
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  figure: {
    fontFamily: fonts.serifLight,
    fontSize: 36,
    lineHeight: 40,
  },
  trackWrap: {
    height: 30,
    justifyContent: 'center',
  },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(237, 230, 214, 0.10)',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  allowed: {
    height: '100%',
    backgroundColor: colors.brass,
  },
  over: {
    height: '100%',
    backgroundColor: colors.refused,
  },
  marker: {
    position: 'absolute',
    top: 4,
    width: 2,
    height: 24,
    marginLeft: -1,
    backgroundColor: colors.bone,
  },
  limitLabel: {
    position: 'absolute',
    top: -2,
    marginLeft: -18,
    width: 36,
    textAlign: 'center',
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.8,
    color: colors.bone,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.boneLine,
    paddingTop: 8,
  },
  fact: {
    width: '47%',
    gap: 2,
  },
  factLabel: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  factValue: {
    color: colors.bone,
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    lineHeight: 18,
  },
  sequence: {
    gap: 6,
  },
  proofs: {
    gap: 0,
  },
  prow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  pk: {
    width: 156,
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  pv: {
    flex: 1,
    color: colors.bone,
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
  },
  foot: {
    textAlign: 'center',
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
  },
});
