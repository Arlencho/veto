import { useContext, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ConfiguredTokenContext } from '../../lib/configuredToken';
import { FIRST_RUN_STAGES, ProgressStrip, type FirstRunStage } from '../backglass/ProgressStrip';
import { networkPillLabel } from '../../lib/onboarding';
import { colors, fonts, radii, space, type as typeScale } from '../theme';

export type ScreenView = 'loading' | 'empty' | 'error' | 'normal';

export function stagesBefore(current: FirstRunStage): FirstRunStage[] {
  const index = FIRST_RUN_STAGES.findIndex((stage) => stage.id === current);
  return FIRST_RUN_STAGES.slice(0, Math.max(0, index)).map((stage) => stage.id);
}

export function FirstRunChrome({
  stage,
  cluster,
  title,
  onBack,
  view = 'normal',
  error,
  empty = 'Nothing here yet.',
  children,
  footer,
}: {
  stage: FirstRunStage;
  cluster: string | null;
  title?: string;
  onBack?: () => void;
  view?: ScreenView;
  error?: string | null;
  empty?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const pill = networkPillLabel(cluster, useContext(ConfiguredTokenContext));
  return (
    <View style={styles.screen}>
      {title ? (
        <View style={styles.titleRow}>
          {onBack ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={onBack}
              style={styles.backHit}
            >
              <Text style={styles.backLabel}>Back</Text>
            </Pressable>
          ) : (
            <View style={styles.backHit} />
          )}
          <Text style={styles.centerTitle}>{title}</Text>
          <View style={styles.pillSlot}>
            {pill ? <NetworkPill label={pill} cluster={cluster ?? pill} /> : <View style={styles.backHit} />}
          </View>
        </View>
      ) : (
        <View style={styles.brandRow}>
          <View style={styles.brand}>
            <Text style={styles.wordmark}>Veto</Text>
          </View>
          {pill ? <NetworkPill label={pill} cluster={cluster ?? pill} /> : null}
        </View>
      )}
      <ProgressStrip current={stage} done={stagesBefore(stage)} cluster={cluster} />
      <View style={styles.body}>
        <View pointerEvents="none" accessible={false} style={styles.washLayer}>
          <View style={styles.wash} />
        </View>
        {view === 'loading' ? (
          <View>
            <ActivityIndicator color={colors.bone} accessibilityLabel="Loading" />
            <Text style={styles.empty}>Loading</Text>
          </View>
        ) : null}
        {view === 'empty' ? <Text style={styles.empty}>{empty}</Text> : null}
        {view === 'error' ? (
          <Text style={styles.error}>{error ?? 'Something went wrong.'}</Text>
        ) : null}
        {view === 'normal' ? children : null}
        {view === 'normal' && error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
      {view === 'normal' && footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

function NetworkPill({ label, cluster }: { label: string; cluster: string }) {
  return (
    <View accessibilityLabel={`${label}, ${cluster}`} style={styles.pill}>
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

export function BrassButton({
  label,
  accessibilityLabel,
  onPress,
  busy = false,
  disabled = false,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const isDisabled = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy }}
      disabled={isDisabled}
      onPress={onPress}
      style={[styles.brass, isDisabled && styles.disabled]}
    >
      <Text style={styles.brassLabel}>{label}</Text>
    </Pressable>
  );
}

export function QuietButton({
  label,
  accessibilityLabel,
  onPress,
  busy = false,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={styles.quiet}
    >
      <Text style={styles.quietLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    gap: space.xl,
    alignSelf: 'stretch',
    flexGrow: 1,
  },
  washLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    zIndex: -1,
  },
  wash: {
    position: 'absolute',
    top: -120,
    alignSelf: 'center',
    width: 280,
    height: 180,
    borderRadius: 140,
    backgroundColor: colors.brassWash,
  },
  header: {},
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
  },
  wordmark: {
    ...typeScale.wordmark,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  backHit: {
    minWidth: 64,
    minHeight: 44,
    justifyContent: 'center',
  },
  backLabel: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    color: colors.bone,
  },
  centerTitle: {
    flex: 1,
    textAlign: 'center',
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  pillSlot: {
    minWidth: 64,
    alignItems: 'flex-end',
  },
  pill: {
    borderWidth: 1,
    borderColor: colors.brassSoft,
    borderRadius: radii.pill,
    paddingHorizontal: space.md,
    paddingVertical: 3,
  },
  pillText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.brass,
  },
  body: {
    gap: space.xl,
    flexGrow: 1,
  },
  footer: {
    gap: space.sm,
  },
  empty: {
    ...typeScale.body,
  },
  error: {
    ...typeScale.body,
    color: colors.refused,
  },
  brass: {
    minHeight: 56,
    borderRadius: radii.cta,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xxl,
  },
  brassLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.forest,
  },
  quiet: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quietLabel: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    color: colors.muted,
  },
  disabled: {
    opacity: 0.5,
  },
});
