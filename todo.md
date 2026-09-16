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

## P8 — CRT-console restyle pass (session 2026-08-30, part 2)
Second visual pass, per user direction. Portrait-first, pixel-terminal voice:

- **Font**: bundled **Departure Mono** (OFL, Helena Zhang) via expo-font as the
  one console face — lo-fi monospaced pixel type at multiples of its native
  11px grid. All synthetic bolding stripped (single-weight face). Replaced the
  previous Bebas Neue experiment (wrong vibe).
- **No grey chrome**: panels are colour-blocked — solid neon tone header bar
  with black ink, tone-tinted edge (dimFor), corner crop marks, black body.
  No thin grey outlines anywhere.
- **Dithering**: unicode shade-block dither bands (`▓▒░` via Dither) as seams
  under panel headers, around interjections, and in dividers — CRT gradient
  texture without images. Scanlines retained.
- **Popups**: full-screen **AlertOverlay** system — state changes slam the
  screen: Jushin PATTERN GREEN (RECOGNIZED) / PATTERN RED (TARGET LOST) on
  server-verdict flips, SENSOR FAULT on tick errors, ADVERTISE FAULT on BLE
  beacon failure (Soshin), TRIAL COMPLETE / TRIAL FAULT (E2E). Room-monitor
  rows are tappable → UNIT STATUS popup with the full verdict JSON. Acknowledged
  via `了解 · ACKNOWLEDGE`.
- **Orientation**: portrait (per user preference — landscape was "not easy to
  use"; the row layouts now wrap responsively so panels stack in portrait and
  go 2-up on wide screens).
- **Landscape**: still supported via flexible wrap (minWidth 300 cols, flexBasis
  tiles); app.json locked to portrait.
- Verified on-device v0.1.0+13: Y home console renders with pixel font, E2E
  completes ("TRIAL COMPLETE" popup + ACK works, maestro `phase: done` intact).

## P9 — Console-integration pass (session 2026-08-30, part 3)
User feedback round: "no grey lines", "popups missing", "plastered boxes",
"checks list too long", "can't see buttons":

- **Flush console canvas**: mode screens (Soshin/Jushin/E2E/Smoke) dropped
  their outer margins/gaps — panels are now full-bleed bands edge-to-edge,
  one continuous screen surface. ConsoleHeader hazard "dotted" rails replaced
  with flat 4px amber/purple bands; header is seamless with the canvas.
- **Popups with dumps**: smoke checks now report through the full-screen alert
  (CHECK PASSED / CHECK FAILED + the check's output dump; SUITE COMPLETE +
  full tail dump + FAILURES list). No inline green status updates on rows;
  rows are compact (label + RUN only). Summary plate unchanged for maestro.
- **EXIT always visible**: header EXIT button on every mode screen (top-right,
  right next to the state); no more hunting below endless lists. Check rows
  compacted; log panels bounded.
- **E2E events expandable**: SERVER EVENT BUS rows are tappable — tap to
  expand in place (▼) revealing timestamp + full JSON detail. Event/log
  panels are internally scrollable and height-bounded so the phase plate and
  controls stay visible in portrait.
- Verified on-device v0.1.0+17: popup-with-dump for single checks and full
  suite, TRIAL COMPLETE popup, event-row expansion (SOSHIN · transmit ▼ →
  at-ts + detail), maestro text contracts intact.

## P10 — Transmitter/Receiver rename + preset rooms + link stats (session 2026-09-17) — CODE DONE ✅, 2-PHONE FINAL PASS PENDING ⏳

Full narrative: `docs/session-2026-09-17-report.md`.

**Delivered (114 tests, BUILD 21 APK on the LG):**
- Plain-language roles: TRANSMITTER (Soshin) / RECEIVER (Jushin) everywhere an
  operator looks — home tiles, console headers, monitors, alerts, docs
  (`app/src/lib/roles.ts`, `CONTEXT.md`, `README.md`).
- 3 preset rooms (`app/src/lib/presets.ts`): ROOM 01/02/03 pin roomId,
  sessionId, SSID hint + rolling secret; home picker; CONFIG simplified.
- Hotspot auto-join: `POST/GET /api/sessions/:id/hotspot`; transmitter
  announces the live `AndroidShare_XXXX`, receiver auto-joins it.
- Link stats (`shared/src/link.ts` + `/presence` `link` field): per-channel
  `connected/degraded/lost` + quality for BLE/WiFi/ultrasonic; receiver
  `LINK TO TRANSMITTER` panel; transmitter monitor `B● W◐ U○` chips + age +
  tap-for-JSON; `scripts/device-e2e.sh` + `maestro/{tx,rx}-console.yaml`.
- Fixed on-device bugs: **base64 secret mismatch** (codes always rejected),
  missing `CHANGE_NETWORK_STATE`, BLE scan `ConcurrentModificationException`,
  dishonest WiFi RSSI, non-idempotent hotspot re-engage.
- **Single-phone demo path**: `shared/src/simulator.ts` + `npm run sim:rx`
  posts exact receiver-shaped reports (valid rolling code) and prints the
  server verdict — spot-checked on BUILD 21: `codeValid=true fused=1.00
  B● W● U● · 96%`, transmitter monitor `3 FOUND · 3 LINKED`. Smoke suite now
  **8/10** (only the two single-device artifacts fail: BLE scan with no peer,
  ultrasonic self-loopback).
- Monitor rows reworked to a two-line `DeviceLinkRow` so chips/quality/age no
  longer truncate in portrait.

**Next session — do these in order:**
1. **Finish the two-phone pass on BUILD 21** (Pixel battery died):
   - `scripts/device-e2e.sh setup` → `maestro --device <Pixel> test maestro/tx-console.yaml`
     → `maestro --device <LG> test maestro/rx-console.yaml`
     → `python3 scripts/approve-wifi.py <LG serial>` (Android 10 asks for
     approval before joining the hotspot).
   - Success gate: `GET /api/sessions/sess-1/presence` shows the receiver with
     `wifi: connected` and `ultrasonicServerValid: true` (server path already
     proven by `npm run sim:rx`), and the TX ROOM MONITOR lists it with chips.
2. **Ultrasonic cross-device tuning**: LG listener sees `runs=29` vs the
   expected burst cadence (`present=false`). Inspect
   `ShussekiUltrasonicModule.kt` burst params (`stampFreq 1800`, `bursts`,
   `burstFrames`, `onToneRatio`) against the TX emission length; try a
   calibration sweep (15–18.5 kHz) or tighten the run-count window.
3. **Persist `DEVICE_ID`** (`app/src/identity.ts`) so relaunches don't create
   ghost devices in the server roster / room monitor.
4. **Deep-link auto-engage**: `shusseki://tx` / `shusseki://rx` (parse in a
   testable `app/src/lib/launch.ts`, auto-run `start()`), so both consoles can
   be driven without UI taps (and survive lock screens).
5. **Harden console state across Activity recreation** (only hotspot is
   idempotent today): consider re-engaging on mount when a native session is
   still alive, or persisting the running flag.
6. Optional polish: filter stale devices (age > 60 s) in both monitors or show
   them greyed; add a "TX identity" row on the receiver (`link.modalities[ble]
   .detail` already carries `-55 dBm · phone-xxxx`).

**Build env reminders:** `GRADLE_OPTS=-Djava.net.preferIPv4Stack=true`, delete
stale `node_modules/expo-modules-core/android/.cxx` on `No compatible library
found`, and `EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:8787` is baked at bundle
time — each phone needs `adb reverse tcp:8787 tcp:8787`.