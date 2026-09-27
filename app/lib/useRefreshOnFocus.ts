import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';

import type { RefreshOptions } from './useChain';

// A focus only needs current data, so it joins a chain read already in flight.
export function useRefreshOnFocus(refresh: (options?: RefreshOptions) => Promise<void> | void): void {
  useFocusEffect(
    useCallback(() => {
      void refresh({ join: true });
    }, [refresh]),
  );
}
