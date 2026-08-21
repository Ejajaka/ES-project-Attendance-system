#!/usr/bin/env bash
# Kill any running Shusseki fusion server, then start a fresh one in the
# background. Usage: ./start-server.sh [port]
set -e

# Pick up toolchain paths (e.g. bun, android) from the user's shell config.
source ~/.zshrc 2>/dev/null || true

PORT="${1:-8787}"
DIR="$(cd "$(dirname "$0")/server" && pwd)"
LOG="$DIR/server.log"

echo "==> Killing any existing server on port $PORT"
if command -v fuser >/dev/null 2>&1; then fuser -k "${PORT}/tcp" 2>/dev/null || true; fi
pkill -f "src/server.ts" 2>/dev/null || true
sleep 1

cd "$DIR"
: > "$LOG"
echo "==> Starting server (logs: $LOG)"
nohup npx tsx src/server.ts > "$LOG" 2>&1 &
PID=$!

# Wait briefly for the listener to come up, then report the URL.
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:${PORT}/api/sessions" 2>/dev/null; then break; fi
  sleep 0.5
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "==> Shusseki fusion server running (pid $PID)"
echo "    Local:  http://localhost:${PORT}"
[ -n "$LAN_IP" ] && echo "    Network: http://${LAN_IP}:${PORT}"
echo "    Health: curl -s -X POST http://localhost:${PORT}/api/sessions -H 'content-type: application/json' -d '{\"sessionId\":\"s1\",\"roomId\":\"r1\",\"secret\":\"$(printf '%s' 'session-shared-secret' | base64)\"}'"
