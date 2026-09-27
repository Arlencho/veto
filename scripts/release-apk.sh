#!/usr/bin/env bash
# Inspect locally; never publish the APK or pass SDK diagnostics to the terminal.
set +x
set -euo pipefail
export LC_ALL=C
umask 077
fail() { printf 'release-apk: %s\n' "$1" >&2; exit 1; }
[[ $# == 1 ]] || fail 'usage: scripts/release-apk.sh <path to apk>'
[[ -f "$1" && -r "$1" ]] || fail 'APK file is missing or unreadable'
# Restrict printed filenames so the install command cannot disclose a URL or
# contain shell syntax. Paths themselves are never printed.
name="$(basename "$1")"
[[ "$name" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.apk$ ]] || fail 'use a simple APK filename ending in .apk'
apk="$(cd "$(dirname "$1")" && pwd)/$name"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v aapt2 >/dev/null 2>&1; then
  metadata_tool=aapt2
elif command -v apkanalyzer >/dev/null 2>&1; then
  metadata_tool=apkanalyzer
else
  fail 'neither aapt2 nor apkanalyzer is on PATH; add Android SDK tools to PATH'
fi
command -v apksigner >/dev/null 2>&1 || fail 'apksigner is not on PATH; add Android SDK build-tools to PATH'
command -v unzip >/dev/null 2>&1 || fail 'unzip is not on PATH'
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Raw output can contain certificate subjects, manifest values or URLs.
if [[ "$metadata_tool" == aapt2 ]]; then
  aapt2 dump badging "$apk" >"$work/metadata" 2>"$work/errors" || fail 'aapt2 could not read APK metadata'
  package="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" "$work/metadata")"
  version_code="$(sed -n "s/^package: .*versionCode='\([^']*\)'.*/\1/p" "$work/metadata")"
  version_name="$(sed -n "s/^package: .*versionName='\([^']*\)'.*/\1/p" "$work/metadata")"
  target_sdk="$(sed -n "s/^targetSdkVersion:'\([0-9]*\)'.*/\1/p" "$work/metadata")"
  sed -n "s/^uses-permission: name='\([^']*\)'.*/\1/p" "$work/metadata" | sort -u >"$work/permissions"
  aapt2 dump xmltree "$apk" --file AndroidManifest.xml >"$work/manifest" 2>"$work/errors" || fail 'aapt2 could not read the manifest'
else
  package="$(apkanalyzer manifest application-id "$apk" 2>"$work/errors")" || fail 'apkanalyzer could not read package'
  version_code="$(apkanalyzer manifest version-code "$apk" 2>"$work/errors")" || fail 'apkanalyzer could not read versionCode'
  version_name="$(apkanalyzer manifest version-name "$apk" 2>"$work/errors")" || fail 'apkanalyzer could not read versionName'
  target_sdk="$(apkanalyzer manifest target-sdk "$apk" 2>"$work/errors")" || fail 'apkanalyzer could not read targetSdk'
  apkanalyzer manifest permissions "$apk" 2>"$work/errors" | sort -u >"$work/permissions" || fail 'apkanalyzer could not read permissions'
  apkanalyzer manifest print "$apk" >"$work/manifest" 2>"$work/errors" || fail 'apkanalyzer could not read the manifest'
fi
[[ "$package" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$ ]] || fail 'invalid package metadata'
[[ "$version_code" =~ ^[0-9]+$ ]] || fail 'invalid versionCode metadata'
[[ "$version_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$ ]] || fail 'invalid versionName metadata'
[[ "$target_sdk" =~ ^[0-9]+$ ]] || fail 'invalid targetSdk metadata'
# The release is com.veto.app, as android.package in app/app.json.
[[ "$package" == com.veto.app ]] || fail "package is $package, not com.veto.app"
# Google Play requires targetSdk 36 for new releases.
[[ "$target_sdk" -ge 36 ]] || fail "targetSdk $target_sdk is below 36"
# Read the same permission policy used by the Android build.
command -v node >/dev/null 2>&1 || fail 'node is not on PATH'
blocked_permissions="$(node -p 'require(process.argv[1]).expo.android.blockedPermissions.join("\n")' "$root/app/app.json" 2>"$work/errors")" || fail 'could not read blocked permissions from app/app.json'
while IFS= read -r permission; do
  [[ -z "$permission" ]] && continue
  [[ "$permission" =~ ^[a-zA-Z][a-zA-Z0-9_.]*$ ]] || fail 'invalid permission metadata'
  while IFS= read -r blocked; do
    [[ "$permission" == "$blocked" ]] && fail "blocked permission present: $blocked"
  done <<<"$blocked_permissions"
done <"$work/permissions"
# URL schemes come from the manifest as scheme="value" pairs, in both
# aapt2 xmltree and apkanalyzer print output.
{ grep -oE 'scheme(\(0x[0-9a-fA-F]+\))?="[^"]+"' "$work/manifest" || true; } | sed -E 's/.*="([^"]*)"/\1/' | sort -u >"$work/schemes"
scheme_veto=no
while IFS= read -r scheme; do
  [[ -z "$scheme" ]] && continue
  [[ "$scheme" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*$ ]] || fail 'invalid scheme metadata'
  [[ "$scheme" == exp+* ]] && fail "development scheme present: $scheme"
  [[ "$scheme" == veto ]] && scheme_veto=yes
done <"$work/schemes"
[[ "$scheme_veto" == yes ]] || fail 'the veto scheme is missing from the manifest'
signature=no
if apksigner verify --print-certs "$apk" >"$work/signature" 2>&1; then signature=yes; fi
fingerprints="$(sed -nE 's/^Signer #[0-9]+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$/\1/p' "$work/signature")"
[[ -n "$fingerprints" ]] || { fingerprints=unavailable; signature=no; }
# Stream only the named entry, avoiding archive-controlled extraction paths.
# grep -a also handles Hermes bytecode with its binary string table.
unzip -p "$apk" assets/index.android.bundle >"$work/bundle" 2>"$work/errors" || fail 'APK has no readable assets/index.android.bundle'
program=3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
mint=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
program_present=no
mint_present=no
rpc_present=no
# expo-constants embeds the selected config in assets/app.config. Older APKs
# without it retain the bundle heuristic. Never print URLs or parser diagnostics.
unzip -p "$apk" assets/app.config >"$work/app.config" 2>"$work/errors" || true
node - "$work/app.config" "$work/bundle" "$program" "$mint" >"$work/rpc" 2>"$work/errors" <<'NODE' || fail 'invalid embedded release config or RPC'
const fs = require('node:fs');
const [configPath, bundlePath, program, mint] = process.argv.slice(2);
const raw = fs.readFileSync(configPath, 'utf8');
const extra = raw ? JSON.parse(raw).extra : undefined;
if (raw && (!extra || typeof extra !== 'object' || Array.isArray(extra))) {
  throw new Error('Missing embedded config');
}
const bundle = fs.readFileSync(bundlePath).toString('latin1');
const tester = extra?.vetoBuildProfile === 'tester';
if (extra?.vetoBuildProfile && !tester && extra.vetoBuildProfile !== 'production') {
  throw new Error('Unsupported profile');
}
if (extra && (extra.vetoExplorerCluster !== 'devnet' ||
    extra.vetoProgramId !== program || extra.vetoMint !== mint)) {
  throw new Error('Unexpected release chain or addresses');
}
let rpc;
const profile = tester ? 'tester' : 'production (inferred from devnet release identity)';
if (extra) {
  rpc = extra.vetoRpc;
  if (typeof rpc !== 'string' || !rpc.trim()) throw new Error('Missing embedded RPC');
} else if (process.env.EXPO_PUBLIC_VETO_RPC) {
  if (bundle.includes(process.env.EXPO_PUBLIC_VETO_RPC)) rpc = process.env.EXPO_PUBLIC_VETO_RPC;
} else {
  // Heuristic only for legacy APKs; a provider match is not connectivity proof.
  rpc = bundle.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:solana\.com|helius-rpc\.com|helius\.xyz|quiknode\.pro|rpcpool\.com|ankr\.com)(?=[^a-zA-Z0-9.-]|$)/)?.[0];
}
let host = 'unavailable';
if (rpc) {
  const url = new URL(rpc);
  if (!['https:', 'http:'].includes(url.protocol) ||
      !/^[a-zA-Z0-9.:[\]-]+$/.test(url.hostname)) throw new Error('Invalid RPC');
  host = url.hostname;
}
console.log(profile);
console.log(host);
console.log(rpc ? 'yes' : 'no');
console.log(extra ? 'yes' : 'no');
NODE
profile="$(sed -n '1p' "$work/rpc")"
rpc_host="$(sed -n '2p' "$work/rpc")"
rpc_present="$(sed -n '3p' "$work/rpc")"
if [[ "$(sed -n '4p' "$work/rpc")" == yes ]]; then
  # Selected Expo config is authoritative. Hermes can contain every supported
  # cluster name and omit values only supplied through expo-constants.
  program_present=yes
  mint_present=yes
  devnet_named=yes
else
  if grep -aFq "$program" "$work/bundle"; then program_present=yes; fi
  if grep -aFq "$mint" "$work/bundle"; then mint_present=yes; fi
  if grep -aFq 'mainnet-beta' "$work/bundle"; then fail 'the bundle names mainnet-beta; do not release this APK'; fi
  devnet_named=no
  if grep -aFq 'devnet' "$work/bundle"; then devnet_named=yes; fi
fi
if command -v sha256sum >/dev/null 2>&1; then
  digest="$(sha256sum <"$apk" | sed 's/ .*//')"
elif command -v shasum >/dev/null 2>&1; then
  digest="$(shasum -a 256 <"$apk" | sed 's/ .*//')"
else
  fail 'sha256sum or shasum is required'
fi
size="$(wc -c <"$apk" | tr -d '[:space:]')"
checkout_commit="$(git -C "$root" rev-parse HEAD 2>"$work/errors")" || fail 'checkout commit is missing'
[[ "$checkout_commit" =~ ^[a-f0-9]{40,64}$ ]] || fail 'invalid checkout commit'
{
  printf 'Metadata tool: %s\nPackage: %s\nversionCode: %s\nversionName: %s\ntargetSdk: %s\n' "$metadata_tool" "$package" "$version_code" "$version_name" "$target_sdk"
  while IFS= read -r permission; do
    [[ -n "$permission" ]] && printf 'Permission: %s\n' "$permission"
  done <"$work/permissions"
  while IFS= read -r scheme; do
    [[ -n "$scheme" ]] && printf 'Scheme: %s\n' "$scheme"
  done <"$work/schemes"
  while IFS= read -r fingerprint; do printf 'Signing certificate SHA-256: %s\n' "$fingerprint"; done <<<"$fingerprints"
  printf 'Signature verifies: %s\nFile SHA-256: %s\nSize (bytes): %s\n' "$signature" "$digest" "$size"
  printf 'Program id %s present: %s\nDevnet USDC mint %s present: %s\n' "$program" "$program_present" "$mint" "$mint_present"
  printf 'Build profile: %s\nRPC host: %s (key masked)\n' "$profile" "$rpc_host"
  printf 'RPC present: %s\nDevnet confirmed: %s\nCheckout commit: %s\nadb install %s\n' "$rpc_present" "$devnet_named" "$checkout_commit" "$name"
  printf 'Solana devnet. Devnet USDC is a test token with no value.\n'
} >"$work/notes"
cat "$work/notes"
cat "$work/notes" >"$(dirname "$apk")/release-notes.md" 2>"$work/errors" || fail 'could not write release notes'
[[ "$signature" == yes && "$program_present" == yes && "$mint_present" == yes && "$devnet_named" == yes ]] || fail 'signature, program id, mint or devnet check failed; do not release this APK'
