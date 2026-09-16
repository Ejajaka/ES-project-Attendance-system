# Session report — 2026-09-17

**Goals (from the operator):**
1. Rename Soshin/Jushin so the roles are unambiguous — keep the words as brand,
   but make TRANSMITTER / RECEIVER (user mode) obvious.
2. Replace manual room creation with **3 preset rooms** that can be created/joined
   quickly.
3. Show **connection stats** both ways: a receiver must see its link to the
   transmitter; the transmitter must see every found device and each device's
   link back to it. The link rests on the three channels: **BLE, WiFi, ultrasonic**.

**Result:** all three landed in code with TDD (67 → 110 tests), a release APK
was built and installed on both phones, and one full two-phone run was observed
(`BLE connected −46 dBm`, live link chips server-side). One critical bug was
found and fixed during on-device testing: the rolling-code **secret was sent
raw to a server that decodes it as base64**, so ultrasonic code verification
always failed on device. The final two-phone confirmation on BUILD 20 was cut
short when the Pixel's battery died.

---

## 1. Terminology — `TRANSMITTER` / `RECEIVER`

Human surfaces now say the plain role first, brand second. The wire schema
(`mode: "soshin" | "jushin"`) is deliberately unchanged for compatibility.

- `app/src/lib/roles.ts` (+ test) — single source of truth:
  `roleLabel("soshin") === "TRANSMITTER · SOSHIN"`,
  `roleLabel("jushin") === "RECEIVER · JUSHIN"`, `where` = ROOM / USER PHONE.
- Home console tiles (`app/src/App.tsx`): big `TRANSMITTER` / `RECEIVER`,
  Japanese + Soshin/Jushin as the accent line.
- Console headers: `TRANSMITTER · SOSHIN`, `RECEIVER · JUSHIN`.
- Room-monitor rows, E2E event rows, alerts, hints and CONFIG labels updated.
- `CONTEXT.md` glossary now defines **Transmitter (Soshin)** / **Receiver
  (Jushin)**; `README.md` updated; `docs/two-device-e2e.md` reworked.

## 2. Preset rooms

- `app/src/lib/presets.ts` (+ test) — `ROOM_PRESETS`: ROOM 01/02/03
  (`room-1`/`sess-1` …), each with a distinct SSID hint and rolling secret.
  `applyPreset(settings, id)` is pure and does not mutate; `DEFAULT_SETTINGS`
  is preset 1. `settings.presetId` added.
- Home screen has a **ROOM PRESET** picker (tap to bind); CONFIG no longer asks
  for room/session/SSID/secret — only server URL + a manual hotspot fallback.
- **Hotspot auto-join** (the quick join piece): Android generates the
  LocalOnlyHotspot SSID at runtime, so a preset cannot know it. The transmitter
  now publishes its live SSID/passphrase to the session:
  - `POST /api/sessions/:id/hotspot` / `GET /api/sessions/:id/hotspot`
    (`server/src/index.ts`, `server/src/store.ts`, tested).
  - `announceHotspot` / `fetchHotspot` in `app/src/lib/server.ts` (+ tests).
  - `SoshinScreen` announces at ENGAGE and re-announces on every 30 s step;
    `JushinScreen` fetches the announcement at ENGAGE and joins that SSID,
    falling back to CONFIG values.

## 3. Link stats (BLE + WiFi + ultrasonic)

- `shared/src/link.ts` (+ 11 tests) — `summarizeLink(report, {ultrasonicValid})`
  returns per-channel `state` (`connected` / `degraded` / `lost`), `quality`
  (0–1), raw values and a console `detail`; overall state is the weakest
  channel, overall quality the minimum. Rules:
  - BLE: strongest reading; ≥ −75 dBm connected, ≥ −85 degraded, else lost;
    no beacon → lost.
  - WiFi: not joined → lost; joined is never lost (very weak → degraded);
    RSSI quality scales −90…−60 dBm.
  - Ultrasonic: not heard → lost + `missReason`; heard but code rejected →
    degraded; heard + valid → connected, quality scaled by SNR.
  - The server passes its **verified** code validity, never trusting the
    client's claim (`server/src/presence.ts` adds `link` to `DevicePresence`).
- Receiver UI: `LINK TO TRANSMITTER` panel — overall state lamp, three channel
  rows with raw reading + quality meter, uplink RTT, join source.
- Transmitter UI: ROOM MONITOR header shows `${n} FOUND · ${m} LINKED`; each row
  shows `B● W◐ U○`, quality %, age and tap-for-full-JSON.
- `app/src/lib/linkView.ts` (+ tests) — glyphs, chips, ages, modality labels.

## Bugs found by on-device testing (fixed)

1. **Rolling-code secret encoding mismatch (critical).** The app sent the
   secret as a raw string; `SessionRegistry` decodes `Buffer.from(secret,
   "base64")`, so the server key never matched the transmitter's TOTP — every
   `ultrasonicServerValid` was false on device (`code REJECTED` in link stats).
   Fixed by adding `encodeBase64Utf8` (`shared/src/base64.ts`, tested with
   ASCII/UTF-8 vectors) and encoding at every wire boundary
   (`ensureSession`, `E2eController.ensureSession`).
2. **`CHANGE_NETWORK_STATE` missing** — the receiver's WiFi join threw
   `SecurityException` on Android 10. Added to `app/app.json` and the generated
   `AndroidManifest.xml`.
3. **BLE `ConcurrentModificationException`** — scan callbacks mutated the
   result list while `toReadings()` iterated it. Snapshot under the monitor.
4. **WiFi RSSI honesty** — `getObservation` reported RSSI for whatever network
   was connected, even when not the transmitter. Now `null` unless associated.
5. **Hotspot re-engage after Activity recreation** — `startHotspot` rejected
   with "hotspot already running" while the module still held the reservation.
   Now idempotent: returns the existing reservation's SSID/passphrase.

## Tests & checks

- `npm test`: **110 passed / 15 files** (was 67/10).
- New test files: `shared/src/link.test.ts` (11), `shared/src/base64.test.ts`
  (3), `app/src/lib/presets.test.ts` (6), `app/src/lib/server.test.ts` (8),
  `app/src/lib/roles.test.ts` (3), `app/src/lib/linkView.test.ts` (7), plus
  server additions (presence link ×3, hotspot API ×2).
- `npm run typecheck` clean (shared/server/app/evaluation).
- `npm run lint` (biome) still fails repo-wide on pre-existing formatting noise;
  the touched files were not formatted to biome's tab style on purpose.

## Single-phone demo & verification (added after the first pass)

The Pixel's battery died before the last two-phone run, so a **simulated
receiver** was added to exercise the whole pipeline with one phone:

- `shared/src/simulator.ts` (+ tests) — `simulateReceiverReport()` builds the
  exact report the app posts (transmitter BLE reading carrying the rolling
  code, joined WiFi, ultrasonic stamp), or an honest "no transmitter" report.
- `scripts/simulate-receiver.ts` / `npm run sim:rx` — reads the transmitter's
  announced hotspot from the session, then posts a report every interval and
  prints the server verdict + link chips.
- Live run against the LG as TRANSMITTER (BUILD 21):
  `[sim] transmitter found: AndroidShare_2719 @ phone-mu4gkght` →
  every tick `present=true fused=1.00 codeValid=true · B● W● U● · 96%`.
  This proves the **base64 secret fix end-to-end**: a code generated from the
  human-readable preset secret verifies server-side via the app's exact wire
  encoding.
- The transmitter's ROOM MONITOR then showed `3 FOUND · 3 LINKED` with
  `B● W● U● · CONNECTED · 96% · CODE ✓` rows. Monitor rows were reworked into
  a two-line `DeviceLinkRow` (`app/src/components/DeviceLinkRow.tsx`) after the
  first screenshot showed portrait truncation.
- Smoke suite on the LG improved to **8/10 automated passed** after the
  WiFi-observation check was made honest (a missing transmitter AP is a valid
  observation; only "joined but no RSSI" is a failure). Remaining failures are
  the two single-device artifacts: BLE scan (no peer advertising) and the
  ultrasonic self-loopback.

## On-device evidence

| Build | Device | Result |
|---|---|---|
| +18 | Pixel (TX) | OPERATIONAL, code rotating, `ADVERTISING ✓`, announce PUBLISHED |
| +19 | LG (RX) | LINK ACTIVE, server: `ble connected −46 dBm`, `wifi lost`, `ultrasonic degraded` |
| +20 | LG (TX) | OPERATIONAL; announce `AndroidShare_6385`; smoke 7/10 |
| +21 | LG (TX) + sim | OPERATIONAL; sim `codeValid=true fused=1.00 B● W● U●`; monitor 3 FOUND · 3 LINKED; smoke **8/10** |

Artifacts:
- `maestro/tx-console.yaml`, `maestro/rx-console.yaml` — drive the real consoles.
- `scripts/device-e2e.sh` — install/permissions/reverse/launch/presence helper.
- `scripts/approve-wifi.py` — taps the LG's system `NetworkRequestDialogActivity`
  CONNECT button once it enables (Android 10 needs this manual approval step).

## Known issues / gaps for the next session

1. **Two-phone confirmation on BUILD 21 was not completed** — the Pixel ran out
   of charge. The server-side path is proven by the simulator (valid code +
   all-green link), but the real receiver's WiFi approval + code path should be
   re-confirmed: `scripts/device-e2e.sh setup`, TX flow on the Pixel, RX flow on
   the LG, `python3 scripts/approve-wifi.py <LG serial>`, then check
   `GET /api/sessions/sess-1/presence` for `wifi connected` and
   `ultrasonicServerValid: true`.
2. **Ultrasonic cross-device detection fails on the LG** — TX 1.8 kHz bursts,
   LG listener reports `runs=29 expected=24 present=false` (too many on-runs;
   likely ambient 1.8 kHz or AGC). BLE+WiFi carry presence meanwhile. Consider
   calibrating burst cadence/thresholds or adding a sweep.
3. **Device IDs are per-process** (`identity.ts` regenerates on each launch) —
   stale devices accumulate in the server's room roster across restarts (visible
   as the `smoke-tester`/older sim rows in the monitor). Persist the ID
   (e.g. via `expo-file-system`) or filter by age in the monitors.
4. **No deep-link auto-engage** for tx/rx consoles; adding
   `shusseki://tx` / `shusseki://rx` would make locked-screen / headless runs
   possible (suggested, not implemented).
5. Activity recreation resets console state (JS) while native reservations
   survive; only the hotspot path is idempotent so far. A `useEffect` re-engage
   or persisted controller state would harden it.
6. Build environment quirks (Arch): JVM must prefer IPv4
   (`GRADLE_OPTS=-Djava.net.preferIPv4Stack=true`), and stale
   `node_modules/expo-modules-core/android/.cxx` must be deleted if CMake fails
   with `No compatible library found`. `EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:8787`
   is baked at bundle time; `adb reverse tcp:8787` must be set per device.

## Deployment state

BUILD 21 APK (`app-release.apk`, embedded JS) is installed on the LG. The
server runs on the PC (`./start-server.sh`); `adb reverse tcp:8787` is set on
the LG. The Pixel dropped off USB with a dead battery and is untouched since.
