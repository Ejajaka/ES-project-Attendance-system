# Maestro flows for Shusseki

These flows drive the app through its **headless deep-link hooks**. No tap
coordinates, no screenshots — each flow `openLink`s a route that boots straight
into an automated run, waits for the on-screen summary (`testID`), and asserts
on it. The same runs also stream structured lines to logcat (`adb logcat -s
ReactNativeJS`).

## Prerequisites
- App installed on a connected device/emulator: `adb install -r
  app/android/app/build/outputs/apk/release/app-release.apk`
- Maestro CLI installed: `curl -fsSL https://get.maestro.mobile.dev | bash`
  then add `~/.maestro/bin` to `PATH`.
- For server-dependent checks, the fusion server must be reachable from the
  device (default build uses `EXPO_PUBLIC_SERVER_URL=http://localhost:8787` +
  `adb reverse tcp:8787 tcp:8787`).

## Flows
| Flow | What it verifies |
|---|---|
| `smoke-all.yaml` | Full automated smoke suite (permissions, BLE, WiFi, hotspot, loopback, calibration, server). Asserts `automated passed` summary. |
| `smoke-ultra-cal.yaml` | Ultrasonic auto-calibration sweep 18.5→15kHz. |
| `e2e-both.yaml` | Two-role E2E on one device (Soshin+Jushin concurrently), self-reporting to `/api/e2e`. |

## Run
```sh
# one flow
maestro test maestro/smoke-all.yaml

# every flow
maestro test --format junit maestro/
```

## Reading results beyond the UI
The deep links also stream to logcat — the automation-grade channel:
```sh
adb logcat -d -s ReactNativeJS | grep -E "\[smoke\]|\[e2e"
```
Server-collected E2E events:
```sh
curl -s localhost:8787/api/e2e/sess-1 | python3 -m json.tool
```

## Two-device E2E (real discovery)
Single-device `role=both` skips BLE self-discovery (a phone never sees its own
advertisements). For true find-each-other, run Soshin and Jushin as separate
devices:
```sh
# device A (room)
adb -s DEVICE_A shell am start -a android.intent.action.VIEW -d "shusseki://e2e?role=soshin" -n com.shusseki.app/.MainActivity
# device B (phone)
adb -s DEVICE_B shell am start -a android.intent.action.VIEW -d "shusseki://e2e?role=jushin" -n com.shusseki.app/.MainActivity
```
Both self-report to the same session; watch `/api/e2e/:sessionId`.