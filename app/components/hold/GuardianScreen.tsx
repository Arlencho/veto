import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  guardianRemovalCopy,
  phoneKeyCopy,
  safeAddressCopy,
  seekerKeyCopy,
  type HoldDays,
} from '../../lib/hold';
import { GUARDIAN_RECOVERY_COPY, SAFE_WALLET_GUIDANCE, validateHoldAddresses } from '../../lib/holdSafeAddress';
import { colors, fonts, radii, space, touchTarget } from '../theme';
import { HoldInput, HoldSign, HoldSteps, HoldTop, StatusBlock } from './chrome';

export function GuardianScreen({
  network,
  status,
  error,
  owner,
  phoneKey,
  days,
  mode,
  guardianText,
  safeText,
  onMode,
  onGuardian,
  onSafe,
  onBack,
  onSign,
  signingDisabled = false,
}: {
  network: string;
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  owner: string;
  phoneKey: string | null;
  days: HoldDays;
  mode: 'phone' | 'seeker';
  guardianText: string;
  safeText: string;
  onMode: (mode: 'phone' | 'seeker') => void;
  onGuardian: (text: string) => void;
  onSafe: (text: string) => void;
  onBack: () => void;
  onSign: () => Promise<void>;
  signingDisabled?: boolean;
}) {
  const [reviewed, setReviewed] = useState<string | null>(null);
  const phone = phoneKeyCopy(owner, phoneKey);
  const seeker = seekerKeyCopy();
  const identity = JSON.stringify([owner, mode, guardianText.trim(), safeText.trim()]);
  const reviewing = reviewed === identity;
  let validationError: string | null = null;
  try {
    validateHoldAddresses(owner, guardianText, safeText);
  } catch (err) {
    validationError = (err as Error).message;
  }
  function change(action: () => void) {
    setReviewed(null);
    action();
  }
  return (
    <View style={styles.wrap}>
      <HoldTop title="New Hold vault" network={network} onBack={onBack} />
      <HoldSteps current={2} />
      <StatusBlock status={status} error={error}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.h1}>Choose a guardian and a safe wallet.</Text>
        <Text style={styles.body}>
          {GUARDIAN_RECOVERY_COPY}
        </Text>
        <View accessibilityRole="radiogroup" style={styles.options}>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: mode === 'seeker' }}
            accessibilityLabel={seeker.title}
            onPress={() => change(() => onMode('seeker'))}
            style={[styles.option, mode === 'seeker' && styles.optionOn]}
          >
            <Text style={styles.optionTitle}>
              {seeker.title} <Text style={styles.badge}>Recommended</Text>
            </Text>
            <Text style={styles.optionBody}>{seeker.detail}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: mode === 'phone', disabled: !phone.available }}
            accessibilityLabel={phone.title}
            disabled={!phone.available}
            onPress={() => change(() => onMode('phone'))}
            style={[styles.option, mode === 'phone' && styles.optionOn, !phone.available && styles.dim]}
          >
            <Text style={styles.optionTitle}>{phone.title}</Text>
            <Text style={styles.optionBody}>{phone.detail}</Text>
          </Pressable>
        </View>
        {mode === 'seeker' ? (
          <HoldInput
            label="Second Seeker address"
            value={guardianText}
            onChangeText={(value) => change(() => onGuardian(value))}
            hint="The address of the key on your other phone."
          />
        ) : null}
        <HoldInput
          label="Safe address"
          value={safeText}
          onChangeText={(value) => change(() => onSafe(value))}
          hint={SAFE_WALLET_GUIDANCE}
        />
        <Text style={styles.optionBody}>{safeAddressCopy(days)}</Text>
        {validationError ? <Text style={styles.error}>{validationError}</Text> : null}
        {reviewing && !validationError ? (
          <View style={styles.safeCopy}>
            <Text style={styles.h1}>Confirm your safe address</Text>
            <Text selectable style={styles.optionTitle}>{safeText.trim()}</Text>
            <Text style={styles.body}>{GUARDIAN_RECOVERY_COPY}</Text>
            <Text style={styles.body}>{SAFE_WALLET_GUIDANCE}</Text>
            <HoldSign
              name="open-vault"
              label="Press and hold to sign with your key on this phone"
              hint={guardianRemovalCopy(days)}
              disabled={signingDisabled}
              onSign={onSign}
            />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Review safe address"
            accessibilityState={{ disabled: Boolean(validationError) || signingDisabled }}
            disabled={Boolean(validationError) || signingDisabled}
            onPress={() => { if (!validationError && !signingDisabled) setReviewed(identity); }}
            style={styles.change}
          >
            <Text style={styles.changeText}>Review safe address</Text>
          </Pressable>
        )}
      </StatusBlock>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  error: { color: colors.refused, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  h1: { color: colors.bone, fontFamily: fonts.serifRegular, fontSize: 30, lineHeight: 34 },
  body: { color: colors.body, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  options: { gap: space.md },
  option: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.xl,
    gap: space.xs,
  },
  optionOn: { borderColor: colors.brass, backgroundColor: 'rgba(201, 162, 77, 0.10)' },
  dim: { opacity: 0.85 },
  optionTitle: { color: colors.bone, fontFamily: fonts.sansBold, fontSize: 15, lineHeight: 20 },
  optionBody: { color: colors.body, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  badge: {
    color: colors.forest,
    backgroundColor: colors.brass,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  safeCopy: { gap: space.xs },
  change: {
    height: touchTarget,
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  changeText: { color: colors.brass, fontFamily: fonts.sansBold, fontSize: 13 },
});
