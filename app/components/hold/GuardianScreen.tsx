import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  guardianRemovalCopy,
  phoneKeyCopy,
  safeAddressCopy,
  seekerKeyCopy,
  shortKey,
  type HoldDays,
} from '../../lib/hold';
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
  const [editingSafe, setEditingSafe] = useState(false);
  const phone = phoneKeyCopy(owner, phoneKey);
  const seeker = seekerKeyCopy();
  const safeShown = safeText.length > 0 ? shortKey(safeText) : 'Not chosen yet';
  return (
    <View style={styles.wrap}>
      <HoldTop title="New Hold vault" network={network} onBack={onBack} />
      <HoldSteps current={2} />
      <StatusBlock status={status} error={error}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.h1}>Add a key that can only say no.</Text>
        <Text style={styles.body}>
          It can stop a waiting withdrawal, freeze the vault, and send everything to your safe address.
          It can never send money anywhere else.
        </Text>
        <View accessibilityRole="radiogroup" style={styles.options}>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: mode === 'seeker' }}
            accessibilityLabel={seeker.title}
            onPress={() => onMode('seeker')}
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
            onPress={() => onMode('phone')}
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
            onChangeText={onGuardian}
            hint="The address of the key on your other phone."
          />
        ) : null}
        <View style={styles.safe}>
          <View style={styles.safeCopy}>
            <Text style={styles.safeKicker}>Safe address</Text>
            <Text style={styles.optionTitle}>{safeShown}</Text>
            <Text style={styles.optionBody}>{safeAddressCopy(days)}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change safe address"
            onPress={() => setEditingSafe(true)}
            style={styles.change}
          >
            <Text style={styles.changeText}>Change</Text>
          </Pressable>
        </View>
        {editingSafe ? (
          <HoldInput
            label="Safe address"
            value={safeText}
            onChangeText={onSafe}
            hint="Recover sends everything here, and only here."
          />
        ) : null}
        <HoldSign
          name="open-vault"
          label="Hold to sign with your key on this phone"
          hint={guardianRemovalCopy(days)}
          disabled={signingDisabled}
          onSign={onSign}
        />
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
  safe: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: 'rgba(156, 201, 168, 0.45)',
    backgroundColor: colors.surface,
    padding: space.xl,
  },
  safeCopy: { flex: 1, gap: space.xs },
  safeKicker: {
    color: colors.paid,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  change: {
    height: touchTarget,
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  changeText: { color: colors.brass, fontFamily: fonts.sansBold, fontSize: 13 },
});
