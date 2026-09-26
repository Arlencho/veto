#!/usr/bin/env bash
# Offline installer checks use real SHA-256 hashing and executable fixtures.
# Each scratch copy pins the fixture digest; production has no pin override.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SCRIPT="${CI_TOOLCHAIN_UNDER_TEST:-$ROOT/scripts/ci-toolchain.sh}"
BASE_PATH="$PATH"
pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

new_scratch() {
    STUB_DIR=$(mktemp -d)
    export STUB_DIR
    export HOME="$STUB_DIR/home"
    export PATH="$HOME/.cargo/bin:$STUB_DIR/bin:$BASE_PATH"
    mkdir -p "$HOME/.cargo/bin" "$STUB_DIR/bin" "$STUB_DIR/scripts"
    SCRIPT="$STUB_DIR/scripts/ci-toolchain.sh"
    cp "$SOURCE_SCRIPT" "$SCRIPT"
    cat > "$STUB_DIR/anchor-fixture" <<'EOF'
#!/usr/bin/env bash
echo executed >> "$STUB_DIR/executed.log"
echo "anchor-cli ${FIXTURE_VERSION:-1.2.0}"
EOF
    shasum -a 256 "$STUB_DIR/anchor-fixture" | cut -d ' ' -f1 > "$STUB_DIR/scripts/anchor-1.2.0-linux-x64.sha256"
    cat > "$STUB_DIR/bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) echo Linux ;;
  -m) echo "${FIXTURE_ARCH:-x86_64}" ;;
esac
EOF
    cat > "$STUB_DIR/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "sleep $*" >> "$STUB_DIR/sleep.log"
EOF
    for command in avm cargo gh; do
        cat > "$STUB_DIR/bin/$command" <<'EOF'
#!/usr/bin/env bash
echo forbidden >> "$STUB_DIR/network-verification.log"
exit 1
EOF
    done
    cat > "$STUB_DIR/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$STUB_DIR/curl.log"
n=$(cat "$STUB_DIR/curl_count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$STUB_DIR/curl_count"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then output="$2"; shift; fi
  shift
done
fail_times=$(cat "$STUB_DIR/curl_fail_times" 2>/dev/null || echo 0)
if [ "$n" -le "$fail_times" ]; then
  [ -z "$output" ] || echo partial > "$output"
  exit 22
fi
if [ -n "$output" ]; then
  cp "$STUB_DIR/anchor-fixture" "$output"
  [ ! -f "$STUB_DIR/corrupt_download" ] || echo tampered >> "$output"
  exit 0
fi
if [ -f "$STUB_DIR/installer_fail" ]; then
  echo 'exit 1'
  exit 0
fi
cat <<'INSTALLER'
mkdir -p "$HOME/.local/share/solana/install/active_release/bin"
cat > "$HOME/.local/share/solana/install/active_release/bin/solana" <<'INNER'
#!/usr/bin/env bash
echo 'solana-cli stub'
INNER
chmod +x "$HOME/.local/share/solana/install/active_release/bin/solana"
INSTALLER
EOF
    chmod +x "$STUB_DIR/bin/"*
}

count_lines_matching() {
    local count
    count=$(grep -c "$1" "$2" 2>/dev/null) || true
    printf '%s' "${count:-0}"
}

seed_cache() {
    mkdir -p "$HOME/.avm/bin"
    cp "$STUB_DIR/anchor-fixture" "$HOME/.avm/bin/anchor-1.2.0"
    chmod +x "$HOME/.avm/bin/anchor-1.2.0"
}

new_scratch
if bash "$SCRIPT" install-anchor >/dev/null 2>&1 \
    && [ "$(cat "$STUB_DIR/curl_count")" = 1 ] \
    && bash "$SCRIPT" verify-anchor \
    && [ "$(anchor --version)" = 'anchor-cli 1.2.0' ] \
    && [ ! -f "$STUB_DIR/network-verification.log" ] \
    && [ ! -f "$STUB_DIR/sleep.log" ]; then
    ok "cold install downloads once and activates only a checksum verified binary"
else
    bad "cold install downloads once and activates only a checksum verified binary"
fi
rm -rf "$STUB_DIR"

new_scratch
seed_cache
# The old cached shim must not execute, even if it reports the right version.
cp "$STUB_DIR/bin/avm" "$HOME/.cargo/bin/anchor"
if bash "$SCRIPT" install-anchor >/dev/null 2>&1 \
    && [ "$(anchor --version)" = 'anchor-cli 1.2.0' ] \
    && [ ! -f "$STUB_DIR/curl.log" ] \
    && [ ! -f "$STUB_DIR/network-verification.log" ]; then
    ok "verified main cache works offline without avm or attestation lookup"
else
    bad "verified main cache works offline without avm or attestation lookup"
fi
rm -rf "$STUB_DIR"

new_scratch
seed_cache
echo '# tampered but still reports the pinned version' >> "$HOME/.avm/bin/anchor-1.2.0"
if bash "$SCRIPT" verify-anchor >/dev/null 2>&1; then
    bad "checksum mismatch is rejected before executing the cached binary"
elif [ ! -f "$STUB_DIR/executed.log" ]; then
    ok "checksum mismatch is rejected before executing the cached binary"
else
    bad "checksum mismatch is rejected before executing the cached binary"
fi
if bash "$SCRIPT" install-anchor >/dev/null 2>&1 \
    && [ "$(cat "$STUB_DIR/curl_count")" = 1 ] \
    && cmp -s "$STUB_DIR/anchor-fixture" "$HOME/.avm/bin/anchor-1.2.0"; then
    ok "tampered cache is replaced by a verified download"
else
    bad "tampered cache is replaced by a verified download"
fi
rm -rf "$STUB_DIR"

new_scratch
printf 2 > "$STUB_DIR/curl_fail_times"
if bash "$SCRIPT" install-anchor >/dev/null 2>&1 \
    && [ "$(cat "$STUB_DIR/curl_count")" = 3 ] \
    && [ "$(cat "$STUB_DIR/sleep.log")" = "$(printf 'sleep 10\nsleep 20')" ] \
    && cmp -s "$STUB_DIR/anchor-fixture" "$HOME/.avm/bin/anchor-1.2.0"; then
    ok "partial downloads retry with bounded backoff and never become the active binary"
else
    bad "partial downloads retry with bounded backoff and never become the active binary"
fi
rm -rf "$STUB_DIR"

for failure in corrupt_download curl_fail_times; do
    new_scratch
    printf 9 > "$STUB_DIR/$failure"
    if bash "$SCRIPT" install-anchor >/dev/null 2>&1; then
        bad "$failure must fail closed after three downloads"
    elif [ "$(cat "$STUB_DIR/curl_count" 2>/dev/null)" = 3 ] \
        && [ ! -e "$HOME/.cargo/bin/anchor" ] \
        && [ ! -f "$STUB_DIR/executed.log" ] \
        && [ -z "$(ls -A "$HOME/.avm/tmp" 2>/dev/null)" ]; then
        ok "$failure fails closed after three downloads without executing unverified bytes"
    else
        bad "$failure must fail closed after three downloads"
    fi
    rm -rf "$STUB_DIR"
done

new_scratch
seed_cache
if FIXTURE_VERSION=0.0.0 bash "$SCRIPT" install-anchor >/dev/null 2>&1; then
    bad "a matching checksum still requires the pinned runtime version"
else
    ok "a matching checksum still requires the pinned runtime version"
fi
rm -rf "$STUB_DIR"

for state in missing malformed; do
    new_scratch
    seed_cache
    if [ "$state" = missing ]; then
        rm "$STUB_DIR/scripts/anchor-1.2.0-linux-x64.sha256"
    else
        echo invalid > "$STUB_DIR/scripts/anchor-1.2.0-linux-x64.sha256"
    fi
    if bash "$SCRIPT" install-anchor >/dev/null 2>&1; then
        bad "$state pin cannot authorize an install"
    elif [ ! -f "$STUB_DIR/executed.log" ] && [ ! -f "$STUB_DIR/curl.log" ]; then
        ok "$state pin fails before execution or download"
    else
        bad "$state pin fails before execution or download"
    fi
    rm -rf "$STUB_DIR"
done

new_scratch
if FIXTURE_ARCH=aarch64 bash "$SCRIPT" install-anchor >/dev/null 2>&1; then
    bad "unsupported architecture cannot use the Linux x64 pin"
elif [ ! -f "$STUB_DIR/curl.log" ]; then
    ok "unsupported architecture fails before download"
else
    bad "unsupported architecture fails before download"
fi
rm -rf "$STUB_DIR"

new_scratch
if bash "$SCRIPT" verify-anchor >/dev/null 2>&1; then
    bad "verify-anchor rejects a missing binary"
else
    ok "verify-anchor rejects a missing binary"
fi
rm -rf "$STUB_DIR"

# Execute the workflow body against a restored cache and the scratch installer.
new_scratch
seed_cache
export GITHUB_PATH="$STUB_DIR/github-path"
awk '
  /- name: Install Anchor/ { step=1; next }
  step && /^      - name:/ { exit }
  step && /run: \|/ { body=1; next }
  body { sub(/^          /, ""); print }
' "$ROOT/.github/workflows/ci.yml" > "$STUB_DIR/cache-step.sh"
if (cd "$STUB_DIR" && bash -e "$STUB_DIR/cache-step.sh") >/dev/null 2>&1 \
    && [ "$(anchor --version)" = 'anchor-cli 1.2.0' ] \
    && [ ! -f "$STUB_DIR/curl.log" ] \
    && [ ! -f "$STUB_DIR/network-verification.log" ]; then
    ok "workflow reuses a verified cache with network verification unavailable"
else
    bad "workflow reuses a verified cache with network verification unavailable"
fi
rm -rf "$STUB_DIR"

# Scenario: solana download 500s twice, then succeeds on the third attempt.
new_scratch
printf '2' > "$STUB_DIR/curl_fail_times"
if bash "$SCRIPT" install-solana >/dev/null 2>&1 \
    && [ "$(count_lines_matching 'curl' "$STUB_DIR/curl.log")" = "3" ] \
    && [ "$(cat "$STUB_DIR/sleep.log")" = "$(printf 'sleep 10\nsleep 20')" ]; then
    ok "solana install retries through release download errors with growing back-off"
else
    bad "solana install retries through release download errors with growing back-off"
fi
rm -rf "$STUB_DIR"

# Scenario: a stale partial release directory is removed before the retry, so
# the installer cannot mistake it for a completed download.
new_scratch
printf '1' > "$STUB_DIR/curl_fail_times"
mkdir -p "$STUB_DIR/home/.local/share/solana/install/releases/partial"
: > "$STUB_DIR/home/.local/share/solana/install/releases/partial/marker"
if bash "$SCRIPT" install-solana >/dev/null 2>&1 \
    && [ ! -e "$STUB_DIR/home/.local/share/solana/install/releases/partial/marker" ]; then
    ok "a partial solana download is cleaned up before the next attempt"
else
    bad "a partial solana download is cleaned up before the next attempt"
fi
rm -rf "$STUB_DIR"

# Scenario: every solana attempt fails. Stop after 3, exit nonzero.
new_scratch
printf '9' > "$STUB_DIR/curl_fail_times"
if bash "$SCRIPT" install-solana >/dev/null 2>&1; then
    bad "solana install fails the run after 3 failed attempts"
else
    if [ "$(count_lines_matching 'curl' "$STUB_DIR/curl.log")" = "3" ]; then
        ok "solana install fails the run after 3 failed attempts"
    else
        bad "solana install stops after exactly 3 attempts (curl ran $(count_lines_matching 'curl' "$STUB_DIR/curl.log") times)"
    fi
fi
rm -rf "$STUB_DIR"

# Scenario: verify-solana rejects a missing install.
new_scratch
if bash "$SCRIPT" verify-solana >/dev/null 2>&1; then
    bad "verify-solana refuses a runner with no solana installed"
else
    ok "verify-solana refuses a runner with no solana installed"
fi
rm -rf "$STUB_DIR"

for failure in curl_fail_times installer_fail; do
    new_scratch
    bash "$SCRIPT" install-solana >/dev/null 2>&1
    printf '9' > "$STUB_DIR/$failure"
    : > "$STUB_DIR/curl.log"
    if bash "$SCRIPT" install-solana >/dev/null 2>&1; then
        bad "$failure rejects an existing runnable Solana binary"
    elif [ "$(count_lines_matching curl "$STUB_DIR/curl.log")" = 3 ]; then
        ok "$failure rejects an existing runnable Solana binary after three attempts"
    else
        bad "$failure exhausts exactly three Solana attempts"
    fi
    rm -rf "$STUB_DIR"
done

# A cached Solana binary must not short-circuit a transient download retry.
new_scratch
bash "$SCRIPT" install-solana >/dev/null 2>&1
printf '0' > "$STUB_DIR/curl_count"
printf '1' > "$STUB_DIR/curl_fail_times"
if bash "$SCRIPT" install-solana >/dev/null 2>&1 \
    && [ "$(cat "$STUB_DIR/curl_count")" = 2 ] \
    && bash "$SCRIPT" verify-solana; then
    ok "transient download failure retries before accepting cached Solana"
else
    bad "transient download failure retries before accepting cached Solana"
fi
rm -rf "$STUB_DIR"

printf 'ci-toolchain checks: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
