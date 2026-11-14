# Shusseki - continuous room attendance with BLE, WiFi and ultrasound

Shusseki is a room-level continuous attendance system. A fixed ESP32 node
advertises a BLE rolling code, hosts the room WiFi network and emits an
ultrasonic presence stamp. Phones in the room report BLE, WiFi and ultrasonic
measurements to a fusion server, which maintains a live roster and a human
register. An RFID reader on the node also marks students who tap a card.

The project compares BLE-only, WiFi-only, ultrasonic-only and fused presence
against a manually counted ground truth.

## Components

```
/shared/            Pure TypeScript logic: rolling codes, confidence, fusion,
                    evaluation metrics and report schemas. Vitest-tested.
/server/            Hono fusion server: ingest reports, verify codes, presence,
                    roster, attendance register, live dashboard and CSV export.
/app/               Expo / React Native app:
                      Soshin (transmitter) - phone-side beacon fallback
                      Jushin (receiver)    - BLE/WiFi/ultrasound reporting
                    Native modules for BLE, WiFi, ultrasonic and biometric.
/esp32-transmitter/ ESP-IDF firmware for the room node:
                      BLE beacon + open `atlas` SoftAP + NAPT
                      MFRC522 RFID reader + I2C LCD + active/passive buzzers
                      20 kHz ultrasonic transmitter on GPIO27
/evaluation/        Comparative-study runner (BLE / WiFi / ultrasonic / fused).
/docs/              Wiring, attendance flow, test protocol, runbooks and ADRs.
```

The current node build does **not** use a microSD card or push buttons. Card
bindings live in NVS and taps are posted directly to the server.

## Quick start

Prerequisites: Node >= 20 and npm. For the app, use the Expo toolchain and an
Android device/emulator with the Android SDK.

```bash
# install workspace dependencies
npm install

# run the full Vitest suite
npm test

# start the fusion server on http://localhost:8787
npm run dev:server

# run the comparative evaluation sample
cd evaluation && npm run run:sample
```

### Server API

- `POST /api/sessions` - create a session (shares the rolling-code secret).
- `POST /api/reports` - ingest a `DeviceReport`.
- `POST /api/sessions/:id/telemetry` - 0.5 s graph sample.
- `GET  /api/sessions/:id/series` - live BLE/WiFi/SNR series.
- `GET  /dashboard/:id` - live browser charts.
- `GET  /api/sessions/:id/presence` - latest per-device presence.
- `POST /api/sessions/:id/hotspot` - publish the room hotspot.
- `GET  /api/sessions/:id/hotspot` - read the room hotspot.
- `POST /api/sessions/:id/ground-truth` - record a manual headcount.
- `GET  /api/sessions/:id/evaluate` - count error and per-modality metrics.
- `GET  /api/sessions/:id/register` - live attendance register.
- `POST /api/sessions/:id/rfid` - card tap (UID -> student).
- `POST /api/sessions/:id/rfid/bind` - bind a phone-entered UID to a student.

### App

```bash
cd app
npx expo start
```

Pick **TRANSMITTER** (phone-side fallback) or **RECEIVER** (joins the ESP32's
open `atlas` network and reports BLE/WiFi/ultrasound). Set
`EXPO_PUBLIC_SERVER_URL` to the server address (default
`http://10.0.2.2:8787` for the Android emulator). The receiver console shows
raw sensor values, per-modality and fused confidence, the server verdict and a
live BLE/WiFi trace.

The receiver's identity is locked after enrollment. To change the student or
RFID UID, clear the app data, or edit the roster from the server register page.

## ESP32 room node

Wiring, pin map and RFID card details: [`docs/hardware-wiring.md`](docs/hardware-wiring.md).

```bash
cd esp32-transmitter
pio run                 # build
pio run -t upload       # flash (115200 baud)
pio device monitor      # serial log
```

The node:

- advertises `esp32-tx1|<TOTP code>` over BLE;
- raises the open `atlas` SoftAP and routes clients to the LAN via NAPT;
- emits four alternating 20/19.6 kHz bursts on GPIO27;
- polls the server for the live attendance count and shows it on the LCD;
- reads MFRC522 cards and posts the UID to the attendance register;
- shows a student's name (scrolling if long) and roll number on a tap;
- beeps once for a known card, twice for an unknown/new card or saved mapping.

## Tests and deployment

```bash
npm test
npm run typecheck
```

Every APK carries a build number from `app/src/version.ts` (`BUILD`), shown on
the home screen and logged at startup as `[app] version vX.Y.Z+BUILD`. Build a
self-contained release APK with the Expo/Android toolchain and install it with
`adb install -r app/build/outputs/apk/release/app-release.apk`.

For USB-connected devices the server is reachable with
`adb reverse tcp:8787 tcp:8787`.

## Current limitations

- A single ultrasonic beacon is not a strict room boundary: 20 kHz leaks
  through open doors and walls, so "tone heard" only means the tone is present.
  The BLE/WiFi gate is the actual room-presence decision.
- The node has no offline queue. A card tap made while the server is unreachable
  still resolves from NVS and displays on the LCD, but is not replayed later.
- The phone receiver must be on the room network to reach the server; the
  `atlas` SoftAP + NAPT path is the fallback.
