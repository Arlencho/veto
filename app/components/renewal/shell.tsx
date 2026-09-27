import type { ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

import { SafeTop } from '../SafeTop';
import { colors, fonts, radii, space, touchTarget } from '../theme';

export function RenewalShell({
  children,
  refreshing = false,
  onRefresh,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <SafeTop style={styles.safe}>
      <View pointerEvents="none" style={styles.glow} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.bone} />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </SafeTop>
  );
}

export function RenewalHeader({
  title,
  backLabel,
  onBack,
  icon,
  cluster,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  icon: 'close' | 'back';
  cluster: string | null;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        onPress={onBack}
        style={styles.iconButton}
      >
        <Svg width={22} height={22} viewBox="0 0 24 24">
          {icon === 'close' ? (
            <Path
              d="M6 6l12 12M18 6L6 18"
              fill="none"
              stroke={colors.bone}
              strokeWidth={1.8}
              strokeLinecap="round"
            />
          ) : (
            <Path
              d="M15 6l-6 6 6 6"
              fill="none"
              stroke={colors.bone}
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </Svg>
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      {cluster ? (
        <View style={styles.pill}>
          <Text style={styles.pillText}>{cluster}</Text>
        </View>
      ) : (
        <View style={styles.iconButton} />
      )}
    </View>
  );
}

export function StatusLine({ children }: { children: string }) {
  return <Text style={styles.status}>{children}</Text>;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  glow: {
    position: 'absolute',
    top: -140,
    left: '50%',
    width: 460,
    height: 460,
    marginLeft: -230,
    borderRadius: 230,
    backgroundColor: 'rgba(201, 162, 77, 0.08)',
  },
  scroll: {
    flexGrow: 1,
    paddingBottom: space.bottom,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xxxl,
    paddingHorizontal: space.xl,
  },
  headerTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    lineHeight: 16,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  iconButton: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    minWidth: touchTarget,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    color: colors.brass,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.5)',
    borderRadius: radii.pill,
    paddingHorizontal: space.md,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  status: {
    marginHorizontal: space.screen,
    marginTop: space.xl,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
  },
});
