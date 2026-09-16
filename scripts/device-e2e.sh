#!/usr/bin/env bash
# Shusseki two-device E2E harness (USB adb, release APKs, adb reverse server).
#
#   scripts/device-e2e.sh setup            # install + perms + adb reverse on both phones
#   scripts/device-e2e.sh launch tx        # launch TRANSMITTER console on the TX phone
#   scripts/device-e2e.sh launch rx        # launch RECEIVER console on the RX phone
#   scripts/device-e2e.sh unwake           # wake + dismiss keyguard on both phones
#   scripts/device-e2e.sh presence         # server view of the room
#   scripts/device-e2e.sh logs <serial>    # stream app logcat
#
# Devices are addressed by serial; override with TX_SERIAL / RX_SERIAL.
# Defaults are the two phones used in this session (Pixel 8a = TX, LG G7 = RX).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK="${APK:-$ROOT/app/android/app/build/outputs/apk/release/app-release.apk}"
TX="${TX_SERIAL:-43121JEKB16677}"
RX="${RX_SERIAL:-LMG710EMWa65939f9}"
APP_ID="com.shusseki.app"
SERVER_PORT="${SERVER_PORT:-8787}"
SESSION_ID="${SESSION_ID:-sess-1}"

PERMS=(
  android.permission.RECORD_AUDIO
  android.permission.ACCESS_FINE_LOCATION
  android.permission.ACCESS_COARSE_LOCATION
  android.permission.NEARBY_WIFI_DEVICES
  android.permission.BLUETOOTH_SCAN
  android.permission.BLUETOOTH_ADVERTISE
  android.permission.BLUETOOTH_CONNECT
  android.permission.POST_NOTIFICATIONS
)

ensure_server() {
  if ! curl -sf -o /dev/null "http://localhost:${SERVER_PORT}/health"; then
    echo "starting fusion server on :${SERVER_PORT}"
    (cd "$ROOT/server" && nohup npx tsx src/server.ts >server.log 2>&1 &)
    for _ in $(seq 1 20); do
      curl -sf -o /dev/null "http://localhost:${SERVER_PORT}/health" && break
      sleep 0.5
    done
  fi
  curl -sf -o /dev/null "http://localhost:${SERVER_PORT}/health" || {
    echo "ERROR: server not responding on :${SERVER_PORT}" >&2
    exit 1
  }
}

setup() {
  [ -f "$APK" ] || { echo "ERROR: APK missing: $APK" >&2; exit 1; }
  ensure_server
  for d in "$TX" "$RX"; do
    echo "== $d: install + perms + reverse"
    adb -s "$d" install -r "$APK" >/dev/null
    for p in "${PERMS[@]}"; do adb -s "$d" shell pm grant "$APP_ID" "$p" 2>/dev/null || true; done
    # WiFi RSSI needs location services enabled, not just the permission.
    adb -s "$d" shell settings put secure location_mode 3 || true
    adb -s "$d" reverse "tcp:${SERVER_PORT}" "tcp:${SERVER_PORT}"
    adb -s "$d" shell svc power stayon true || true
  done
  echo "== both phones ready. Launch: device-e2e.sh launch tx|rx"
}

launch() {
  local role="${1:-}"
  case "$role" in
    tx) adb -s "$TX" shell am start -n "$APP_ID/.MainActivity" ;;
    rx) adb -s "$RX" shell am start -n "$APP_ID/.MainActivity" ;;
    *) echo "usage: device-e2e.sh launch tx|rx" >&2; exit 2 ;;
  esac
}

unwake() {
  for d in "$TX" "$RX"; do
    adb -s "$d" shell input keyevent KEYCODE_WAKEUP
    adb -s "$d" shell wm dismiss-keyguard || true
  done
}

presence() {
  curl -s "http://localhost:${SERVER_PORT}/api/sessions/${SESSION_ID}/presence" | python3 -m json.tool
}

logs() {
  adb -s "${1:?usage: device-e2e.sh logs <serial>}" logcat -v time ReactNativeJS:V AndroidRuntime:E '*:S'
}

cmd="${1:-}"
shift || true
case "$cmd" in
  setup) setup ;;
  launch) launch "$@" ;;
  unwake) unwake ;;
  presence) presence ;;
  logs) logs "$@" ;;
  *) sed -n '2,12p' "$0" ;;
esac
