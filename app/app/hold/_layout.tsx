import { Stack, useLocalSearchParams } from 'expo-router';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { colors } from '../../components/theme';
import {
  HOLD_SUGGESTED_DAILY,
  HOLD_SUGGESTED_DAYS,
  HOLD_SUGGESTED_DEPOSIT,
  type HoldDays,
} from '../../lib/hold';

export type HoldDraft = {
  onboarding: boolean;
  amountText: string;
  dailyText: string;
  days: HoldDays;
  mode: 'phone' | 'seeker';
  guardianText: string;
  safeText: string;
  safeTouched: boolean;
  phoneKey: string | null;
  openedVault: string | null;
};

type DraftApi = HoldDraft & {
  setAmountText: (value: string) => void;
  setDailyText: (value: string) => void;
  setDays: (value: HoldDays) => void;
  setMode: (value: 'phone' | 'seeker') => void;
  setGuardianText: (value: string) => void;
  setSafeText: (value: string) => void;
  setPhoneKey: (value: string | null) => void;
  setOpenedVault: (value: string | null) => void;
  chooseGuardian: (mode: 'phone' | 'seeker', address: string) => void;
};

const DraftContext = createContext<DraftApi | null>(null);

function DraftProvider({ children }: { children: ReactNode }) {
  const params = useLocalSearchParams<{ onboarding?: string; guardian?: string; mode?: string }>();
  const [onboarding] = useState(params.onboarding === '1');
  const [amountText, setAmountText] = useState(HOLD_SUGGESTED_DEPOSIT);
  const [dailyText, setDailyText] = useState(HOLD_SUGGESTED_DAILY);
  const [days, setDays] = useState<HoldDays>(HOLD_SUGGESTED_DAYS);
  const [mode, setMode] = useState<'phone' | 'seeker'>(params.mode === 'phone' ? 'phone' : 'seeker');
  const [guardianText, setGuardianText] = useState(params.guardian ?? '');
  const [safeText, setSafeTextState] = useState(params.guardian ?? '');
  const [safeTouched, setSafeTouched] = useState(false);
  const [phoneKey, setPhoneKey] = useState<string | null>(null);
  const [openedVault, setOpenedVault] = useState<string | null>(null);

  const api = useMemo<DraftApi>(
    () => ({
      onboarding,
      amountText,
      dailyText,
      days,
      mode,
      guardianText,
      safeText,
      safeTouched,
      phoneKey,
      openedVault,
      setAmountText,
      setDailyText,
      setDays,
      setMode,
      setGuardianText,
      setSafeText: (value: string) => {
        setSafeTouched(true);
        setSafeTextState(value);
      },
      setPhoneKey,
      setOpenedVault,
      chooseGuardian: (nextMode, address) => {
        setMode(nextMode);
        setGuardianText(address);
        if (!safeTouched) setSafeTextState(address);
      },
    }),
    [onboarding, amountText, dailyText, days, mode, guardianText, safeText, safeTouched, phoneKey, openedVault],
  );

  return <DraftContext.Provider value={api}>{children}</DraftContext.Provider>;
}

export function useHoldDraft(): DraftApi {
  const value = useContext(DraftContext);
  if (!value) throw new Error('Hold setup is missing.');
  return value;
}

export default function HoldLayout() {
  return (
    <DraftProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
    </DraftProvider>
  );
}
