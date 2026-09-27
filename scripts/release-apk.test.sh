#!/usr/bin/env bash
# Offline fixtures: real ZIPs, fake Android SDK commands, no device or signing keys.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/release-apk.sh"
CASE="$(mktemp -d)"
trap 'rm -rf "$CASE"' EXIT
mkdir -p "$CASE/bin" "$CASE/assets" "$CASE/output"
# Keep PATH deterministic even when an Android SDK is installed on the host.
for tool in bash dirname basename mktemp rm sed grep git unzip shasum wc tr cat chmod sort node; do
  ln -s "$(command -v "$tool")" "$CASE/bin/$tool"
done
export PATH="$CASE/bin"
fail() {
  echo "not ok - $1" >&2
  if [[ -f "$CASE/stderr" ]]; then cat "$CASE/stderr" >&2; fi
  exit 1
}
run() {
  rc=0
  "$SCRIPT" "$CASE/output/release.apk" >"$CASE/stdout" 2>"$CASE/stderr" || rc=$?
  if grep -aEqi 'https?://|private-test-key' "$CASE/stdout" "$CASE/stderr" "$CASE/output/release-notes.md" 2>/dev/null; then
    fail 'output disclosed a URL or credential'
  fi
}
run
if ! { [[ "$rc" -ne 0 ]] && grep -q 'APK file' "$CASE/stderr"; }; then fail 'refuses a missing file clearly'; fi
echo 'ok - refuses a missing file'
cat >"$CASE/bin/aapt2" <<'SDK'
#!/usr/bin/env bash
if [[ "$1 $2" == 'dump badging' ]]; then
  printf "package: name='%s' versionCode='7' versionName='1.2.3'\n" "${BADGING_PACKAGE:-com.veto.app}"
  printf "sdkVersion:'23'\n"
  printf "targetSdkVersion:'%s'\n" "${BADGING_SDK:-36}"
  printf "uses-permission: name='android.permission.INTERNET'\n"
  printf "uses-permission: name='android.permission.CAMERA'\n"
  if [[ -n "${EXTRA_PERMISSION:-}" ]]; then printf "uses-permission: name='%s'\n" "$EXTRA_PERMISSION"; fi
  printf 'https://rpc.example.test/private-test-key\n' >&2
  exit 0
fi
if [[ "$1 $2" == 'dump xmltree' ]]; then
  printf 'E: manifest\n'
  if [[ -z "${NO_VETO_SCHEME:-}" ]]; then
    printf '  A: http://schemas.android.com/apk/res/android:scheme(0x01010027)="veto" (Raw: "veto")\n'
  fi
  if [[ -n "${EXP_SCHEME:-}" ]]; then
    printf '  A: http://schemas.android.com/apk/res/android:scheme(0x01010027)="exp+veto" (Raw: "exp+veto")\n'
  fi
  exit 0
fi
exit 1
SDK
cat >"$CASE/bin/apksigner" <<'SDK'
#!/usr/bin/env bash
[[ "$1 $2" == 'verify --print-certs' ]] || exit 1
printf 'Signer #1 certificate DN: https://rpc.example.test/private-test-key\n'
printf 'Signer #1 certificate SHA-256 digest: %064d\n' 1
exit "${SIGNATURE_FAIL:-0}"
SDK
chmod +x "$CASE/bin/aapt2" "$CASE/bin/apksigner"
# zip is only used to construct fixtures, outside the isolated PATH.
ZIP=/usr/bin/zip
bundle() {
  printf '%s\000%s\000%s\000%s\n' "$1" "$2" "$3" "${4:-devnet}" >"$CASE/assets/index.android.bundle"
  rm -f "$CASE/output/release.apk"
  (cd "$CASE" && "$ZIP" -q output/release.apk assets/index.android.bundle)
}
PROGRAM=3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
export EXPO_PUBLIC_VETO_RPC=https://rpc.example.test/private-test-key
bundle "$PROGRAM" "$MINT" "$EXPO_PUBLIC_VETO_RPC"
EXTRA_PERMISSION=android.permission.VIBRATE run
[[ "$rc" == 0 ]] || fail 'allows VIBRATE for haptics'
grep -Fxq 'Permission: android.permission.VIBRATE' "$CASE/output/release-notes.md" || fail 'notes record allowed VIBRATE'
echo 'ok - allows VIBRATE for haptics'
run
[[ "$rc" == 0 ]] || fail 'valid APK inspection succeeds'
NOTES="$CASE/output/release-notes.md"
for fact in 'Metadata tool: aapt2' 'Package: com.veto.app' 'versionCode: 7' 'versionName: 1.2.3' 'targetSdk: 36' 'Permission: android.permission.CAMERA' 'Permission: android.permission.INTERNET' 'Scheme: veto' 'Devnet confirmed: yes' 'Signature verifies: yes' 'RPC present: yes' 'adb install release.apk' 'Solana devnet. Devnet USDC is a test token with no value.'; do
  grep -Fxq "$fact" "$NOTES" || fail 'release notes contain the required facts'
done
grep -Fxq "Checkout commit: $(git -C "$ROOT" rev-parse HEAD)" "$NOTES" || fail 'notes record checkout commit'
grep -Fxq "File SHA-256: $(shasum -a 256 <"$CASE/output/release.apk" | sed 's/ .*//')" "$NOTES" || fail 'notes record file hash'
grep -Fxq "Signing certificate SHA-256: $(printf '%064d' 1)" "$NOTES" || fail 'notes record signing fingerprint'
grep -Fxq "Size (bytes): $(wc -c <"$CASE/output/release.apk" | tr -d '[:space:]')" "$NOTES" || fail 'notes record file size'
grep -Fxq "Program id $PROGRAM present: yes" "$NOTES" || fail 'notes record program presence'
grep -Fxq "Devnet USDC mint $MINT present: yes" "$NOTES" || fail 'notes record mint presence'
echo 'ok - produces notes without URLs from binary bundle or SDK output'
SIGNATURE_FAIL=1 run
if ! { [[ "$rc" -ne 0 ]] && grep -Fxq 'Signature verifies: no' "$NOTES"; }; then fail 'rejects failed signature'; fi
echo 'ok - rejects failed signature'
BADGING_PACKAGE=app.veto run
if ! { [[ "$rc" -ne 0 ]] && grep -q 'not com.veto.app' "$CASE/stderr"; }; then fail 'rejects a wrong package'; fi
echo 'ok - rejects a package that is not com.veto.app'
BADGING_SDK=35 run
if ! { [[ "$rc" -ne 0 ]] && grep -Fxq 'release-apk: targetSdk 35 is below 36' "$CASE/stderr"; }; then fail 'rejects targetSdk below 36'; fi
echo 'ok - rejects targetSdk below 36'
EXTRA_PERMISSION=android.permission.SYSTEM_ALERT_WINDOW run
if ! { [[ "$rc" -ne 0 ]] && grep -q 'blocked permission present: android.permission.SYSTEM_ALERT_WINDOW' "$CASE/stderr"; }; then fail 'rejects a blocked permission'; fi
echo 'ok - rejects a blocked permission from app.json'
EXP_SCHEME=1 run
if ! { [[ "$rc" -ne 0 ]] && grep -q 'development scheme present: exp+veto' "$CASE/stderr"; }; then fail 'rejects an exp+ scheme'; fi
echo 'ok - rejects an exp+ scheme'
NO_VETO_SCHEME=1 run
if ! { [[ "$rc" -ne 0 ]] && grep -q 'veto scheme is missing' "$CASE/stderr"; }; then fail 'rejects a missing veto scheme'; fi
echo 'ok - requires the veto scheme'
bundle "$PROGRAM" "$MINT" "$EXPO_PUBLIC_VETO_RPC" 'mainnet-beta'
run
if ! { [[ "$rc" -ne 0 ]] && grep -q 'bundle names mainnet-beta' "$CASE/stderr"; }; then fail 'rejects a mainnet-beta bundle'; fi
echo 'ok - rejects a bundle that names mainnet-beta'
bundle "$PROGRAM" "$MINT" "$EXPO_PUBLIC_VETO_RPC" 'no-cluster-marker'
run
if ! { [[ "$rc" -ne 0 ]] && grep -Fxq 'Devnet confirmed: no' "$NOTES"; }; then fail 'rejects a bundle that does not name devnet'; fi
echo 'ok - rejects a bundle that does not name devnet'
bundle "$PROGRAM" "$MINT" "$EXPO_PUBLIC_VETO_RPC"
for missing in program mint; do
  if [[ "$missing" == program ]]; then bundle '' "$MINT" ''; else bundle "$PROGRAM" '' ''; fi
  run
  [[ "$rc" -ne 0 ]] || fail 'rejects missing required address'
  grep -Fxq 'RPC present: no' "$NOTES" || fail 'reports absent RPC'
done
echo 'ok - rejects missing program or mint and reports absent RPC'
bundle "$PROGRAM" "$MINT" "$EXPO_PUBLIC_VETO_RPC"
rm "$CASE/bin/aapt2"
run
if ! { [[ "$rc" -ne 0 ]] && grep -q 'neither aapt2 nor apkanalyzer' "$CASE/stderr"; }; then fail 'explains missing SDK'; fi
cat >"$CASE/bin/apkanalyzer" <<'SDK'
#!/usr/bin/env bash
[[ "$1" == manifest ]] || exit 1
case "$2" in
  application-id) echo com.veto.app ;;
  version-code) echo 7 ;;
  version-name) echo 1.2.3 ;;
  target-sdk) echo 36 ;;
  permissions) printf 'android.permission.INTERNET\nandroid.permission.CAMERA\n' ;;
  print) printf '<manifest><application><data android:scheme="veto"/></application></manifest>\n' ;;
  *) exit 1 ;;
esac
SDK
chmod +x "$CASE/bin/apkanalyzer"
run
if ! { [[ "$rc" == 0 ]] && grep -Fxq 'Metadata tool: apkanalyzer' "$NOTES"; }; then fail 'supports apkanalyzer fallback'; fi
echo 'ok - missing SDK fails clearly and apkanalyzer fallback works'

unset EXPO_PUBLIC_VETO_RPC
bundle "$PROGRAM" "$MINT" 'https://api.devnet.solana.com'
run
[[ "$rc" == 0 ]] || fail 'recognizes known provider in a binary bundle'
grep -Fxq 'RPC present: yes' "$NOTES" || fail 'reports known provider RPC'
bundle "$PROGRAM" "$MINT" 'https://veto-hq.github.io'
run
grep -Fxq 'RPC present: no' "$NOTES" || fail 'does not mistake wallet identity for RPC'
echo 'ok - provider heuristic recognizes RPC and excludes wallet identity'

# The endpoint is carried in Expo config, not necessarily in Hermes strings.
bundle 'supported clusters: mainnet-beta devnet' '' 'https://api.devnet.solana.com'
cat >"$CASE/assets/app.config" <<CONFIG
{"extra":{"vetoBuildProfile":"tester","vetoRpc":"https://user:private-test-key@tester.example.test/private-test-key?api-key=private-test-key","vetoProgramId":"$PROGRAM","vetoMint":"$MINT","vetoExplorerCluster":"devnet"}}
CONFIG
(cd "$CASE" && "$ZIP" -q output/release.apk assets/app.config)
EXPO_PUBLIC_VETO_RPC=https://wrong.example.test/private-test-key run
[[ "$rc" == 0 ]] || fail 'accepts tester APK with an embedded capped RPC'
grep -Fxq 'Build profile: tester' "$NOTES" || fail 'reports tester profile from APK'
grep -Fxq 'RPC host: tester.example.test (key masked)' "$NOTES" || fail 'reports only selected tester RPC host'
grep -Fxq 'RPC present: yes' "$NOTES" || fail 'finds tester RPC in embedded config'
echo 'ok - tester APK reports its profile and selected RPC host without credentials'
cat >"$CASE/assets/app.config" <<'CONFIG'
{"extra":{"vetoBuildProfile":"tester","vetoRpc":""}}
CONFIG
(cd "$CASE" && "$ZIP" -q output/release.apk assets/app.config)
run
[[ "$rc" -ne 0 ]] || fail 'rejects tester config without its RPC'
echo 'ok - tester APK cannot fall back to a bundle RPC'

for invalid in missing-rpc invalid-rpc mainnet wrong-program wrong-mint malformed; do
  node - "$CASE/assets/app.config" "$invalid" "$PROGRAM" "$MINT" <<'CONFIG'
const fs = require('node:fs');
const [path, invalid, program, mint] = process.argv.slice(2);
const extra = {
  vetoBuildProfile: 'tester', vetoRpc: 'https://tester.example.test/private-test-key',
  vetoProgramId: program, vetoMint: mint, vetoExplorerCluster: 'devnet',
};
if (invalid === 'missing-rpc') extra.vetoRpc = '';
if (invalid === 'invalid-rpc') extra.vetoRpc = 'file:///private-test-key';
if (invalid === 'mainnet') extra.vetoExplorerCluster = 'mainnet-beta';
if (invalid === 'wrong-program') extra.vetoProgramId = 'wrong';
if (invalid === 'wrong-mint') extra.vetoMint = 'wrong';
fs.writeFileSync(path, invalid === 'malformed' ? 'https://private-test-key' : JSON.stringify({ extra }));
CONFIG
  (cd "$CASE" && "$ZIP" -q output/release.apk assets/app.config)
  run
  [[ "$rc" -ne 0 ]] || fail "rejects invalid embedded tester config: $invalid"
done
echo 'ok - tester config rejects missing or invalid RPC, mainnet, wrong addresses and malformed JSON'

cat >"$CASE/assets/app.config" <<CONFIG
{"extra":{"vetoRpc":"https://production.example.test/private-test-key","vetoProgramId":"$PROGRAM","vetoMint":"$MINT","vetoExplorerCluster":"devnet"}}
CONFIG
(cd "$CASE" && "$ZIP" -q output/release.apk assets/app.config)
run
[[ "$rc" == 0 ]] || fail 'accepts production embedded config'
grep -Fxq 'Build profile: production (inferred from devnet release identity)' "$NOTES" || fail 'labels production inference'
grep -Fxq 'RPC host: production.example.test (key masked)' "$NOTES" || fail 'reports production RPC host'
echo 'ok - production embedded config reports its RPC host and inferred profile'
