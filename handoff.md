## Built

- Wallet stored-token authorization retries once only for code -1 failures in under 1500 ms without cancellation, decline, or rejection wording. Slow failures preserve the token.
- Hold cleanup clears the holding flag and stops the animation before clearing timers, preventing confirmation after unmount.
- The small hint uses forest text on the filled button and hides between 35 and 70 percent of the fill.
- Regression coverage includes a two-second decline with the real wallet message, queued completion after unmount, and sampled hint contrast.

## Decisions

- Seed Vault uses the same error code and message for stale tokens and owner declines, so elapsed time is the requested heuristic. A very fast human decline remains indistinguishable from a stale token.
- Retained the existing PR 301 and its branch. No new PR is needed.
- Ran the full test command once because the task explicitly requests npm test; subsequent verification was limited to the changed test files.

## Do not repeat

- Do not infer a decline solely from the text "authorization request failed".
- Do not validate these native changes using an update to the existing device build. expo-haptics requires a fresh EAS build.

## Evidence

- npm ci in app and sdk: passed.
- Before fixes, targeted tests failed for the slow decline (missing rejection) and unmount (one unwanted confirmation).
- The contrast test against the original component failed at 36 percent fill, with contrast 2.9569:1.
- npm test: 692 tests, 685 passed, 7 skipped, 0 failed.
- npm run typecheck: passed.
- npx expo lint: 0 errors, 4 existing import-order warnings in components/firstrun/screens.test.ts.
- npx tsx --experimental-test-module-mocks --test lib/wallet.staleToken.test.ts components/backglass/backglass.test.ts: 38 passed, 0 failed after fixes.
- npx expo export --platform android --output-dir /tmp/veto-android-export: passed, Android Hermes bundle produced.
- Android device smoke: adb launched com.veto.app/.MainActivity with Status: ok and verified it as the resumed activity. The device has versionCode 9, so this verifies the installed build only, not the new changes.
- git diff --check: passed.

## Next hint

Install a fresh EAS build for device QA of slow Decline, stale-token recovery, mid-hold navigation, and hint visibility. Physical validation of the changed code is still pending that build.
