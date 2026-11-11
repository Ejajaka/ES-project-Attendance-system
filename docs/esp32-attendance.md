# ESP32 room transmitter + continuous attendance — implementation notes

This document records what was built on top of the Shusseki monorepo, how each
piece works, the exact configuration used, how to run it, and the known gaps.
Branch: `feat/esp32-transmitter-attendance`.

> **2026-11 hardware expansion:** the node also has an MFRC522 RFID reader,
> microSD attendance mirror/queue, two buttons (sync / clear), a buzzer, and the
> ultrasonic speaker restored on **GPIO27** (the WiFi LED stays on GPIO25).
> Wiring, pin map and SD file formats: [`hardware-wiring.md`](./hardware-wiring.md).

---

## 0. Current deployment — open `atlas` (2026-10-31)

> Sections 3–7 below describe the older Windows deployment (`Shusseki-ESP32` +
> `Shusseki-Room` NAPT). Keep them as history. The current setup uses one open
> network.

Topology:

```
phone ──WiFi──> "atlas" (ESP32 SoftAP, open, 192.168.4.1)
PC ── optional ──> "atlas"   only when the server/dashboard is needed
```

Firmware (`esp32-transmitter/src/main.c`):

- `AP_SSID "atlas"`, `AP_PASS ""`, `WIFI_AUTH_OPEN`: no password.
- `STA_SSID ""`: no uplink and no NAPT. The ESP32 does not route client traffic.
- BLE advertising starts before the server announce, so the beacon is visible
  with no server.
- `SERVER_URL` stays compile-time. The default (`192.168.137.1`) is not reachable
  from the `atlas` AP. This is fine for the on-phone trace.

The phone:

- Joins `atlas` with a bare-SSID `WifiNetworkSpecifier`.
- Samples WiFi every 0.5 s. BLE follows the 5 s presence tick.
- Applies the local rule without a server: absent only when the 5-sample average
  WiFi is weaker than −55 dBm and the latest BLE is weaker than −65 dBm.
- Drops failed reports silently. The trace keeps running off-network.

Runbook:

1. Flash: `cd esp32-transmitter && pio run -t upload -p /dev/ttyUSB0`.
   If that uploader fails, flash the built images directly with `esptool` at
   115200 baud.
2. Phone: WiFi on, then app → RECEIVER → ENGAGE.
3. Server/dashboard (optional): put the PC on `atlas` (it becomes
   `192.168.4.3`) and set the app's CONFIG server URL to
   `http://192.168.4.3:8787`. The PC loses internet while it stays on `atlas`.

---

## 1. What this adds, in one paragraph

The repo originally had a phone-based **transmitter (Soshin)** and **receiver
(Jushin)** plus a fusion server that compares BLE / WiFi / ultrasonic presence
against a manual headcount. This work turns the **ESP32 into the fixed room
transmitter** (no phone needed in the room), and adds a **continuous-attendance
layer** on top: a class roster, per-device presence timelines, a human register
page with CSV export, phone identity (roll + name) carried in each report, and a
JSON-file persistence option so a session survives a server restart.

---

## 2. Roles (do not mix these up)

| Role | Device | What it does |
|---|---|---|
| **Transmitter (Soshin)** | **ESP32** (room node) | Sole ultrasonic source; advertises the BLE beacon; raises the SoftAP; announces it to the server |
| **Receiver (Jushin)** | Phone(s) | Scan BLE, join the room AP, report BLE/WiFi/ultrasonic to the server |
| **Fusion server** | PC | Verifies rolling codes, computes presence, holds the roster + attendance |
| **(derived) room read-out** | ESP32 also *polls* | `GET /presence` and logs `present_devices=N` — the room node "sees" who's present |

Data flow:

```
phone --Report--> server --ingest--> per-modality confidence --> fused presence
                                                            \--> attendance timeline
ESP32 --BLE beacon+tone+SoftAP--> phone
ESP32 --announce hotspot + room poll <--> server
```

---

## 3. Network topology (as deployed)

```
phone ──WiFi──> "Shusseki-ESP32"  (ESP32 SoftAP, 192.168.4.1)
                    │  NAT (NAPT)
                    ▼
ESP32 STA ──WiFi──> "Shusseki-Room" (PC Mobile Hotspot, 192.168.137.1)
                    ▲
PC (server) ────────┘   http://192.168.137.1:8787
```

* Upload/uplink WiFi: `Aneesh314-4G` (PC internet).
* PC hotspot was renamed via the Windows tethering API from `Lenovo` to
  **`Shusseki-Room`** / pass **`shusseki123`**; gateway **`192.168.137.1`**.
* ESP32 SoftAP: **`Shusseki-ESP32`** / **`shusseki123`**.
* The ESP32 runs **NAPT** so phones on its AP can still reach the server
  (and get internet, which makes Android stay on the room AP).
* Windows firewall: inbound TCP **8787** allowed (rule `Shusseki-8787`,
  Profile Any) — the hotspot is a "Public" network.

> Why NAT matters: without it a phone joined to the room AP is on `192.168.4.x`
> and cannot reach the PC's `192.168.137.1`, so presence never reaches the
> server. With NAPT the room AP is a routed extension of the hotspot.

---

## 4. Files created / changed

### 4.1 ESP32 firmware — `esp32-transmitter/`

| File | Purpose |
|---|---|
| `src/main.c` | Entire transmitter: BLE advert, TOTP, SoftAP+NAPT, ultrasonic stamp, HTTP bootstrap, room poll |
| `platformio.ini` | Board/env (`esp32dev`, `framework=espidf`), 115200 monitor, custom partitions, `extra_scripts` |
| `sdkconfig.defaults` | 4 MB flash; BT (Bluedroid) + WiFi/BLE coexistence; WPA2-Enterprise support; **IP forward + NAPT** |
| `partitions.csv` | 4 MB flash, single 3 MB app partition (BT+WiFi exceeds the 1 MB default) |
| `scripts/epoch.py` | Injects `-DDEV_SEED_EPOCH=<unix>` at build time (clock fallback when NTP is slow) |

Key behaviour in `main.c`:

* **BLE**: legacy, non-connectable, manufacturer company id **`0xABCD`**, payload
  UTF-8 `"<nodeId>|<code>"`; refreshed on every TOTP step (stop→start).
* **TOTP**: RFC 6238, HMAC-SHA1, 6 digits, 30 s step — a *self-contained* SHA-1
  implementation, because ESP-IDF 6.1's mbedtls moved the HMAC/low-level SHA-1
  entry points behind internal headers. Verified byte-for-byte against
  `shared/src/rollingCode.ts`.
* **SoftAP**: `Shusseki-ESP32`, WPA2; **NAPT enabled** when the STA gets an IP.
* **STA**: joins `Shusseki-Room` for NTP + server access.
* **Ultrasonic**: alternating 1.8/2.6 kHz, 4×120 ms bursts / 220 ms gaps on
  LEDC **GPIO 27** (matches `ShussekiUltrasonicModule.kt`; piezo or amp+speaker).
  The WiFi status LED moved to GPIO 25.
* **Server bootstrap**: `POST /api/sessions` (secret base64) and
  `POST /api/sessions/:id/hotspot`; **re-announces every ~50 s** so a server
  restart doesn't drop the registration.
* **Room read-out**: `GET /api/sessions/:id/presence` every ~25 s, logs
  `[room] present_devices=N`.
* **Time**: NTP when STA is up, else the build-time seed (so the code rotates
  even offline).

`sdkconfig.defaults` (relevant lines):

```
CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y
CONFIG_BT_ENABLED=y
CONFIG_BT_BLUEDROID_ENABLED=y
CONFIG_ESP_COEX_ENABLED=y
CONFIG_ESP_COEX_SW_COEXIST_ENABLE=y
CONFIG_ESP_WIFI_ENTERPRISE_SUPPORT=y
CONFIG_LWIP_IP_FORWARD=y
CONFIG_LWIP_IPV4_NAPT=y
```

### 4.2 Shared logic — `shared/src/`

| File | Purpose |
|---|---|
| `attendance.ts` | `Student`/roster schema, `DeviceTimeline`, `buildAttendance()`, `attendanceToCsv()`, `ATTENDANCE_MAX_GAP_MS` |
| `attendance.test.ts` | 7 tests for matching, coverage, unrostered, CSV quoting |
| `types.ts` | `DeviceReport` gains optional `studentId` + `studentName` |
| `index.ts` | re-exports `attendance` |

`buildAttendance({sessionId, generatedAt, students, timelines})` matches each
roster entry to a timeline (by explicit `deviceId`, else reported `studentId`)
and returns rows with `present`, `firstSeen`, `lastSeen`, `presentMs`, and
`coverage`. Devices seen but not on the roster come back as `unrostered`.

### 4.3 Server — `server/src/`

| File | Change |
|---|---|
| `store.ts` | Roster storage; per-device **timeline** (`recordSample` with gap capping); `ensureStudent` (auto-enroll); `snapshot()`/`restore()` |
| `index.ts` | `POST/GET /api/sessions/:id/roster`, `GET /api/sessions/:id/attendance` (`?format=json\|csv\|html`), live register at `GET /attendance/:id`; auto-enroll on ingest |
| `server.ts` | Optional **JSON persistence** via `SHUSSEKI_DATA` (load on boot, save every 5 s + on exit) |
| `index.test.ts`, `store.test.ts` | Tests for attendance, CSV/HTML, auto-enroll, timeline/cap, roster |

Timeline semantics: `recordSample(sessionId, deviceId, studentId, at, present)`
credits `presentMs` only when the device was present at **both** ends of a gap,
capped at `ATTENDANCE_MAX_GAP_MS` (60 s) so a long absence isn't counted as
presence.

The register page (`attendanceHtml()`) is dependency-free HTML: roster textarea
(`roll,name[,deviceId]` per line) POSTed to `/roster`, a live table that
auto-refreshes every 5 s, unrostered devices, and a **download CSV** link.

### 4.4 App — `app/src/`

| File | Change |
|---|---|
| `settings.ts` | `studentId`, `studentName` |
| `lib/presets.ts` | defaults for the two new fields |
| `App.tsx` | CONFIG fields **STUDENT ID (ROLL NO)** / **STUDENT NAME**; deep links `shusseki://rx` / `tx` with auto-engage; `rx` accepts `?roll=&name=` |
| `JushinScreen.tsx` | `autoEngage` prop; passes `studentId`/`studentName` into the controller |
| `SoshinScreen.tsx` | `autoEngage` prop (symmetry) |
| `lib/modes/jushin.ts` | report carries `studentId`/`studentName`; biometric made **non-fatal** (`safeBio` try/catch + 4 s timeout); WiFi join made **fire-and-forget** |
| `E2eScreen.tsx` | receiver id is now unique per phone (`${DEVICE_ID}-${role}`) so two phones don't collapse into one roster row |
| `version.ts` | `BUILD` bumped (32 as of this branch) |
| `android/app/build.gradle` | **local/generated** (gitignored): bundler `root = ${appRoot}/..` fix (see §7) |

Deep-link identity is the key automation seam:

```
adb shell "am start -a android.intent.action.VIEW \
  -d 'shusseki://rx?roll=bl.sc.u4cse24001&name=Ada%20Lovelace' \
  -n com.shusseki.app/.MainActivity"
```

(`&` must be quoted for the device shell, or `name` is dropped.)

---

## 5. Verification (what "working" looked like)

* ESP32 serial: `STA got IP 192.168.137.79`, `NAPT enabled on SoftAP`,
  `SNTP synced`, `POST /api/sessions -> 201`, `POST .../hotspot -> 201`,
  `[room] present_devices=2`.
* Rolling code verified: firmware `[tx] code=915147` ==
  `generateTOTP(secret, <same unix>)` from `shared`.
* Two phones, all three channels:

```
device=phone-mui8go8e present=True fused=1.000
   ble connected (-40 dBm · esp32-tx1)
   wifi connected (-35 dBm)
   ultrasonic connected (heard · snr 0.0)
```

* Attendance sheet + CSV:

```
present 2/2
bl.sc.u4cse24001,Ada Lovelace,present,phone-muibhses,...,20468,1.00
bl.sc.u4cse24002,Bob Kane,present,phone-muibht3m,...,30324,1.00
```

---

## 6. Runbook (repeat every session)

1. **Network:** PC on internet WiFi; PC Mobile Hotspot ON → `Shusseki-Room` /
   `shusseki123` (`192.168.137.1`).
2. **Server:**
   ```powershell
   cd C:\dev\shusseki\server
   $env:SHUSSEKI_DATA="$PWD\store.json"   # or, in cmd: set SHUSSEKI_DATA=...
   npx tsx src/server.ts
   ```
   If it says `EADDRINUSE`, one is already running — stop it first:
   ```powershell
   Get-NetTCPConnection -LocalPort 8787 -State Listen |
     ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
   ```
3. **ESP32:** power it (any 5 V). It auto-boots and does everything; no UI.
4. **Phone(s):** join WiFi **`Shusseki-ESP32`** (`shusseki123`); open **Shusseki**
   → **RECEIVER** → **CONFIG** → roll + name → **ENGAGE**.
5. **Register:** open `http://192.168.137.1:8787/attendance/sess-1`; paste the
   roster (`roll,name` per line) → SAVE ROSTER → watch PRESENT → download CSV.

---

## 7. Build recipes

### ESP32
```powershell
cd C:\dev\shusseki\esp32-transmitter
pio run -t upload --upload-port COM5
```
First flash needs the **CP210x USB-UART driver** (the board enumerates as
`VID_10C4/PID_EA60`); install with `pnputil /add-driver silabser.inf /install`
(elevated). The image is ~1.3 MB ; RAM ~18 %.

### Android app
```powershell
cd C:\dev\shusseki\app\android
$env:EXPO_PUBLIC_SERVER_URL="http://192.168.137.1:8787"
$env:ANDROID_HOME="C:\Users\sanje\AppData\Local\Android\Sdk"
.\gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a
adb install -r app\build\outputs\apk\release\app-release.apk
```

Release-bundling fix (in the gitignored `app/android/app/build.gradle`): the
Expo `export:embed` bundler uses the **monorepo root** as Metro's project root,
so the React-Native plugin's `root` must point there too:

```gradle
def appRoot = project.projectDir.getParentFile().getParentFile()
entryFile = file("${appRoot}/src/main.tsx")
root = file("${appRoot}/..")           // repo root (was the template's '../..')
```

Because `app/android/` is generated/gitignored, this override is local — it
should live in the prebuild config to persist.

---

## 8. Known gaps / next steps

* **WiFi channel is the flaky one.** It only reads "connected" while the phone is
  joined to the room AP (`Shusseki-ESP32`); Android roams to networks with
  internet. NAT mitigates this (the room AP now has internet), but a phone can
  still roam. BLE + code-over-BLE ultrasonic are reliable regardless.
* **Device IDs regenerate per app launch** (`identity.ts`), so the register
  accumulates stale `phone-…` rows. Persist the device id or filter by age.
* **App settings are in-memory** (`studentId`/`studentName`/`serverUrl`) — re-enter
  after an app restart. Needs `expo-file-system` persistence.
* **Sessions aren't persisted** (only reports/rosters/timelines are), so after a
  server restart the rolling secret is gone until the next `POST /api/sessions`
  (the ESP32 re-announces automatically).
* **Ultrasonic decode** on the phone still reports `decode_failed`; the presence
  signal rides over BLE today (code-over-BLE). Tuning the Goertzel thresholds or
  adding an amp/speaker remains open.
* **Hard-coded network values** (`SERVER_URL`, hotspot SSID/pass) live in
  `esp32-transmitter/src/main.c`; changing networks means reflashing (or editing
  CONFIG → SERVER URL in the app).
