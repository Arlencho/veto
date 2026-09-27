import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { QuietReading, quietRefreshControl } from './QuietRefresh';
import { SafeTop } from './SafeTop';
import { colors, space } from './theme';

export function Screen({
  children,
  header,
  scroll = true,
  refreshing = false,
  onRefresh,
}: {
  children: ReactNode;
  header?: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const body = (
    <View style={styles.content}>
      {header}
      {scroll ? <QuietReading busy={refreshing} /> : null}
      {children}
    </View>
  );
  return (
    <SafeTop style={styles.safe}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.grow}
          keyboardShouldPersistTaps="handled"
          refreshControl={quietRefreshControl(onRefresh)}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </SafeTop>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  grow: {
    flexGrow: 1,
  },
  content: {
    paddingHorizontal: space.screen,
    paddingTop: space.xxxl,
    paddingBottom: space.bottom,
    gap: space.xl,
    flexGrow: 1,
  },
});
