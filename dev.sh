#!/usr/bin/env bash
# Shusseki dev launcher.
#
#   ./dev.sh          kill old processes, start fusion server (background),
#                     then run Expo in the foreground (prints the QR code).
#   ./dev.sh stop     kill the fusion server + Metro and exit.
#
set -euo pipefail

# Toolchain paths (bun, node 20, etc.)
source "$HOME/.zshrc" 2>/dev/null || true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
APP_DIR="$ROOT/app"
SERVER_PORT="${SERVER_PORT:-8787}"
EXPO_PORT="${EXPO_PORT:-8081}"
LOG="$SERVER_DIR/server.log"

# Expo must run on Node 20 (Node 26 breaks its TS loading; Bun can't parse RN).
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" --version 2>/dev/null | grep -q "^v20\."; then
  if [ -x /usr/local/bin/node ]; then NODE_BIN=/usr/local/bin/node; fi
fi
if [ -z "$NODE_BIN" ]; then echo "error: node not found"; exit 1; fi

LAN_IP="$(ip route get 1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -1)"
export EXPO_PUBLIC_SERVER_URL="http://${LAN_IP:-localhost}:${SERVER_PORT}"

kill_all() {
  fuser -k "${SERVER_PORT}/tcp" 2>/dev/null || true
  pkill -f "server/src/server.ts" 2>/dev/null || true
  fuser -k "${EXPO_PORT}/tcp" 2>/dev/null || true
  pkill -9 -f "expo/bin/cli start" 2>/dev/null || true
  sleep 1
}

if [ "${1:-}" = "stop" ]; then
  echo "==> stopping fusion server + metro"
  kill_all
  echo "    done"
  exit 0
fi

echo "==> killing any existing server / metro"
kill_all

echo "==> starting fusion server on :${SERVER_PORT} (log: $LOG)"
cd "$SERVER_DIR"
: > "$LOG"
nohup bun run src/server.ts > "$LOG" 2>&1 &
for _ in $(seq 1 20); do
  curl -sf -o /dev/null "http://localhost:${SERVER_PORT}/health" 2>/dev/null && break
  sleep 0.5
done
if curl -sf -o /dev/null "http://localhost:${SERVER_PORT}/health" 2>/dev/null; then
  echo "    fusion server up:  http://localhost:${SERVER_PORT}"
else
  echo "    WARNING: server did not respond — check $LOG"
fi

echo "==> starting Expo (foreground — scan the QR, Ctrl-C to stop)"
echo "    app will report to: ${EXPO_PUBLIC_SERVER_URL}"
echo "    open in Expo Go:    exp://${LAN_IP:-localhost}:${EXPO_PORT}"
echo
cd "$APP_DIR"
exec "$NODE_BIN" node_modules/expo/bin/cli start --port "$EXPO_PORT" --lan
