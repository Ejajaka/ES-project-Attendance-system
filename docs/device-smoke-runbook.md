# Device smoke-test runbook (adb)

Prereqs: USB debugging on, device authorized (`adb devices` shows it).
Server URL baked into this APK build is `http://10.0.2.2:8787` **only if**
`EXPO_PUBLIC_SERVER_URL` wasn't set at bundle time — for real-device server
round-trips rebuild with `EXPO_PUBLIC_SERVER_URL=http://localhost:8787` and use
step 0b's `adb reverse`.

## 0. Install & launch
```bash
export PATH=/opt/android-sdk/platform-tools:$PATH
adb install -r app/android/app/build/outputs/apk/release/app-release.apk

# 0a. plain launch
adb shell am start -n com.shusseki.app/.MainActivity

# 0b. (optional) expose the dev server running on the PC as localhost:8787
adb reverse tcp:8787 tcp:8787
cd server && npm run dev   # separate terminal

# 0c. confirm the deployed patch on the device
adb logcat -s ReactNativeJS | grep "\[app\] version"   # expect vX.Y.Z+BUILD
# (version also shows on the home screen; bump BUILD in app/src/version.ts
#  every time you ship a change — see README "Deployment & versioning")
```

## 1. Grant runtime permissions (app doesn't prompt on its own yet)
```bash
for p in android.permission.RECORD_AUDIO \
         android.permission.ACCESS_FINE_LOCATION \
         android.permission.BLUETOOTH_SCAN \
         android.permission.BLUETOOTH_ADVERTISE \
         android.permission.BLUETOOTH_CONNECT; do
  adb shell pm grant com.shusseki.app $p && echo "granted $p"
done
```
Or tap "Smoke tests → Request all runtime permissions" in the app.

## 2. In-app smoke menu ("Smoke tests" button)
Run in order; each check prints ✓/✗ + details to the on-screen log:
1. Permission status → all `granted`
2. Request permissions → all granted
3. Biometric prompt → accept with fingerprint
4. BLE advertise 5s → no error = radio OK
5. BLE scan 3s → expect ≥1 nearby device listed with RSSI
6. WiFi observation → SSID/RSSI of current network (location services must be ON)
7. Hotspot start/stop → prints generated SSID + passphrase
8. Ultrasonic loopback "123456" → the big one: decoded code must equal `123456`.
   ✗ here means speaker/mic can't pass ~18.5 kHz — a *result*, not a bug.
9. Server round-trip → needs step 0b (or LAN-IP rebuild) + server running.

## 3. Watch logs while testing
```bash
adb logcat -c && adb logcat | grep -E "ReactNativeJS|Shusseki"
adb exec-out screencap -p > smoke.png
```

## 4. Between tests force-stop (Soshin pre-fix leaked advertising; fixed now,
but force-stop is still the clean slate):
```bash
adb shell am force-stop com.shusseki.app
```
