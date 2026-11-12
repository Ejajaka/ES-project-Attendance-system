# ESP32 hardware wiring — LCD, RFID, microSD, buttons, LED, buzzer, ultrasound

Everything below is driven by the firmware in `esp32-transmitter/`. The ESP32
is the room transmitter (BLE + WiFi + ultrasound) and also a standalone offline
attendance terminal: tapping an RFID card writes the tap to microSD and uploads
it to the register when WiFi is available.

> **Power:** power the ESP32 from **one** source only — USB while flashing, or
> the breadboard supply's **5 V** into `VIN`/`5V`. Do **not** connect USB and the
> breadboard 5 V at the same time. Join all grounds (ESP32, LCD, RFID, SD,
> buttons, buzzer, speaker).

## Pin map

| ESP32 pin | Module / part | Module pin | Notes |
|---|---|---|---|
| **GPIO21** | 16×2 LCD (PCF8574) | SDA | 5 V + GND; address 0x27 or 0x3F |
| **GPIO22** | 16×2 LCD | SCL | |
| **GPIO25** | Status LED (green) | anode | 220–330 Ω to LED, cathode to GND; ON = WiFi |
| **GPIO5** | MFRC522 RFID | SDA / SS / CS | 3.3 V + GND; SPI2 |
| **GPIO17** | MFRC522 RFID | RST | |
| **GPIO18** | MFRC522 + microSD | SCK | shared SPI clock |
| **GPIO19** | MFRC522 + microSD | MISO | shared SPI MISO |
| **GPIO23** | MFRC522 + microSD | MOSI | shared SPI MOSI |
| **GPIO4** | microSD module | CS | **5 V** + GND per the schematic (module regulator); FAT32 |
| **GPIO32** | Button 1 | one side | other side to GND; internal pull-up |
| **GPIO33** | Button 2 | one side | other side to GND; internal pull-up |
| **GPIO26** | Buzzer | + | active buzzer; − to GND (or NPN driver) |
| **GPIO27** | Ultrasonic speaker | + | piezo direct, or amp input; − to GND |
| **5V / VIN** | LCD backpack VCC | VCC | |
| **3V3** | MFRC522 VCC, microSD VCC | 3.3 V | **never 5 V** on the RFID/SD logic |
| **GND** | all modules | GND | common ground |

### MFRC522 (RFID)

```
MFRC522      ESP32
SDA/SS  ---  GPIO5
SCK     ---  GPIO18
MOSI    ---  GPIO23
MISO    ---  GPIO19
RST     ---  GPIO17
3.3V    ---  3V3
GND     ---  GND
IRQ         (not connected)
```

### microSD (SPI)

```
microSD       ESP32
CS      ---  GPIO4
SCK     ---  GPIO18   (shared with RFID)
MOSI    ---  GPIO23   (shared with RFID)
MISO    ---  GPIO19   (shared with RFID)
VCC     ---  5V      (module has its own 3.3 V regulator)
GND     ---  GND
```

The schematic shows the microSD module on **5 V** (its onboard regulator feeds
the card); the MFRC522 stays on **3.3 V**.

Use a FAT32 card (≤32 GB). The firmware creates:

```
/sdcard/attendance.csv      local mirror of every card tap (append-only)
/sdcard/rfid.csv            UID -> roll,name mapping (edit on a PC)
/sdcard/pending/*.json      taps awaiting upload (deleted after 2xx)
```

`rfid.csv` format (UIDs are uppercase hex, no `0x`):

```csv
uid,roll,name
A1B2C3D4,BL.SC.U4CSE24043,Roshna George
11AA22BB,BL.SC.U4CSE24054,Sanjeev
```

Unknown cards still mark attendance as `RFID-<UID>` / `Card <UID>` (two beeps)
so nothing is lost; add a mapping later if desired.

### Buttons

- **GPIO32 — SYNC:** short press uploads the pending SD queue immediately.
- **GPIO33 — CLEAR:** hold ~2 s deletes the pending SD queue (the server rows and
  `attendance.csv` are untouched). The button task only sets a flag; the network
  task performs the action.

Buttons use the ESP32's internal pull-ups; wire the other side to GND.

### Buzzer and ultrasonic speaker

- **GPIO26 — buzzer:** active-high. One short beep = known card, two short beeps =
  unknown card, longer beep = queue synced. For a passive buzzer, drive it through
  an NPN transistor (1 kΩ base resistor) and a flyback diode.
- **GPIO27 — ultrasonic speaker:** the firmware emits four alternating
  1.8 kHz / 2.6 kHz bursts (120 ms on, 220 ms gap), repeated. Connect a piezo
  tweeter directly (3.3 V square wave) or feed a small amplifier (e.g. PAM8403)
  into a speaker. The phone receiver listens for this pattern; the ESP32 does not
  need a microphone.

### LCD

Standard 16×2 with a PCF8574 I2C backpack: `SDA=21`, `SCL=22`, `VCC=5V`,
`GND=GND`. Line 1 shows the live present count; line 2 the connected WiFi SSID
(or `No WiFi`). Card taps temporarily replace both lines with `RFID` / roll.

### LED

`GPIO25` → 220–330 Ω → LED anode, LED cathode → GND. Three blinks at boot; ON
once the ESP32 joins `Shusseki-Room`.

## Behaviour summary

| Event | Firmware |
|---|---|
| Card tapped | map UID → roll/name, append `/sdcard/attendance.csv`, queue JSON, beep, LCD `RFID / <roll>`, trigger upload |
| WiFi joins | LED on, sync queue immediately, re-announce session |
| No WiFi | taps still work: SD log + queue; upload retried every 15 s while offline |
| SYNC button | upload pending queue now |
| CLEAR button (hold) | delete pending queue only |
| Server offline | queue stays on SD; next sync retries |

## Card details (name + roll)

The reader takes details from the card itself when they are written on it.
Two layouts are supported (ASCII text, a `ROLL|NAME` run somewhere in the
data):

1. **MIFARE Classic** — sector 1, blocks 4–6, key A default
   `FF FF FF FF FF FF` (fallbacks: sector 0 blocks 1–2, and the common keys
   `A0A1…`, `D3F7…`, `00…`). Write e.g. `BL.SC.U4CSE24043|Roshna George`.
2. **NTAG / Ultralight** — pages 4–15, raw text or an NDEF text record
   containing `ROLL|NAME`.

If the card has no record (UID-only cards are common), register it once:

1. Tap the card (the last UID is shown on the LCD and kept by the node).
2. Join the ESP32's open **`atlas`** WiFi from a phone/PC.
3. Open **http://192.168.4.1/** and save the roll + name for that UID.
4. Tap the same card again — it now marks attendance with those details.

The binding is written to `/sdcard/rfid.csv` **and** mirrored in NVS, so it
still works if the microSD is missing. Unknown cards are never lost: they are
recorded as `RFID-<UID>` / `Card <UID>` with a double beep, and can be named
later.

Some tags (including UID-only tokens) do not answer the ISO14443A **SELECT**
step. The reader then uses the anticoll UID and skips card-resident data; bind
that UID once via the registration page — after that, the LCD shows the
student's **name (line 1)** and **roll number (line 2)** for 4 s on every tap,
and the register shows **Name | Roll no | Present**.

For the current test build the microSD is disabled (`SD_ENABLED=0`) because an
unpowered SD adapter was loading the shared MISO line; keep it off the SPI bus
until it is powered/CS-clean, then set `SD_ENABLED=1`.

Attendance rows are non-expiring (only **CLEAR ATTENDANCE** resets them). The
server auto-enrolls the name/roll into the roster on the first tap and the
register/CSV show them.

The server endpoint is `POST /api/sessions/<id>/rfid` with:

```json
{"uid":"A1B2C3D4","studentId":"BL.SC.U4CSE24043","studentName":"Roshna George","at":1760000000000}
```

A mark is non-expiring in the register (only **CLEAR ATTENDANCE** resets it), so
an offline tap still counts after the report TTL.
