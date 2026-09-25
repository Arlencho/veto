import assert from 'node:assert/strict';
import test from 'node:test';
import {
  holdOnboardingNext,
  rememberHoldChoice,
  secondSeekerSetup,
  holdSetupDone,
} from './onboardingHold';

test('Hold is offered once and skipping stays skipped after reopening', async () => {
  const values = new Map<string, string>();
  const store = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    deleteItem: async (key: string) => {
      values.delete(key);
    },
  };
  assert.equal(await holdOnboardingNext(store, 'owner'), '/first-run/protect');
  await rememberHoldChoice(store, 'owner');
  assert.equal(await holdOnboardingNext(store, 'owner'), '/first-run/finish');
  assert.equal(await holdOnboardingNext(store, 'owner'), '/first-run/finish');
});

test('second Seeker setup carries its address into the shared Hold flow', () => {
  assert.deepEqual(secondSeekerSetup('  11111111111111111111111111111111  '), {
    pathname: '/hold/amount',
    params: { onboarding: '1', guardian: '11111111111111111111111111111111', mode: 'seeker' },
  });
});

test('finishing Hold returns to onboarding only for onboarding setup', () => {
  assert.equal(holdSetupDone(true), '/first-run/finish');
  assert.equal(holdSetupDone(false), '/hold');
});
