# Comparative Evaluation of BLE, WiFi, and Ultrasonic Signals for Room-Level Continuous Attendance Monitoring

## Overview

Conventional attendance systems rely on active participation (swiping a card, signing a sheet, scanning a QR code), record presence at a single point in time, and often need extra anti-spoofing measures bolted on afterward. This project explores a passive alternative: fixed IoT nodes installed in a room continuously sense a phone's BLE, WiFi, and ultrasonic signals and report them to a server, which fuses the three signal types to determine whether a person is present in that specific room — for the whole duration they're there, not just at one checkpoint.

An Android app running on each user's phone acts as the mobile-side signal source, and performs a lightweight on-device biometric check (fingerprint/face) simply to give reasonable confidence that the phone is being carried by its actual owner rather than left behind by someone else to fake presence. This check is a supporting safeguard, not the core research focus.

## Research Question

Which single signal — BLE, WiFi, or ultrasonic — best supports accurate room-level presence detection, and does fusing them outperform any one signal alone?

## Core Idea

- **Fixed IoT nodes** (one or more per room) continuously capture:
  - BLE advertisement/RSSI data from the phone
  - WiFi RSSI data from the phone
  - Ultrasonic signal data (emitted/received between node and phone)
- Each node reports these raw values to a **central server**.
- The server evaluates each signal individually and in fusion to classify room presence.
- **Ground truth** for evaluation is established manually — a human headcount in the controlled test room — against which each method's output is compared.
- The Android app additionally performs an **on-device biometric check** (not periodic, just enough to establish it's the owner using the phone) as a basic anti-spoofing measure.

## What Makes This "Comparative"

The main contribution isn't the system alone — it's benchmarking:
1. **BLE-only** detection accuracy
2. **WiFi-only** detection accuracy
3. **Ultrasonic-only** detection accuracy
4. **Fused (BLE + WiFi + Ultrasonic)** detection accuracy

against the manually counted ground truth, in a controlled environment, to determine which modality (or combination) is most reliable for distinguishing "in this room" from "not in this room."

## Status

Early-stage research project. See `PLAN.md` for the working plan, open questions, and next steps.

## Repository Structure

npm-workspaces monorepo (see `docs/adr/0005-monorepo-structure.md`):

```
/shared/      # Pure, framework-free logic: rolling code, per-modality confidence,
              #   fusion, evaluation metrics, Zod report schemas. Vitest-tested.
/server/      # Hono fusion server (runs on Node via @hono/node-server, or
              #   deploy the same `app` on Cloudflare Workers). Ingests
              #   reports, re-verifies rolling codes, computes presence + evaluates
              #   against manual ground truth.
/app/         # Expo / React Native app with two modes (Soshin + Jushin) and the
              #   native modules (BLE, WiFi, ultrasonic, biometric) under modules/.
/evaluation/  # Comparative-study runner + scripts (BLE vs WiFi vs Ultrasonic vs Fused).
/docs/        # ADRs (docs/adr) and the test protocol (docs/test-protocol.md).
PLAN.md       # Working plan, open questions, order of operations.
README.md
```

## Quick start

Prerequisites: Node (>=20) + npm and, for the app, the Expo toolchain + a device
or emulator (the native modules require Android SDK / Xcode to build).

```bash
# install everything (npm workspaces)
npm install

# run all tests (65; shared/server/evaluation/app logic) with Vitest
npm test

# start the fusion server
cd server && npm run dev          # http://localhost:8787

# run the comparative evaluation demo
cd evaluation && npm run run:sample
```

### Server API
- `POST /api/sessions` — create a session (shares the rolling-code secret).
- `POST /api/reports` — ingest a Soshin/Jushin `DeviceReport`.
- `GET  /api/sessions/:id/presence` — latest per-device presence.
- `POST /api/sessions/:id/ground-truth` — record a manual headcount.
- `GET  /api/sessions/:id/evaluate` — room-level count error + per-modality metrics.

### App
```bash
cd app
npx expo start          # then run on Android/iOS
```
Pick **Soshin** (room-side: broadcasts the ultrasonic code + BLE beacon) or
**Jushin** (phone-side: connects to the Soshin WiFi, listens for the code,
reports BLE/WiFi). Set `EXPO_PUBLIC_SERVER_URL` to point at the fusion server
(default `http://10.0.2.2:8787` for the Android emulator).

> The app's Soshin/Jushin **logic** is fully unit-tested with `MockSensors`
> (Vitest). The native modules (`modules/expo-shusseki-*`) are the only
> device-dependent code and need a real build to exercise.

### Super-user console (HUD)
The UI is a dense NERV-style developer console for researchers, not a consumer
app — every screen dumps raw sensor values, per-modality + fused confidences,
server verdicts with RTT, roll code state, and a **ROOM MONITOR** that lists
*every* device currently reporting to the session (so one phone shows the other's
presence). Japanese labels (送信/受信/診断/試験) mirror the mode roles. The server
URL is editable on-device (CONFIG panel), so each phone can point at the PC —
`adb reverse` on USB devices, or the PC's LAN IP for a Wi-Fi phone — without a
rebuild. Sessions auto-ensure on the server, so no manual `POST /api/sessions`
step is needed to just run a report loop.

## Deployment & versioning

Every patch that is deployed to hardware is stamped with a build number from
`app/src/version.ts` (`BUILD`). Bump it on every change you ship, then deploy a
**self-contained APK** (JS bundle embedded — no Metro dependency, so there is no
stale-bundle ambiguity):

```bash
# bump BUILD in app/src/version.ts, then:
cd app/android
ENTRY_FILE=src/main.tsx gradlew assembleRelease   # see "Known issues" below
adb install -r app/build/outputs/apk/release/app-release.apk
adb logcat -s ReactNativeJS | grep "version"      # confirms the deployed patch
```

The running version is also shown on the app's home screen
(`device: <id> · vX.Y.Z+BUILD`) and logged to logcat at startup
(`[app] version vX.Y.Z+BUILD`), so you can always confirm which patch a device
is actually running.

For USB-connected devices the fusion server is reachable via
`adb reverse tcp:8787 tcp:8787` (the server binds `0.0.0.0`).

## What is implemented vs. next

**Done:** rolling-code TOTP + server re-verification, per-modality confidence,
fusion (noisy-or / average / weighted), evaluation metrics, the fusion server
with the full ingest→presence→evaluate pipeline, the two-mode Expo app with a
clean sensor seam, native-module scaffolds (BLE/WiFi/ultrasonic/biometric), the
comparative evaluation runner, and build versioning. Verified on real hardware
(Pixel 8a + Galaxy M34): BLE advertise/scan, WiFi RSSI, LocalOnlyHotspot, and
the ultrasonic mic all exercise on-device; the ultrasonic speaker→mic loopback
does **not** pass ~18.5 kHz on the Pixel 8a (see PLAN §3/§4 — expected on
consumer hardware).

**Next (PLAN §5 + todo.md):** spikes on `LocalOnlyHotspot` lifecycle,
background-mic reliability, and cross-OEM WiFi RSSI; lock the BLE combining rule
+ sample size; run controlled positive/negative data-collection sessions per
`docs/test-protocol.md`. Also outstanding: fix the Android **release** bundling
in this monorepo (`app/src/lib/../android` is gitignored/prebuild-generated, so
the `entryFile`/`root` overrides that make `assembleRelease` bundle are
local-only), root-cause the intermittent native `requestPermissionsAsync` hang,
and close the server round-trip over `adb reverse`.
