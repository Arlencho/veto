import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from '../theme';
import { HoldInput, HoldSign, HoldTop, StatusBlock } from './chrome';

export function SkipScreen({
  network,
  purpose,
  status,
  error,
  empty,
  headline,
  yourKey,
  guardianKey,
  signedHere,
  waitingLine,
  whenBoth,
  payload,
  onPayload,
  onBack,
  onSign,
  signLabel,
  signHint,
  onCancel,
  signingDisabled = false,
}: {
  network: string;
  purpose: 'skip' | 'unfreeze';
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  empty?: string;
  headline: string;
  yourKey: string;
  guardianKey: string;
  signedHere: boolean;
  waitingLine: string;
  whenBoth: readonly string[];
  payload: string;
  onPayload: (text: string) => void;
  onBack: () => void;
  onSign: () => Promise<void>;
  signLabel: string;
  signHint: string;
  onCancel: () => void;
  signingDisabled?: boolean;
}) {
  const title = purpose === 'skip' ? 'Let it go now' : 'Unfreeze with both keys';
  return (
    <View style={styles.wrap}>
      <HoldTop title={title} network={network} onBack={onBack} />
      <StatusBlock status={status} error={error} empty={empty ?? 'Nothing is waiting for both keys.'}>
        <Text style={styles.h1}>Two keys, two fingerprints.</Text>
        <Text style={styles.body}>{headline}</Text>
        <View style={styles.pair}>
          <View style={[styles.card, signedHere && styles.cardDone]}>
            <Text style={styles.goodKicker}>Your key</Text>
            <Text style={styles.cardTitle}>{signedHere ? 'Signed on this phone' : 'Not signed yet'}</Text>
            <Text style={styles.hint}>{yourKey}</Text>
          </View>
          <View style={styles.cardWait}>
            <Text style={styles.waitKicker}>Guardian key</Text>
            <Text style={styles.cardTitle}>{signedHere ? 'Waiting for the other key' : 'Not signed yet'}</Text>
            <Text style={styles.hint}>{guardianKey}</Text>
          </View>
        </View>
        <View style={styles.when}>
          <Text style={styles.kicker}>When both have signed</Text>
          {whenBoth.map((line, index) => (
            <Text key={line} style={styles.body}>
              {index + 1}. {line}
            </Text>
          ))}
        </View>
        <Text style={styles.body}>
          Only one phone? The guardian key can also be a second key in Seed Vault on this phone, if the
          wallet exposes one. Nothing moves until the second fingerprint. This request uses the current
          blockchain blockhash, so confirm it on the other phone before that blockhash expires. If it
          expires, the hold simply runs its course and you can start again.
        </Text>
        <HoldInput
          label="Request from the other phone"
          value={payload}
          onChangeText={onPayload}
          hint="Paste this only on the phone that still has to sign."
        />
        {signedHere ? (
          <View accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.status}>
            <Text style={styles.statusText}>{waitingLine}</Text>
          </View>
        ) : (
          <HoldSign name="both-keys" label={signLabel} hint={signHint} disabled={signingDisabled} onSign={onSign} />
        )}
        {signedHere && payload.length > 0 ? (
          <HoldSign
            name="finish-both"
            label="Hold to sign with the key on this phone"
            hint="This finishes the request the other phone started."
            disabled={signingDisabled}
            onSign={onSign}
          />
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel and keep waiting" onPress={onCancel} style={styles.ghost}>
          <Text style={styles.ghostText}>Cancel, keep waiting</Text>
        </Pressable>
      </StatusBlock>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  h1: { color: colors.bone, fontFamily: fonts.serifRegular, fontSize: 32, lineHeight: 36 },
  body: { color: colors.body, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  pair: { flexDirection: 'row', gap: space.md },
  card: {
    flex: 1,
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.xl,
    gap: space.xs,
  },
  cardDone: { borderColor: 'rgba(156, 201, 168, 0.55)' },
  cardWait: {
    flex: 1,
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: 'rgba(242, 185, 75, 0.6)',
    backgroundColor: colors.surface,
    padding: space.xl,
    gap: space.xs,
  },
  goodKicker: {
    color: colors.paid,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  waitKicker: {
    color: colors.tilt,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  cardTitle: { color: colors.bone, fontFamily: fonts.sansBold, fontSize: 14 },
  hint: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  when: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.xl,
    gap: space.sm,
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  status: {
    minHeight: 56,
    borderRadius: radii.cta,
    borderWidth: 1,
    borderColor: 'rgba(242, 185, 75, 0.5)',
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  statusText: { color: colors.bone, fontFamily: fonts.sansBold, fontSize: 16, textAlign: 'center' },
  ghost: {
    height: 48,
    borderRadius: radii.plaque,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostText: { color: colors.bone, fontFamily: fonts.sansBold, fontSize: 14 },
});
