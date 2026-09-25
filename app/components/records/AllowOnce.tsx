import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatTokenAmount } from '../../lib/tokens';
import type { OverrideGrantView } from '../../lib/useOverrideGrant';
import { HoldToApprove } from '../backglass/HoldToApprove';
import { EmptyState } from '../EmptyState';
import { colors, fonts } from '../theme';
import { GhostButton } from './chrome';

export function AllowOnce({
  view,
  decimals,
  submitHeld,
  payee,
  perTxMax,
  remaining,
  mint,
}: {
  view: OverrideGrantView;
  decimals: number;
  submitHeld: boolean;
  payee: string;
  perTxMax: bigint;
  remaining: bigint;
  mint?: string | null;
}) {
  const { assessment, confirming, signing, error, confirmed, onOffer, onCancel, onSign } = view;
  const [resetKey, setResetKey] = useState(0);
  const seenError = useRef<string | null>(null);

  useEffect(() => {
    if (error && error !== seenError.current) {
      setResetKey((key) => key + 1);
    }
    seenError.current = error;
  }, [error]);

  if (confirmed) {
    return (
      <View style={styles.block}>
        <Text style={styles.kicker}>Read back from chain</Text>
        <Text style={styles.body}>
          Override of {formatTokenAmount(confirmed.amount, decimals, mint)} for nonce {confirmed.nonce.toString()} is
          on the ledger as a recorded decision. The agent can retry this nonce.
        </Text>
      </View>
    );
  }
  if (!assessment) {
    return null;
  }
  if (assessment.status === 'checking') {
    return (
      <EmptyState>Checking this rule and nonce on chain before offering an override.</EmptyState>
    );
  }
  if (assessment.status === 'none' || assessment.status === 'blocked' || assessment.status === 'already') {
    return (
      <View style={styles.block}>
        <Text style={styles.kicker}>Override</Text>
        <Text style={styles.body}>{assessment.why}</Text>
      </View>
    );
  }

  const amount = formatTokenAmount(assessment.amount, decimals, mint);
  const limit = formatTokenAmount(perTxMax, decimals, mint);
  const left = formatTokenAmount(remaining, decimals, mint);
  const after = formatTokenAmount(remaining > assessment.amount ? remaining - assessment.amount : 0n, decimals, mint);

  function sign() {
    if (submitHeld || signing) {
      return;
    }
    onOffer();
    onSign();
  }

  function cancel() {
    onCancel();
    setResetKey((key) => key + 1);
  }

  return (
    <View style={styles.block}>
      <View style={styles.summary}>
        <Text style={styles.summaryKicker}>If you allow it, you sign exactly this</Text>
        <Text style={styles.bullet}>This one payment only: {amount} to {payee}</Text>
        <Text style={styles.bullet}>Your limit stays {limit} per payment</Text>
        <Text style={styles.bullet}>
          Left in your rule: {left} now, {after} after it is paid
        </Text>
        {assessment.commit.paragraphs.map((paragraph) => (
          <Text key={paragraph} style={styles.legal}>
            {paragraph}
          </Text>
        ))}
      </View>
      <HoldToApprove
        label={`Hold to allow this one payment of ${amount}`}
        hint="Allowing signs in Seed Vault. Veto never sees your key."
        disabled={signing || submitHeld}
        resetKey={resetKey}
        onConfirm={sign}
      />
      {confirming && !signing ? <GhostButton label="Cancel" onPress={cancel} /> : null}
      {error ? <Text style={styles.body}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 10,
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 21,
  },
  summary: {
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.45)',
    backgroundColor: colors.brassWash,
  },
  summaryKicker: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  bullet: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  legal: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
  },
});
