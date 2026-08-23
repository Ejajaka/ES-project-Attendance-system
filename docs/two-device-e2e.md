# Two-device E2E validation (Soshin ↔ Jushin)

Single-device loopback **cannot** validate three things (hardware facts we hit
during testing):
- a device never sees its own BLE advertisements (self-scan returns nothing),
- mic AGC + speaker coupling smear the presence stamp when TX/RX are the same
  device (on-frame counts 45→77, runs 20→36 — threshold-unstable),
- code-over-BLE needs a separate advertiser + scanner.

True presence + discovery + code transport require **two phones**.

## Setup
Plug in both phones (adb handles multiple serials). Make sure USB debugging is
allowed on each and they show as `device`:

```sh
export PATH=/opt/android-sdk/platform-tools:$PATH
adb devices -l          # note each device's serial
LG=<LG serial>
PX=<Pixel serial>
```

Install the release APK on both:
```sh
adb -s $LG install -r app/android/app/build/outputs/apk/release/app-release.apk
adb -s $PX install -r app/android/app/build/outputs/apk/release/app-release.apk
```

Grant runtime perms on both (choose whichever is Soshin / Jushin):
```sh
for d in $LG $PX; do for p in android.permission.RECORD_AUDIO \
  android.permission.ACCESS_FINE_LOCATION android.permission.BLUETOOTH_SCAN \
  android.permission.BLUETOOTH_ADVERTISE android.permission.BLUETOOTH_CONNECT; do
    adb -s $d shell pm grant com.shusseki.app $p; done; done
```

## Run Soshin + Jushin concurrently
Server reachable from both via USB reverse (both devices) — start the fusion
server on the PC first (`cd server && npm run dev`):
```sh
adb -s $LG reverse tcp:8787 tcp:8787
adb -s $PX reverse tcp:8787 tcp:8787

# one phone as the room (Soshin), the other as the phone (Jushin)
adb -s $LG shell am start -a android.intent.action.VIEW -d "shusseki://e2e?role=soshin" -n com.shusseki.app/.MainActivity
adb -s $PX shell am start -a android.intent.action.VIEW -d "shusseki://e2e?role=jushin" -n com.shusseki.app/.MainActivity
```

Both self-report to `POST /api/e2e` under the same session. Watch the server:
```sh
watch -n2 "curl -s localhost:8787/api/e2e/sess-1 | python3 -m json.tool"
```

## Success criteria
- Jushin `found` event has a `nodeId` + `rssi` (BLE discovery works).
- Jushin reports a decoded/relayed rolling code that the **server verifies**
  (`GET /api/sessions/sess-1/presence` shows `ultrasonicServerValid: true`) —
  this proves code-over-BLE end-to-end.
- `ultrasonic_present` events appear when Soshin is broadcasting (presence at a
  distance, no same-device AGC smear).