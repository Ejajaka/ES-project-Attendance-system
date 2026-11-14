# Two-device E2E validation (transmitter ↔ receiver)

Single-device loopback **cannot** validate three things (hardware facts we hit
during testing):
- a device never sees its own BLE advertisements (self-scan returns nothing),
- mic AGC + speaker coupling smear the presence stamp when TX/RX are the same
  device (on-frame counts 45→77, runs 20→36 — threshold-unstable),
- code-over-BLE needs a separate advertiser + scanner.

True presence + discovery + code transport require **two phones**.

## Real attendance consoles (preset rooms + link stats)

The current app flow, automated by `scripts/device-e2e.sh`:

1. `scripts/device-e2e.sh setup` — installs the release APK on both phones,
   pre-grants runtime permissions, enables location, keeps the screen awake,
   starts the fusion server, and sets up `adb reverse tcp:8787` on both.
2. Both phones pick the same **preset room** (default ROOM 01).
3. TX phone: `TRANSMITTER` → `UNIT-01 ENGAGE`. It broadcasts the BLE beacon
   and the 20 kHz presence stamp. It still raises a LocalOnlyHotspot and
   announces it, as the legacy two-phone fallback.
4. RX phone: `RECEIVER` → `UNIT-01 ENGAGE`. It joins the fixed open `atlas`
   network (no password). It then reports BLE/WiFi/ultrasound every 5 s.
5. Verify:
   - TX ROOM MONITOR lists every receiver with `B● W◐ U○` link chips,
     quality, age and fused presence; tap a row for the full JSON.
   - RX LINK TO TRANSMITTER panel shows its own three-channel link + uplink RTT.
   - `scripts/device-e2e.sh presence` dumps the server's room roster, which
     includes each device's `link` summary.

```sh
scripts/device-e2e.sh setup
scripts/device-e2e.sh launch tx   # on the Pixel
scripts/device-e2e.sh launch rx   # on the LG
scripts/device-e2e.sh presence
```

## Automated E2E mode (deep link)

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

Grant runtime perms on both (choose whichever is transmitter / receiver):
```sh
for d in $LG $PX; do for p in android.permission.RECORD_AUDIO \
  android.permission.ACCESS_FINE_LOCATION android.permission.BLUETOOTH_SCAN \
  android.permission.BLUETOOTH_ADVERTISE android.permission.BLUETOOTH_CONNECT; do
    adb -s $d shell pm grant com.shusseki.app $p; done; done
```

## Run transmitter + receiver concurrently
Server reachable from both via USB reverse (both devices) — start the fusion
server on the PC first (`cd server && npm run dev`):
```sh
adb -s $LG reverse tcp:8787 tcp:8787
adb -s $PX reverse tcp:8787 tcp:8787

# one phone as the room (transmitter), the other as the phone (receiver)
adb -s $LG shell am start -a android.intent.action.VIEW -d "shusseki://e2e?role=soshin" -n com.shusseki.app/.MainActivity
adb -s $PX shell am start -a android.intent.action.VIEW -d "shusseki://e2e?role=jushin" -n com.shusseki.app/.MainActivity
```

Both self-report to `POST /api/e2e` under the same session. Watch the server:
```sh
watch -n2 "curl -s localhost:8787/api/e2e/sess-1 | python3 -m json.tool"
```

## Success criteria
- Receiver `found` event has a `nodeId` + `rssi` (BLE discovery works).
- Receiver reports a decoded/relayed rolling code that the **server verifies**
  (`GET /api/sessions/sess-1/presence` shows `ultrasonicServerValid: true`) —
  this proves code-over-BLE end-to-end.
- `ultrasonic_present` events appear when the transmitter is broadcasting
  (presence at a distance, no same-device AGC smear).