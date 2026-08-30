# todo.md — next steps for the Shusseki Android build

Priority order. See `session.md` for full context.

## P0 — Verify the app actually renders (black-screen regression) — DONE ✅
The npm-rebuilt release APK was built and **verified running on the emulator**:

- AVD `shusseki` booted headless (API 35, x86_64; `sys.boot_completed=1`).
- `adb install -r` of `app/android/.../app-release.apk` + `am start com.shusseki.app/.MainActivity`.
- No `EventEmitter` / "has not been registered" errors; UI renders (`uiautomator`
  dump shows "Shusseki", "RUN AS SOSHIN (ROOM)", "RUN AS JUSHIN (PHONE)").
- Fixed along the way: `app/src/App.tsx` used `crypto.randomUUID()` at module
  load, which Hermes doesn't provide on Android → "main has not been
  registered". Now falls back to a pseudo-random id (no new dependency).

```bash
export PATH=/opt/android-sdk/platform-tools:$PATH
adb install -r app/android/app/build/outputs/apk/release/app-release.apk
adb shell am start -n com.shusseki.app/.MainActivity
adb logcat -d | grep ReactNativeJS   # expect "Running main", no crypto/registration errors
adb exec-out screencap -p > verified.png
```

## P1 — Promote the npm build into the repo (finish "replace bun with npm") — DONE ✅
1. `app/` deps are now npm-installed; dropped the bun-only `.bun` scanning in
   `app/metro.config.js` (clean npm-workspaces config with root `watchFolders`).
2. Repository converted to **npm workspaces**: `package-lock.json` replaces
   `bun.lock`; `npm install` replaces `bun install`; removed the stray
   `"packageManager": "bun@1.3.14"` and the duplicate root `expo-*` deps (they
   were pulling `expo@57`/`react-native@0.87` through `"expo": "*"` peers).
3. Tests converted from `bun:test` to **Vitest** (`import { test, expect } from
   "vitest"`) across `shared/`, `server/`, `evaluation/`, `app/src/lib` — all
   65 pass. Server is `@hono/node-server` + `tsx` (no `Bun.serve`).
4. `shared` remains importable by the app (hoisted workspace; `zod` resolves).

Caches cleared to fit the emulator: `~/.bun/install`, `~/.gradle/caches`,
`~/.npm` (all regenerable).

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

## P5 — On-device findings & next fixes (session 2026-08-28)
Verified on **real hardware** (Pixel 8a = Soshin, Galaxy M34 = Jushin, USB adb):
- ✅ BLE advertise (5s), BLE scan (0 seen — single-device can't see itself),
  WiFi RSSI (−41 dBm), LocalOnlyHotspot (`AndroidShare_4246`), ultrasonic mic
  (band energy present), all unit tests (67) pass.
- ❌ Ultrasonic speaker→mic **loopback fails ~18.5 kHz** on the Pixel 8a — a
  documented hardware ceiling (PLAN §3/§4), not a bug. Try a lower tone
  (18.5→15 kHz calibration sweep exists in `maestro/smoke-ultra-cal.yaml`).
- ⚠️ Native `requestPermissionsAsync` **intermittently hangs** on device
  (Expo permission-manager not always wired). Workaround: E2E/smoke now use
  `getPermissionsAsync` (non-prompting) since perms are pre-granted via
  `adb pm grant`. Root-cause the hang in `modules/expo-shusseki-*/`.
- ⚠️ Server round-trip over `adb reverse tcp:8787` didn't complete on-device;
  server binds `0.0.0.0` now, but the phone→server fetch needs one more look
  (cleartext is allowed; may be IPv6-localhost vs reverse tunnel).
- ⚠️ **Release bundling in this monorepo is broken**: `assembleRelease` fails at
  `createBundleReleaseJsAndAssets` ("Unable to resolve ./src/main.tsx from
  C:\dev\shusseki"). `app/android/` is gitignored (prebuild-generated), so the
  local `entryFile`/`root` overrides + root `metro.config.js` that fix it aren't
  committed. Make release-bundle work from the app dir (see root
  `metro.config.js` + README "Deployment & versioning") and commit the recipe.

## P6 — Deployment versioning (added)
- `app/src/version.ts` = source of truth (`APP_VERSION`, `BUILD`). Bump `BUILD`
  per patch; version shows on home screen + logcat `[app] version vX.Y.Z+BUILD`.
- Reliable deploy = self-contained APK (embedded JS, no Metro), verified via the
  version log. Dev-client + Metro remains the fast path but risks stale bundles.

## P7 — Super-user HUD console + hardware fixes (session 2026-08-30)
The app is now a dense NERV-style developer console, not a consumer UI:

**UI (NGE / Evangelion aesthetic, pure core-RN, no new native deps)**
- `app/src/theme.ts` — token system (colors/type/spacing/radius) + `components/hud.tsx`
  primitives: `Panel`, `Meter`, `StatusDot`, `Hazard`, `ValueRow`, `HudButton`,
  `RawJson`, `ConsoleHeader`. Built per the installed `expo-design-system` skill.
- Home = command console: 出席 SHUSSEKI masthead, SYSTEM ONLINE lamp, uptime,
  SERVEr URL, hazard stripes, and 4 mission tiles (送信/受信/診断/試験).
- Soshin screen: hotspot SSID/pass, live TOTP + countdown, broadcast counter,
  **BLE advertise result** (the crash fix below), server session state, ROOM MONITOR.
- Jushin screen: biometric, per-modality raw readings + local confidence meters
  (BLE/WiFi/ultrasonic via `shared`), fused device-side verdict, **server verdict
  from the ingest response** (fused + per-modality + rolling-code verification) +
  RTT, collapsible RAW report/server JSON, and a ROOM MONITOR that lists *every*
  device in the session (both phones) with their fused confidence — the "see
  anything/everything" feature.
- Smoke/E2E screens restyled; **maestro contracts preserved** (`e2e-summary`
  shows `phase: done`, `smoke-summary` shows `N/M automated passed`).
- Server URL is now an **on-device setting** (edit in CONFIG); each phone can
  point at the PC without a rebuild (`adb reverse` => `http://localhost:8787`,
  or enter the LAN IP for a second phone). Report/room-monitor endpoints get
  session auto-ensure, so no manual `POST /api/sessions` curl is needed.
- `HttpReporter.send` now returns the server's `presence` verdict + RTT for the UI.

**Hardware bugs found while E2E-ing two phones (fixed + verified on-device)**
- ❌→✅ **BLE advertise crash on Pixel 8a**: `ShussekiBleModule.onStartFailure`
  threw on a binder thread -> whole app killed. Root causes: (1) the beacon payload
  `room|node|code` overflowed the 31-byte legacy PDU (errorCode 1/`DATA_TOO_LARGE`)
  on the 30s code refresh; (2) re-advertising without stopping hit
  `ADVERTISE_FAILED_ALREADY_STARTED`. Fixed: payload is now `node|code` (room is
  runtime-known to Jushin), refresh does stop→start, and failures resolve to a
  result map `{ started, errorCode }` instead of an exception. UI shows the result.
- ❌→✅ **Smoke suite could hang forever** on the intermittent native
  `requestPermissionsAsync` stall (todo P5). `perms-request` + `ble-power` checks
  are now bounded by timeouts with a non-prompting `getPermissionsAsync` fallback,
  so `run=all` always terminates (last run: 7/10 automated passed; the 3 fails are
  the documented hardware/known items).
- ✅ Server round-trip over `adb reverse tcp:8787` now completes (server-ping PASS,
  session auto-ensure works, presence pipeline verified server-side).