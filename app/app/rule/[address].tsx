import { redactRpc } from '../../lib/rpcPrivacy';
import { PublicKey } from '@solana/web3.js';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { HoldToApprove } from '../../components/backglass/HoldToApprove';
import { ClusterPill } from '../../components/daily/ClusterPill';
import { DecisionRow } from '../../components/DecisionRow';
import { TradeRuleDetail } from '../../components/TradeRuleDetail';
import { ConnectAgentPanel } from '../../components/ConnectAgentPanel';
import { ConnectGate } from '../../components/ConnectGate';
import { SpendBoard } from '../../components/daily/SpendBoard';
import { barUnits, openedAtSec, ruleDay } from '../../components/daily/facts';
import { LivePill } from '../../components/daily/LivePill';
import { RenewalBanner } from '../../components/renewal/RenewalBanner';
import { EmptyState } from '../../components/EmptyState';
import { ReadState } from '../../components/ReadState';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts, radii, space } from '../../components/theme';
import { copyAgentAddress } from '../../lib/agentAddress';
import {
  agentChargeConfig,
  agentChargeConfigJson,
  agentChargeRows,
  agentConnectStatus,
  payeeLookup,
  readPayeeTokenAccount,
  type AgentChargeConfig,
} from '../../lib/agentConnect';
import { ADVISORY_DECLINE_LABEL, KIND_ADVISORY_DECLINE } from '../../lib/advisory';
import { createClient, fetchAdvisoryDeclines, readRuleFunds, type RuleFunds } from '../../lib/chain';
import { STATUS_REVOKED } from '../../lib/constants';
import { formatBaseUnits, formatTimeLeft, newestFirst, timeLeftParts } from '../../lib/format';
import { formatTokenDisplay, formatTokenAmount, withToken } from '../../lib/tokens';
import type { LedgerRow } from '../../lib/ring';
import { isActive, mandateRemaining } from '../../lib/mandate';
import { mayClaimAbsence } from '../../lib/mandateRead';
import { notActiveHint } from '../../lib/reasons';
import {
  budgetLine,
  closedLine,
  closeNote,
  otherDelegateWarning,
  revokeNote,
  type RuleAccountKind,
} from '../../lib/ruleAccount';
import { displayPurpose, formatExpiryDate, ruleSentence, stampedRulesetLine } from '../../lib/ruleView';
import { PAYEE_NOT_IN_RULESET, stampAlignment, stampAlignmentLine } from '../../lib/ruleset';
import { useChain } from '../../lib/useChain';
import { useNotificationExplanation } from '../../lib/useNotificationExplanation';
import { useRulesets } from '../../lib/useRulesets';
import { useWalletActionError } from '../../lib/useWalletActionError';
import { truncateAddress } from '../../lib/wallet';

export default function RuleDetailScreen() {
  const { address } = useLocalSearchParams<{ address: string }>();
  const chain = useChain();
  const stored = useRulesets();
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useWalletActionError();
  const [loadedFunds, setLoadedFunds] = useState<RuleFunds | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loadedError, setLoadedError] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeReset, setCloseReset] = useState(0);
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const [payeeAccount, setPayeeAccount] = useState<string | null>(null);
  const [payeeFor, setPayeeFor] = useState<string | null>(null);
  const [payeeError, setPayeeError] = useState<string | null>(null);
  const [payeeErrorFor, setPayeeErrorFor] = useState<string | null>(null);
  const [otherAdvisory, setOtherAdvisory] = useState<LedgerRow[]>([]);
  const [otherAdvisoryFor, setOtherAdvisoryFor] = useState<string | null>(null);
  const [advisoryError, setAdvisoryError] = useState<string | null>(null);
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const mandate = chain.mandates.find((row) => row.address === address) ?? null;
  const index = mandate ? chain.mandates.findIndex((row) => row.address === mandate.address) : -1;
  const stamp = mandate ? stampedRulesetLine(mandate.purpose) : null;
  const funds = mandate && loadedFor === mandate.address ? loadedFunds : null;
  const fundsError = mandate && errorFor === mandate.address ? loadedError : null;
  const amountDecimals = funds?.decimals ?? chain.decimals;
  const alignment =
    mandate && stored.ready
      ? stampAlignment({
          purpose: mandate.purpose,
          cap: mandate.cap,
          perTxMax: mandate.perTxMax,
          decimals: amountDecimals,
          rulesets: stored.rulesets,
        })
      : null;
  const stampNote =
    stamp && alignment
      ? `${stamp} is written into the purpose on chain. The ruleset file itself is not on chain. ${stampAlignmentLine(alignment.alignment, alignment.version)}. The stamp claims the cap and per-payment maximum. ${PAYEE_NOT_IN_RULESET} A reader without this phone cannot check that match. These numbers cannot be edited afterwards.`
      : stamp
        ? `${stamp} is written into the purpose on chain. The ruleset file itself is not on chain. The stamp claims the cap and per-payment maximum. ${PAYEE_NOT_IN_RULESET} These numbers cannot be edited afterwards.`
        : null;

  const onRefresh = useCallback(() => {
    void chain.refresh();
  }, [chain]);

  const openedAddress = mandate?.address ?? null;
  const notify = useNotificationExplanation(openedAddress);
  const selectedAdvisory = useMemo(() => {
    if (!mandate || chain.mandate?.address !== mandate.address) {
      return null;
    }
    return newestFirst(chain.rows).filter((row) => row.kind === KIND_ADVISORY_DECLINE);
  }, [mandate, chain.mandate?.address, chain.rows]);
  const advisoryRows =
    selectedAdvisory ?? (mandate && otherAdvisoryFor === mandate.address ? otherAdvisory : []);

  useEffect(() => {
    if (!mandate || !chain.config || chain.mandate?.address === mandate.address) {
      return;
    }
    let cancelled = false;
    const ruleAddress = mandate.address;
    const client = createClient(chain.config);
    void fetchAdvisoryDeclines(client, new PublicKey(mandate.address), new PublicKey(mandate.agent))
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setOtherAdvisory(rows);
        setOtherAdvisoryFor(ruleAddress);
        setAdvisoryError(null);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setOtherAdvisory([]);
        setOtherAdvisoryFor(ruleAddress);
        setAdvisoryError('Could not read agent declines for this rule.');
      });
    return () => {
      cancelled = true;
    };
  }, [mandate, chain.config, chain.mandate?.address, chain.nowMs]);

  useEffect(() => {
    if (!mandate || !chain.config) {
      return;
    }
    let cancelled = false;
    const ruleAddress = mandate.address;
    const client = createClient(chain.config);
    const activeNow = isActive(mandate, nowSec);
    void (async () => {
      let next: RuleFunds;
      try {
        next = await readRuleFunds(client, mandate);
      } catch (err: unknown) {
        if (!cancelled) {
          setLoadedFunds(null);
          setLoadedFor(null);
          setLoadedError(err instanceof Error ? redactRpc(err.message) : 'Could not read the rule account');
          setErrorFor(ruleAddress);
        }
        return;
      }
      if (cancelled) {
        return;
      }
      setLoadedFunds(next);
      setLoadedFor(ruleAddress);
      setLoadedError(null);
      setErrorFor(null);
      if (!activeNow) {
        setPayeeAccount(null);
        setPayeeFor(null);
        setPayeeError(null);
        setPayeeErrorFor(null);
        return;
      }
      try {
        const payee = await readPayeeTokenAccount(
          payeeLookup(client.connection),
          new PublicKey(mandate.merchant),
          new PublicKey(mandate.mint),
          next.tokenProgram ? new PublicKey(next.tokenProgram) : undefined,
        );
        if (!cancelled) {
          setPayeeAccount(payee.toBase58());
          setPayeeFor(ruleAddress);
          setPayeeError(null);
          setPayeeErrorFor(null);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setPayeeAccount(null);
          setPayeeFor(null);
          setPayeeError(err instanceof Error ? redactRpc(err.message) : 'Could not read the payee token account');
          setPayeeErrorFor(ruleAddress);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mandate, chain.config, nowSec]);

  const gateSignature = async (): Promise<{ sign: false } | { sign: true; kind: RuleAccountKind }> => {
    if (!mandate || !chain.config) {
      return { sign: true, kind: funds?.kind ?? 'other' };
    }
    const latest = await readRuleFunds(createClient(chain.config), mandate);
    setLoadedFunds(latest);
    setLoadedFor(mandate.address);
    setLoadedError(null);
    setErrorFor(null);
    if (latest.otherRule && funds?.otherRule !== latest.otherRule) {
      setMessage(otherDelegateWarning(latest.otherRule));
      return { sign: false };
    }
    return { sign: true, kind: latest.kind };
  };

  const payeeToken = mandate && payeeFor === mandate.address ? payeeAccount : null;
  const payeeProblem = mandate && payeeErrorFor === mandate.address ? payeeError : null;
  const active = mandate ? isActive(mandate, nowSec) : false;
  let chargeConfig: AgentChargeConfig | null = null;
  if (active && mandate && chain.config && funds && funds.decimals != null && payeeToken) {
    chargeConfig = agentChargeConfig({
      mandate: mandate.address,
      programId: chain.config.programId,
      mint: mandate.mint,
      mintDecimals: funds.decimals,
      sourceTokenAccount: mandate.source,
      payeeTokenAccount: payeeToken,
      agent: mandate.agent,
      cluster: chain.config.explorerCluster,
      rpcUrl: chain.config.rpcUrl,
    });
  }
  const configJson = chargeConfig ? agentChargeConfigJson(chargeConfig) : null;
  const remaining = mandate ? mandateRemaining(mandate) : 0n;
  const bars = barUnits(remaining, mandate?.cap ?? 0n);
  const sameLedger = mandate != null && chain.mandate?.address === mandate.address;
  const clock = mandate
    ? ruleDay(sameLedger ? openedAtSec(chain.rows) : null, mandate.expiresAt, nowSec)
    : null;
  const left = mandate ? timeLeftParts(mandate.expiresAt, nowSec) : null;
  const remainingText = formatTokenDisplay(remaining, amountDecimals, mandate?.mint);
  const connectStatus = mandate
    ? agentConnectStatus({
        active,
        ready: chargeConfig !== null,
        decimalsMissing: Boolean(funds && funds.decimals == null),
        payeeProblem,
        fundsError,
        fundsLoaded: funds !== null,
        configProblem: chain.config ? null : (chain.configError ?? 'Config is missing.'),
      })
    : null;

  const onCopyConfig = async (json: string) => {
    setFormError(null);
    setMessage(null);
    try {
      await Clipboard.setStringAsync(json);
      setMessage('Agent config copied.');
    } catch (err) {
      setFormError(err instanceof Error ? redactRpc(err.message) : 'Copy failed');
    }
  };

  const onCopyAgent = async () => {
    if (!mandate) {
      return;
    }
    setFormError(null);
    setMessage(null);
    try {
      await copyAgentAddress(mandate.agent, async (value) => {
        await Clipboard.setStringAsync(value);
      });
      setMessage('Agent address copied.');
    } catch (err) {
      setFormError(err instanceof Error ? redactRpc(err.message) : 'Copy failed');
    }
  };

  const onClose = async () => {
    if (chain.submitHeld) {
      setCloseReset((value) => value + 1);
      return;
    }
    setFormError(null);
    setMessage(null);
    setClosing(true);
    let reopenHold = false;
    try {
      const gate = await gateSignature();
      reopenHold = !gate.sign;
      if (!gate.sign) {
        return;
      }
      await chain.close(address);
      setClosedNote(closedLine(gate.kind));
    } catch (err) {
      reopenHold = true;
      setFormError(err instanceof Error ? redactRpc(err.message) : 'Close failed');
    } finally {
      setClosing(false);
      if (reopenHold) {
        setCloseReset((value) => value + 1);
      }
    }
  };

  const onRevoke = async () => {
    if (chain.submitHeld) {
      return;
    }
    setFormError(null);
    setMessage(null);
    try {
      const gate = await gateSignature();
      if (!gate.sign) {
        return;
      }
      const result = await chain.revoke(address);
      setMessage(
        `Status on chain is now ${result.mandate.status === STATUS_REVOKED ? 'revoked' : String(result.mandate.status)}. The SPL delegation is dropped. Nothing already paid changes. The decisions stay readable.`,
      );
    } catch (err) {
      setFormError(err instanceof Error ? redactRpc(err.message) : 'Revoke failed');
    }
  };

  const trade = (chain.tradeRules ?? []).find((row) => row.address === address) ?? null;
  if (trade) {
    return <TradeRuleDetail rule={trade} />;
  }

  return (
    <Screen refreshing={chain.loading} onRefresh={onRefresh}>
      <TopBar
        back="Rules"
        center="Your rule"
        accessory={chain.config ? <ClusterPill cluster={chain.config.explorerCluster} /> : null}
        meta={mandate ? `${index + 1} of ${chain.mandates.length}` : undefined}
      />
      <ConnectGate>
        {closedNote ? <Text style={styles.ok}>{closedNote}</Text> : null}
        {!mayClaimAbsence(chain.mandateStatus) ? (
          <ReadState
            status={chain.mandateStatus}
            empty="This rule is not on chain for this owner. The app does not invent one."
          />
        ) : !mandate ? (
          <EmptyState>
            This rule is not on chain for this owner. The app does not invent one.
          </EmptyState>
        ) : (
          <View style={styles.block}>
            {notify.explanation ? (
              <View style={styles.explain}>
                <Text style={styles.explainCopy}>{notify.explanation}</Text>
                <Button
                  label="Continue"
                  accessibilityLabel="Continue to notification permission"
                  invert={false}
                  onPress={notify.onContinue}
                />
              </View>
            ) : notify.statusLine ? (
              <Text style={styles.explainCopy}>{notify.statusLine}</Text>
            ) : null}
            <RenewalBanner
              mandate={mandate}
              decimals={amountDecimals}
              nowSec={nowSec}
              onOpen={() => router.push(`/renew/${mandate.address}`)}
            />
            <View style={styles.identity}>
              <View style={styles.identityText}>
                <Text style={styles.agentName}>{truncateAddress(mandate.agent)}</Text>
                <Text style={styles.purposeLine}>{displayPurpose(mandate.purpose)}</Text>
              </View>
              <LivePill
                label={active ? 'Active' : mandate.status === STATUS_REVOKED ? 'Stopped' : 'Ended'}
                tone={active ? 'live' : 'stopped'}
              />
            </View>
            <SpendBoard
              kicker={active ? 'Your agent can still spend' : 'Still in the rule'}
              remainingText={remainingText}
              ofText={active ? `of ${formatTokenDisplay(mandate.cap, amountDecimals, mandate.mint)}` : 'still in the rule, yours to take back'}
              spentText={formatTokenDisplay(mandate.spent, amountDecimals, mandate.mint)}
              spentCaption={active ? 'spent so far' : `of ${formatTokenDisplay(mandate.cap, amountDecimals, mandate.mint)} spent`}
              remaining={bars.remaining}
              cap={bars.cap}
              accessibilityLabel={`${remainingText} left of ${formatTokenDisplay(mandate.cap, amountDecimals, mandate.mint)}`}
              leftCaption={`1 block = one payment of ${formatTokenDisplay(mandate.perTxMax, amountDecimals, mandate.mint)}`}
              rightCaption={funds ? 'Kept in its own account' : 'Reading where this rule keeps its budget.'}
              dimmed={!active}
            />
            <View style={styles.stats}>
              <View style={styles.stat}>
                <Text style={styles.statK}>Most per payment</Text>
                <Text style={styles.statV}>{`${formatTokenDisplay(mandate.perTxMax, amountDecimals, mandate.mint)} at a time`}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statK}>The rule ends</Text>
                <Text style={styles.statV}>{left ? `${left.value} ${left.label}` : formatTimeLeft(mandate.expiresAt, nowSec)}</Text>
                <Text style={styles.statHint}>{clock ? `day ${clock.day} of ${clock.total}` : formatExpiryDate(mandate.expiresAt)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statK}>Only payee</Text>
                <Text style={styles.statV}>{truncateAddress(mandate.merchant)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statK}>Your agent</Text>
                <Text style={styles.statV}>{truncateAddress(mandate.agent)}</Text>
              </View>
            </View>
            {!active ? (
              <View style={styles.stoppedCopy}>
                <Text style={styles.h2}>
                  {mandate.status === STATUS_REVOKED ? 'You stopped this rule.' : 'This rule has ended.'}
                </Text>
                <Text style={styles.explainCopy}>
                  Your agent can still ask, but the program refuses every request now. The reason it gives: rule not active.
                </Text>
                <Text style={styles.explainCopy}>
                  The next request from your agent will be refused. No money can leave the rule.
                </Text>
              </View>
            ) : null}
            <Text style={styles.h2}>The rule</Text>
            <Text style={styles.sentence}>{ruleSentence(mandate, amountDecimals)}</Text>

            <View style={styles.defs}>
              <Def label="Purpose" value={displayPurpose(mandate.purpose)} />
              {stamp ? <Def label="Stamped in purpose" value={stamp} /> : null}
              <Def label="Total cap" value={formatTokenAmount(mandate.cap, amountDecimals, mandate.mint)} />
              <Def label="Per payment, max" value={formatTokenAmount(mandate.perTxMax, amountDecimals, mandate.mint)} />
              <Def label="Expires" value={formatExpiryDate(mandate.expiresAt)} />
              <Def label="Payee" value={truncateAddress(mandate.merchant)} />
              <Def
                label="Spent so far"
                value={`${formatTokenAmount(mandate.spent, amountDecimals, mandate.mint)} of ${formatTokenAmount(mandate.cap, amountDecimals, mandate.mint)}`}
              />
              <Def label="Time left" value={formatTimeLeft(mandate.expiresAt, nowSec)} />
              <Def
                label="Balance"
                value={
                  !funds
                    ? fundsError
                      ? 'unavailable'
                      : 'Reading the account'
                    : funds.balance === null
                      ? 'not on chain'
                      : funds.decimals == null
                        ? 'unavailable'
                        : withToken(formatBaseUnits(funds.balance, funds.decimals), mandate.mint)
                }
              />
              <Def label="Account" value={mandate.source} stacked />
              <Def
                label="Agent"
                value={mandate.agent}
                stacked
                action={
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Copy agent address"
                    onPress={() => {
                      void onCopyAgent();
                    }}
                    style={({ pressed }) => [styles.copyHit, pressed && styles.copyPressed]}
                  >
                    <Text style={styles.copy}>Copy</Text>
                  </Pressable>
                }
              />
            </View>
            {funds ? (
              <Text style={styles.note}>{budgetLine(funds.kind)}</Text>
            ) : (
              <Text style={styles.note}>
                {fundsError ?? 'Reading where this rule keeps its budget.'}
              </Text>
            )}

            {advisoryError ? <Text style={styles.note}>{advisoryError}</Text> : null}
            {advisoryRows.length > 0 ? (
              <View style={styles.block}>
                <Text style={styles.h2}>{ADVISORY_DECLINE_LABEL}</Text>
                {advisoryRows.map((row) => (
                  <DecisionRow
                    key={row.signature ?? `${row.ts.toString()}-${row.nonce.toString()}`}
                    row={row}
                    decimals={amountDecimals}
                    cluster={chain.config?.explorerCluster ?? 'devnet'}
                    rpcUrl={chain.config?.rpcUrl ?? ''}
                    mandateAddress={mandate.address}
                    perTxMax={mandate.perTxMax}
                    mint={mandate.mint}
                  />
                ))}
              </View>
            ) : null}

            <Text style={styles.keys}>
              <Text style={styles.bold}>Owner key</Text> lives in Seed Vault and is the only key that
              can change this rule.{'\n'}
              <Text style={styles.bold}>Agent key</Text>{' '}
              <Text style={styles.mono}>{truncateAddress(mandate.agent)}</Text> holds authority and no
              funds. It can pay inside the rule, and nothing else.
            </Text>
            {stampNote ? (
              <EmptyState>{stampNote}</EmptyState>
            ) : (
              <EmptyState>
                Limits are fixed once the rule is opened. They cannot be widened later.
              </EmptyState>
            )}

            <ConnectAgentPanel
              rows={chargeConfig ? agentChargeRows(chargeConfig) : []}
              configJson={configJson}
              status={connectStatus}
              onCopy={(json) => {
                void onCopyConfig(json);
              }}
            />

            {funds?.otherRule ? (
              <Text style={styles.note}>{otherDelegateWarning(funds.otherRule)}</Text>
            ) : null}
            <View style={styles.actions}>
              <Button
                label="Edit the rule"
                invert={false}
                onPress={() =>
                  router.push(
                    `/rule/new?from=${encodeURIComponent(mandate.address)}`,
                  )
                }
              />
              {mandate.status === STATUS_REVOKED ? (
                <EmptyState>
                  This rule is already revoked on chain. A second revoke is rejected by the program
                  and records nothing.
                </EmptyState>
              ) : (
                <Button
                  label="Stop the rule"
                  accessibilityLabel="Revoke this rule"
                  quiet
                  invert={false}
                  busy={chain.loading}
                  disabled={chain.submitHeld}
                  onPress={() => {
                    void onRevoke();
                  }}
                />
              )}
            </View>
            {mandate.status !== STATUS_REVOKED ? (
              <Text style={styles.note}>
                {revokeNote()}
                {isActive(mandate, nowSec) ? ` ${notActiveHint()}` : ''}
              </Text>
            ) : null}
            {!isActive(mandate, nowSec) ? (
              <View style={styles.actions}>
                {funds?.closeCreatesAssociated && (
                  <Text style={styles.note}>
                    Closing creates the associated token account at your cost. That rent is paid by this
                    signature.
                  </Text>
                )}
                <HoldToApprove
                  label={`Press and hold to close this rule and get ${remainingText} back to your wallet`}
                  hint="Press and hold to sign in Seed Vault. Veto never sees your key."
                  disabled={closing || chain.loading || chain.submitHeld}
                  resetKey={closeReset}
                  onConfirm={() => {
                    void onClose();
                  }}
                />
                {funds ? (
                  <Text style={styles.note}>
                    {closeNote(funds.kind, mandate.status !== STATUS_REVOKED)}
                  </Text>
                ) : (
                  <Text style={styles.note}>
                    {fundsError ?? 'Reading where this rule keeps its budget.'}
                  </Text>
                )}
                <Text style={styles.note}>{notActiveHint()}</Text>
              </View>
            ) : null}
            {message ? <Text style={styles.ok}>{message}</Text> : null}
            {formError ? <Text style={styles.ok}>{formError}</Text> : null}
          </View>
        )}
      </ConnectGate>
    </Screen>
  );
}

function Def({
  label,
  value,
  action,
  stacked = false,
}: {
  label: string;
  value: string;
  action?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <View style={[styles.def, stacked && styles.defStacked]}>
      {stacked ? (
        <View style={styles.defHead}>
          <Text style={styles.defK}>{label}</Text>
          {action}
        </View>
      ) : (
        <>
          <Text style={styles.defK}>{label}</Text>
          {action}
        </>
      )}
      <Text selectable style={[styles.defV, stacked && styles.defVStacked]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 12,
    alignSelf: 'stretch',
  },
  explain: {
    gap: 10,
  },
  explainCopy: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
  },
  h2: {
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
  },
  sentence: {
    color: colors.text,
    fontSize: 25,
    lineHeight: 30,
    fontFamily: fonts.serif,
    letterSpacing: -0.2,
  },
  defs: {
    marginTop: 4,
  },
  def: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  defK: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '500',
  },
  defV: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
    fontFamily: fonts.mono,
    flexShrink: 1,
    textAlign: 'right',
  },
  defStacked: {
    flexDirection: 'column',
    justifyContent: 'flex-start',
    gap: 6,
  },
  defHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  defVStacked: {
    textAlign: 'left',
  },
  copyHit: {
    minHeight: 44,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  copyPressed: {
    opacity: 0.7,
  },
  copy: {
    color: colors.body,
    fontSize: 15,
    fontWeight: '500',
  },
  keys: {
    color: colors.body,
    fontSize: 14,
    lineHeight: 20,
  },
  bold: {
    color: colors.text,
    fontWeight: '600',
  },
  mono: {
    fontFamily: fonts.mono,
    color: colors.text,
  },
  actions: {
    gap: 10,
  },
  note: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  ok: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.xl,
  },
  identityText: {
    flex: 1,
    gap: 2,
  },
  agentName: {
    fontFamily: fonts.serif,
    fontSize: 24,
    lineHeight: 28,
    color: colors.bone,
  },
  purposeLine: {
    fontFamily: fonts.serifItalic,
    fontSize: 14,
    lineHeight: 18,
    color: colors.body,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
  stat: {
    width: '48%',
    gap: 2,
    padding: space.xl,
    borderRadius: radii.plaque,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  statK: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  statV: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.bone,
  },
  statHint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  stoppedCopy: {
    gap: space.md,
  },
});
