#!/usr/bin/env bash
# Keep the watcher alive across reboots and logouts.
#
# The seven day history is the one deliverable that fails by starting late and
# cannot be recovered afterwards, so it must not depend on a terminal staying
# open. This installs a launchd agent that starts the watcher at login and
# restarts it if it exits.
#
#   ./scripts/watcher-service.sh install
#   ./scripts/watcher-service.sh status
#   ./scripts/watcher-service.sh uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="tech.veto.watcher"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
NODE="$(command -v node || true)"

case "${1:-status}" in
  install)
    [ -n "$NODE" ] || { echo "node is not on PATH"; exit 1; }
    [ -f "${ROOT}/watcher/dist/index.js" ] || { echo "build the watcher first: cd watcher && npm run build"; exit 1; }

    # Prove this node can actually load the build before handing it to launchd.
    #
    # The plist bakes in whichever node is on PATH right now, and launchd will
    # restart a crashing agent forever without saying why. A build that cannot
    # link on this node therefore installs cleanly, reports itself running, and
    # produces no history at all, which is the one failure this script exists to
    # prevent and the one nobody would notice until the demand for a week of
    # history could no longer be met.
    linkage="$("$NODE" -e 'const { pathToFileURL } = require("node:url"); import(pathToFileURL(process.argv[1]).href).catch(e => { process.stderr.write(String(e && e.message)); process.exit(1); })' "${ROOT}/watcher/dist/index.js" 2>&1 || true)"
    case "$linkage" in
      *"Named export"*|*"SyntaxError"*|*"does not provide an export"*|*ERR_MODULE_NOT_FOUND*)
        echo "this node cannot load the watcher build, so the service would crash on every restart:" >&2
        echo "  node:  ${NODE} ($("$NODE" --version))" >&2
        echo "  error: ${linkage}" >&2
        echo "Nothing was installed. Fix the build or use a node that can load it, then run install again." >&2
        exit 1
        ;;
    esac
    mkdir -p "${HOME}/Library/LaunchAgents" "${ROOT}/watcher/logs"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/watcher/dist/index.js</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}/watcher</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${ROOT}/watcher/logs/watcher.out</string>
  <key>StandardErrorPath</key><string>${ROOT}/watcher/logs/watcher.err</string>
</dict>
</plist>
PLIST_EOF
    pkill -f "dist/index.js run" 2>/dev/null || true
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "installed ${LABEL}; it now starts at login and restarts on exit"
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed ${LABEL}"
    ;;
  status)
    if launchctl list | grep "$LABEL" >/dev/null; then
      echo "launchd: $(launchctl list | grep "$LABEL")"
    else
      echo "launchd: not installed"
    fi
    pgrep -f "dist/index.js run" >/dev/null && echo "process: running" || echo "process: not running"
    [ -f "${ROOT}/watcher/data/decisions.jsonl" ] && echo "decisions: $(grep -c . "${ROOT}/watcher/data/decisions.jsonl")"
    ;;
  *) echo "usage: $0 install|status|uninstall"; exit 1 ;;
esac
