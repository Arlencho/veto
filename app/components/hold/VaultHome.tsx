import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space } from '../theme';
import { HoldTop, StatusBlock } from './chrome';

export type VaultCard = {
  migrationRequired?: boolean;
  vaultId?: bigint;
  address: string;
  amountLabel: string;
  tokenName: string;
  dailyLabel: string;
  waitLabel: string;
  frozen: boolean;
  pendingLabel: string | null;
  guardianLabel: string;
  safeLabel: string;
};

export type GuardedCard = {
  address: string;
  ownerLabel: string;
  amountLabel: string;
  tokenName: string;
  state: 'normal' | 'waiting' | 'frozen';
  stateLabel: string;
};

export function VaultHome({
  network,
  status,
  error,
  vaults,
  guarded = [],
  onBack,
  onSetup,
  onOpen,
  onSend,
  onGuard = () => undefined,
  onMigrate,
}: {
  network: string;
  status: 'loading' | 'error' | 'empty' | 'ready';
  error?: string | null;
  vaults: readonly VaultCard[];
  guarded?: readonly GuardedCard[];
  onBack: () => void;
  onSetup: () => void;
  onOpen: (address: string, kind: 'held' | 'frozen' | 'vault') => void;
  onSend: (address: string) => void;
  onGuard?: (address: string) => void;
  onMigrate?: (address: string) => void;
}) {
  return (
    <View style={styles.wrap}>
      <HoldTop title="Hold" network={network} onBack={onBack} backLabel="Close" />
      <StatusBlock status={status} error={error} empty="No Hold vault yet.">
        {vaults.map((vault) => (
          <View key={vault.address} style={styles.card}>
            <Text style={styles.kicker}>Your vault</Text>
            <Text style={styles.amount}>
              {vault.amountLabel} <Text style={styles.unit}>{vault.tokenName}</Text>
            </Text>
            <Text style={styles.body}>
              Everyday door: {vault.dailyLabel} a day. Big door: waits {vault.waitLabel}. Guardian key{' '}
              {vault.guardianLabel}. Safe address {vault.safeLabel}.
            </Text>
            {vault.frozen ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="The vault is frozen"
                onPress={() => onOpen(vault.address, 'frozen')}
                style={styles.warn}
              >
                <Text style={styles.warnText}>The vault is frozen. Nothing leaves.</Text>
              </Pressable>
            ) : null}
            {vault.pendingLabel ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="A withdrawal is waiting"
                onPress={() => onOpen(vault.address, 'held')}
                style={styles.hold}
              >
                <Text style={styles.holdText}>{vault.pendingLabel}</Text>
              </Pressable>
            ) : null}
            {vault.migrationRequired ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Update this vault"
                onPress={() => onMigrate?.(vault.address)} style={styles.ghost}>
                <Text style={styles.ghostText}>Update this vault</Text>
                <Text style={styles.body}>Your funds and rules stay in place. Sign with the owner wallet to continue.</Text>
              </Pressable>
            ) : null}
            {!vault.frozen && !vault.migrationRequired ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send from this vault"
                onPress={() => onSend(vault.address)}
                style={styles.ghost}
              >
                <Text style={styles.ghostText}>Send from this vault</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {guarded.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Vaults you guard</Text>
            <Text style={styles.hint}>
              Your key is the guardian of these vaults. This phone tells you when a withdrawal or a settings change is
              waiting.
            </Text>
            {guarded.map((vault) => (
              <Pressable
                key={vault.address}
                accessibilityRole="button"
                accessibilityLabel={`Vault of ${vault.ownerLabel}: ${vault.stateLabel}`}
                onPress={() => onGuard(vault.address)}
                style={[styles.guardRow, vault.state === 'waiting' && styles.guardWaiting, vault.state === 'frozen' && styles.guardFrozen]}
              >
                <Text style={styles.guardTitle}>
                  Vault of {vault.ownerLabel}: {vault.amountLabel} {vault.tokenName}
                </Text>
                <Text
                  style={[
                    styles.guardState,
                    vault.state === 'waiting' && styles.holdText,
                    vault.state === 'frozen' && styles.warnText,
                  ]}
                >
                  {vault.stateLabel}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Set up another vault" onPress={onSetup} style={styles.cta}>
          <Text style={styles.ctaText}>{vaults.length === 0 ? 'Set up a vault' : 'Set up another vault'}</Text>
        </Pressable>
      </StatusBlock>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  card: {
    borderRadius: radii.row,
    borderWidth: 1,
    borderColor: colors.brassSoft,
    backgroundColor: colors.surface,
    padding: space.xxxl,
    gap: space.md,
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  amount: { color: colors.bone, fontFamily: fonts.serifLight, fontSize: 36, lineHeight: 40 },
  unit: { fontFamily: fonts.sans, fontSize: 13, color: colors.body },
  body: { color: colors.body, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  warn: {
    minHeight: 48,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: 'rgba(228, 164, 142, 0.5)',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  warnText: { color: colors.refused, fontFamily: fonts.sansBold, fontSize: 14 },
  hold: {
    minHeight: 48,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.brassLine,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  holdText: { color: colors.amber, fontFamily: fonts.sansBold, fontSize: 14 },
  section: { gap: space.md },
  sectionTitle: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  hint: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  guardRow: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.lg,
    gap: space.xs,
  },
  guardWaiting: { borderColor: colors.brassLine },
  guardFrozen: { borderColor: 'rgba(228, 164, 142, 0.5)' },
  guardTitle: { color: colors.bone, fontFamily: fonts.sansBold, fontSize: 15 },
  guardState: { color: colors.body, fontFamily: fonts.sans, fontSize: 13 },
  ghost: {
    minHeight: 48,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostText: { color: colors.bone, fontFamily: fonts.sansBold, fontSize: 15 },
  cta: {
    height: 56,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: { color: colors.forest, fontFamily: fonts.sansBold, fontSize: 17 },
});
