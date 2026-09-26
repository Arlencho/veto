import { createContext, useCallback, useContext, useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import {
  findNodeHandle,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  type RefreshControlProps,
  ScrollView,
  StyleSheet,
  UIManager,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from './theme';

const RuleFieldFocusContext = createContext<(target: number) => void>(() => {});

export function useScrollFocusedField(): (target: number) => void {
  return useContext(RuleFieldFocusContext);
}

export function RuleScreen({ children, footer, refreshControl }: {
  children: ReactNode;
  footer?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const lastTarget = useRef<number | null>(null);

  const scrollToTarget = useCallback((target: number) => {
    lastTarget.current = target;
    const scroll = scrollRef.current;
    const relative = scroll ? findNodeHandle(scroll) : null;
    if (!scroll || relative == null) {
      return;
    }
    UIManager.measureLayout(
      target,
      relative,
      () => {},
      (_x, y) => {
        scroll.scrollTo({ y: Math.max(0, y - 16), animated: true });
      },
    );
  }, []);

  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      const target = lastTarget.current;
      if (target != null) {
        scrollToTarget(target);
      }
    });
    return () => subscription.remove();
  }, [scrollToTarget]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <RuleFieldFocusContext.Provider value={scrollToTarget}>
          <ScrollView
            ref={scrollRef}
            refreshControl={refreshControl}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
          >
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </RuleFieldFocusContext.Provider>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 12,
    flexGrow: 1,
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 26,
    gap: 10,
    backgroundColor: colors.bg,
  },
});
