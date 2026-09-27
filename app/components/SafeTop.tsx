import { createContext, useContext, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

// Scoped to the tree: content rendered in a Modal or portal inside a padded screen draws from
// y=0 again, so wrap it in ResetTopInset before placing a Screen inside it.
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

// Starts a fresh inset scope, for Modal or portal content that draws from the top of the window.
export function ResetTopInset({ children }: { children: ReactNode }) {
  return <TopInset.Provider value={false}>{children}</TopInset.Provider>;
}
