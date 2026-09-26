#!/usr/bin/env bash
# Install the CI toolchain with bounded retries. Anchor is verified against
# a repository-pinned SHA-256 before execution, on both cache hits and misses.
# Updating Anchor requires reviewing the release provenance and updating the
# version, asset and checksum together. No runtime network attestation needed.
set -euo pipefail

ATTEMPTS=3
BACKOFF_BASE_S=10

# Anchor is pinned. The Solana CLI is not: CI installs the stable release and
# the workflow cache key rotates weekly to track it.
ANCHOR_VERSION="1.2.0"
ANCHOR_VERSION_OUTPUT="anchor-cli ${ANCHOR_VERSION}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANCHOR_BIN="${HOME}/.avm/bin/anchor-${ANCHOR_VERSION}"
ANCHOR_ASSET="anchor-${ANCHOR_VERSION}-x86_64-unknown-linux-gnu"
ANCHOR_URL="https://github.com/otter-sec/anchor/releases/download/v${ANCHOR_VERSION}/${ANCHOR_ASSET}"
# Digest from the immutable v1.2.0 release, also verified against its signed
# provenance when pinned: https://github.com/otter-sec/anchor/releases/tag/v1.2.0
ANCHOR_CHECKSUM_FILE="${SCRIPT_DIR}/anchor-${ANCHOR_VERSION}-linux-x64.sha256"

SOLANA_INSTALL_URL="https://release.anza.xyz/stable/install"
SOLANA_INSTALL_DIR="${HOME}/.local/share/solana/install"
SOLANA_BIN="${SOLANA_INSTALL_DIR}/active_release/bin"

log() { printf 'ci-toolchain: %s\n' "$*"; }
die() { printf 'ci-toolchain: error: %s\n' "$*" >&2; exit 1; }

backoff() {
  local attempt="$1"
  local wait_s=$((BACKOFF_BASE_S * (attempt - 1)))
  log "waiting ${wait_s}s before attempt ${attempt} of ${ATTEMPTS}"
  sleep "$wait_s"
}

load_anchor_checksum() {
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || {
    log "Anchor CI checksum supports Linux x86_64 only" >&2
    return 1
  }
  local checksum
  checksum=$(cat "$ANCHOR_CHECKSUM_FILE") || return 1
  [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || return 1
  ANCHOR_SHA256="$checksum"
}

anchor_checksum_matches() {
  local binary="$1" actual
  [ -f "$binary" ] || return 1
  actual=$(sha256sum "$binary") || return 1
  [ "${actual%% *}" = "$ANCHOR_SHA256" ]
}

verify_anchor_binary() {
  local binary="$1" version
  # Never execute a cache entry or download before verifying its bytes.
  anchor_checksum_matches "$binary" || return 1
  [ -x "$binary" ] || return 1
  version=$("$binary" --version 2>/dev/null) || return 1
  [ "$version" = "$ANCHOR_VERSION_OUTPUT" ]
}

verify_anchor() {
  load_anchor_checksum || return 1
  verify_anchor_binary "$ANCHOR_BIN"
}

activate_anchor() {
  # Replace the old avm shim without executing any cached installer or shim.
  mkdir -p "${HOME}/.cargo/bin" || return 1
  ln -sf "$ANCHOR_BIN" "${HOME}/.cargo/bin/anchor"
}

install_anchor_once() {
  local download
  mkdir -p "${HOME}/.avm/tmp" "${HOME}/.avm/bin" || return 1
  download=$(mktemp "${HOME}/.avm/tmp/anchor.XXXXXX") || return 1
  if curl -fsSL --connect-timeout 20 --max-time 120 --output "$download" "$ANCHOR_URL" \
      && anchor_checksum_matches "$download" \
      && chmod +x "$download" \
      && verify_anchor_binary "$download" \
      && mv -f "$download" "$ANCHOR_BIN"; then
    activate_anchor || return 1
    return 0
  fi
  rm -f "$download"
  return 1
}

install_anchor() {
  load_anchor_checksum || die "missing or invalid Anchor checksum, or unsupported platform"
  if verify_anchor_binary "$ANCHOR_BIN"; then
    activate_anchor || die "could not activate verified Anchor binary"
    log "Anchor restored from cache; pinned SHA-256 and version verified locally"
    return 0
  fi
  local attempt
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if [ "$attempt" -gt 1 ]; then
      backoff "$attempt"
    fi
    log "anchor install attempt ${attempt} of ${ATTEMPTS} (pinned SHA-256 verification required)"
    if install_anchor_once; then
      log "anchor installed and verified: ${ANCHOR_VERSION_OUTPUT}"
      return 0
    fi
    log "anchor install attempt ${attempt} failed download, checksum, version or activation"
  done
  die "anchor install failed ${ATTEMPTS} attempts; the binary never passed verification"
}

verify_solana() {
  [ -x "${SOLANA_BIN}/solana" ] || return 1
  "${SOLANA_BIN}/solana" --version >/dev/null 2>&1
}

install_solana_once() {
  # The installer checks the release it downloads; that check runs on every
  # attempt because the whole installer runs on every attempt.
  local installer
  installer=$(curl -sSfL "$SOLANA_INSTALL_URL") || return 1
  sh -c "$installer" || return 1
  verify_solana || return 1
}

install_solana() {
  local attempt
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if [ "$attempt" -gt 1 ]; then
      # A partial release directory must not survive into the next attempt:
      # the installer treats an existing release as already downloaded.
      rm -rf "${SOLANA_INSTALL_DIR}/releases"
      backoff "$attempt"
    fi
    log "solana install attempt ${attempt} of ${ATTEMPTS}"
    if install_solana_once; then
      log "solana installed and verified: $("${SOLANA_BIN}/solana" --version)"
      return 0
    fi
    log "solana install attempt ${attempt} failed verification"
  done
  die "solana install failed ${ATTEMPTS} attempts; the binary never passed verification"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    install-anchor) install_anchor ;;
    verify-anchor)  verify_anchor ;;
    install-solana) install_solana ;;
    verify-solana)  verify_solana ;;
    *)
      printf 'usage: %s {install-anchor|verify-anchor|install-solana|verify-solana}\n' "$0" >&2
      exit 2
      ;;
  esac
}

main "$@"
