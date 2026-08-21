# todo.md — next steps for the Shusseki Android build

Priority order. See `session.md` for full context.

## P0 — Verify the app actually renders (black-screen regression)
The npm-rebuilt release APK **built but was never run on the emulator** to
confirm the `globalThis.expo` crash is gone.

```bash
export PATH=/opt/android-sdk/platform-tools:$PATH
# ensure emulator (AVD "shusseki") is booted; if it won't boot headless, check
# /dev/kvm and stale locks (~/.android/avd/*.lock), or try -gpu host
adb install -r ./.tmp/shusseki-clean/android/app/build/outputs/apk/release/app-release.apk
adb shell am start -n com.shusseki.app/.MainActivity
adb logcat -d | grep ReactNativeJS   # expect NO "EventEmitter"/"has not been registered"
adb exec-out screencap -p > .tmp/verified.png   # expect the Shusseki UI, not black
```
If it renders: the pixel black screen is fixed. Flag it in the report.

## P1 — Promote the npm build into the repo (finish "replace bun with npm")
The working app lives in gitignored `.tmp/shusseki-clean`. Make it durable:
1. Replace `app/` with the clean npm project's **source** (`src/`, `modules/`,
   `package.json`, `app.json`, `metro.config.js`, `tsconfig.json`). Drop the
   bun-only `app/metro.config.js` band-aid.
2. Convert the repo to **npm workspaces**: replace `bun.lock` with
   `package-lock.json`; `bun install` → `npm install`.
3. Convert tests from `bun:test` to a Node runner (Vitest — `expect().toBe()`
   is API-compatible) so no bun is needed: `shared/`, `server/`, `evaluation/`,
   `app/src/lib/controllers.test.ts`.
4. `shared` must stay a workspace/dir the app can import (`metro.config.js`
   `watchFolders` for the shared root; `zod` must resolve for RN).

## P2 — The upcoming release-build recipe (for reference / CI)
```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export PATH="$JAVA_HOME/bin:$PATH"
cd app/android && ./gradlew assembleRelease
# -> app/android/app/build/outputs/apk/release/app-release.apk
```

## P3 — Device-level runtime verification
- BLE advertise/scan, WiFi RSSI (`WifiManager.getConnectionInfo` is
  deprecated on newer APIs), ultrasonic FSK tones + Goertzel decode (needs
  real hardware tuning — speaker/mic frequency response varies), biometric.
- Release **signing** for the Play Store (currently debug-signed).

## P4 — Cleanup
- Remove the old hand-built Expo app cruft once `app/` is the npm build.
- `docs/android-diagnostics.md` can be trimmed once P0/P1 land (it documents
  the old broken build path).
- The `expo-modules-core@2.2.3` consistency note is now satisfied by npm's
  normal hoisting.