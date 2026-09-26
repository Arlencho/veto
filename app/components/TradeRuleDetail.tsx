import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { KIND_OVERRIDE, KIND_PAID, KIND_REFUSED, STATUS_REVOKED } from '../lib/constants';
import { isListedDecision, newestFirst } from '../lib/format';
import { poolByAddress } from '../lib/pools';
import { formatTokenDisplay } from '../lib/tokens';
import { tradeWorstCase } from '../lib/tradeCopy';
import {
  floorPriceLabel,
  inputSentToday,
  isTradeActive,
  outputReceived,
  tradePairLabel,
  type TradeRuleAccount,
} from '../lib/tradeRule';
import { displayPurpose } from '../lib/ruleView';
import { useChain } from '../lib/useChain';
import { truncateAddress } from '../lib/wallet';
import { HoldToApprove } from './backglass/HoldToApprove';
import { ConnectGate } from './ConnectGate';
import { DecisionRow } from './DecisionRow';
import { EmptyState } from './EmptyState';
import { Screen } from './Screen';
import { TopBar } from './TopBar';
import { colors, fonts, space } from './theme';

export function TradeRuleDetail({ rule }: { rule: TradeRuleAccount }) {
  const chain = useChain();
  const router = useRouter();
  const requestedAddress = useRef<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopReset, setStopReset] = useState(0);
  const [closing, setClosing] = useState(false);
  const [closeReset, setCloseReset] = useState(0);
  const nowSec = BigInt(Math.floor(chain.nowMs / 1000));
  const selected = chain.tradeRule?.address === rule.address;
  const rows = selected ? chain.rows : [];
  const known = poolByAddress(rule.pool);
  const inDecimals = selected ? chain.decimals : (known?.inputDecimals ?? 9);
  const outDecimals = known?.outputDecimals ?? rows[0]?.outDecimals ?? 6;
  const inMint = rule.inMint;
  const outMint = rule.outMint;
  const today = inputSentToday(rule, nowSec);
  const received = outputReceived(rows);
  const active = isTradeActive(rule, nowSec);
  const dailyLabel = formatTokenDisplay(rule.dailyLimit, inDecimals, inMint);
  const pair = tradePairLabel(rule);

  useEffect(() => {
    if (chain.tradeRule?.address === rule.address || chain.loading || requestedAddress.current === rule.address) {
      return;
    }
    requestedAddress.current = rule.address;
    void chain.selectMandate(rule.address);
  }, [chain, rule.address]);

  const onStop = async () => {
    if (stopping || closing || chain.submitHeld) {
      return;
    }
    setStopping(true);
    setFormError(null);
    setMessage(null);
    try {
      await chain.revoke(rule.address);
      setMessage('Stopped. The agent can no longer trade on this rule.');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Stop failed');
      setStopReset((value) => value + 1);
    } finally {
      setStopping(false);
    }
  };

  const onClose = async () => {
    if (chain.submitHeld) {
      setCloseReset((value) => value + 1);
      return;
    }
    setClosing(true);
    setFormError(null);
    setMessage(null);
    try {
      await chain.close(rule.address);
      setMessage('Closed. The remaining input is back with you, and this rule is off the chain.');
      router.back();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Close failed');
      setCloseReset((value) => value + 1);
    } finally {
      setClosing(false);
    }
  };

  return (
    <Screen refreshing={chain.loading} onRefresh={() => void chain.refresh()}>
      <TopBar back="Rules" center={displayPurpose(rule.purpose)} />
      <ConnectGate>
        <View style={styles.block}>
          <Text style={styles.kicker}>{pair}</Text>
          <Text style={styles.h2}>{displayPurpose(rule.purpose)}</Text>
          <Text style={styles.body}>{known?.feeLine ?? 'The exchange fee is set by the pool.'}</Text>
          <Fact
            label="Input sent today"
            value={`${formatTokenDisplay(today, inDecimals, inMint)} of ${dailyLabel}`}
          />
          <Fact
            label="Input sent in total"
            value={`${formatTokenDisplay(rule.spent, inDecimals, inMint)} of ${formatTokenDisplay(rule.cap, inDecimals, inMint)}`}
          />
          <Fact
            label="Output received in total"
            value={formatTokenDisplay(received, outDecimals, outMint)}
          />
          <Fact label="Pinned output account" value={rule.destination} />
          <Fact
            label="Floor"
            value={floorPriceLabel({
              floorNum: rule.floorNum,
              floorDen: rule.floorDen,
              inDecimals,
              outDecimals,
              inSymbol: known?.inputSymbol ?? 'input',
              outSymbol: known?.outputSymbol ?? 'output',
            })}
          />
          <Fact label="Pool" value={pair} />
          <Text style={styles.body}>{tradeWorstCase(dailyLabel)}</Text>
          <Text style={styles.body}>{`Agent ${truncateAddress(rule.agent)}`}</Text>
          <Text style={styles.h2}>Decisions</Text>
          {rows.length === 0 ? (
            <EmptyState>No decisions on this record yet.</EmptyState>
          ) : (
            newestFirst(rows)
              .filter((row) => isListedDecision(row.kind) || row.kind === KIND_PAID || row.kind === KIND_REFUSED || row.kind === KIND_OVERRIDE)
              .map((row) => (
                <DecisionRow
                  key={`${row.kind}-${row.nonce.toString()}-${row.ts.toString()}`}
                  row={row}
                  decimals={inDecimals}
                  cluster={chain.config?.explorerCluster ?? 'devnet'}
                  rpcUrl={chain.config?.rpcUrl ?? ''}
                  mandateAddress={rule.address}
                  perTxMax={rule.perTradeMax}
                  mint={inMint}
                />
              ))
          )}
          {rule.status === STATUS_REVOKED ? (
            <EmptyState>This rule is already stopped.</EmptyState>
          ) : (
            <HoldToApprove
              label="Press and hold to stop this trade rule"
              disabled={stopping || closing || chain.loading || chain.submitHeld}
              resetKey={stopReset}
              onConfirm={() => void onStop()}
            />
          )}
          {!active ? (
            <View style={styles.block}>
              <HoldToApprove
                label="Press and hold to close and return the remaining input"
                disabled={stopping || closing || chain.loading || chain.submitHeld}
                resetKey={closeReset}
                onConfirm={() => {
                  void onClose();
                }}
              />
              <Text style={styles.body}>
                Close returns the remaining input to you. Wrapped SOL is unwrapped by closing that account.
              </Text>
            </View>
          ) : null}
          {message ? <Text style={styles.body}>{message}</Text> : null}
          {formError ? <Text style={styles.body}>{formError}</Text> : null}
        </View>
      </ConnectGate>
    </Screen>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.kicker}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: space.md,
  },
  fact: {
    gap: 4,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  h2: {
    fontFamily: fonts.serif,
    fontSize: 26,
    color: colors.text,
  },
  body: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
  },
  value: {
    fontFamily: fonts.sans,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
  },
});
