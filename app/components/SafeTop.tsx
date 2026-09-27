import { createContext, useContext, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

const TopInset = createContext(false);

// True when an ancestor already keeps its content below the status bar.
export function useTopInset(): boolean {
  return useContext(TopInset);
}

// A safe area view that applies the top inset once per tree. A nested one drops the top edge,
// so a screen shell inside ConnectGate (or the reverse) never pads the status bar twice.
export function SafeTop({
  children,
  style,
  edges = ['top'],
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  edges?: readonly Edge[];
}) {
  const inset = useContext(TopInset);
  const own = inset ? edges.filter((edge) => edge !== 'top') : [...edges];
  return (
    <TopInset.Provider value={inset || edges.includes('top')}>
      <SafeAreaView style={style} edges={own}>
        {children}
      </SafeAreaView>
    </TopInset.Provider>
  );
}
