import type { WalletStore } from './wallet';

const choiceKey = (owner: string) => `veto.onboarding.hold.${owner}`;
export async function holdOnboardingNext(store: WalletStore, owner: string) {
  return (await store.getItem(choiceKey(owner))) === '1'
    ? '/first-run/finish'
    : '/first-run/protect';
}
export async function rememberHoldChoice(store: WalletStore, owner: string) {
  await store.setItem(choiceKey(owner), '1');
}
export function secondSeekerSetup(address: string) {
  return {
    pathname: '/hold/amount' as const,
    params: { onboarding: '1', guardian: address.trim(), mode: 'seeker' },
  };
}
export function holdSetupDone(onboarding: boolean) {
  return onboarding ? '/first-run/finish' : '/hold';
}
