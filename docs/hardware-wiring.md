# ESP32 hardware wiring - LCD, RFID, LED, buzzers, ultrasound

Everything below is driven by the firmware in `esp32-transmitter/`. The ESP32
is the room transmitter (BLE + WiFi + ultrasound) and a standalone attendance
terminal: tapping an RFID card marks that student in the server register.

The current build does **not** use a microSD card or the two push buttons.
Card bindings are stored in NVS (flash) and the tap is sent to the server over
WiFi. No local queue is kept.

> **Power:** power the ESP32 from **one** source only - USB while flashing, or
> the breadboard supply's **5 V** into `VIN`/`5V`. Do **not** connect USB and the
> breadboard 5 V at the same time. Join all grounds (ESP32, LCD, RFID, buzzers).

## Pin map

| ESP32 pin | Module / part | Module pin | Notes |
|---|---|---|---|
| **GPIO21** | 16x2 LCD (PCF8574) | SDA | 5 V + GND; address 0x27 or 0x3F |
| **GPIO22** | 16x2 LCD | SCL | |
| **GPIO25** | Status LED (green) | anode | 220-330 ohm to LED, cathode to GND; ON = WiFi |
| **GPIO5** | MFRC522 RFID | SDA / SS / CS | 3.3 V + GND; SPI2 |
| **GPIO17** | MFRC522 RFID | RST | |
| **GPIO18** | MFRC522 RFID | SCK | |
| **GPIO19** | MFRC522 RFID | MISO | |
| **GPIO23** | MFRC522 RFID | MOSI | |
| **GPIO26** | Active buzzer | + | direct drive; - to GND; 3.3 V type |
| **GPIO27** | Passive buzzer / ultrasound | + | direct drive; - to GND; piezo, 20 kHz |
| **5V / VIN** | LCD backpack VCC | VCC | |
| **3V3** | MFRC522 VCC | 3.3 V | **never 5 V** on the RFID logic |
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

### Buzzer and ultrasonic speaker

Both buzzers are wired **directly** to the ESP32; there is no transistor.

- **GPIO26 - active buzzer:** one short beep = known card; two short beeps =
  unknown/new card or a saved mapping. Connect buzzer **+ to GPIO26** and
  **- to GND**. Use a 3.3 V active buzzer; a 5 V buzzer may be too quiet or
  fail to start from a 3.3 V GPIO. If the buzzer draws more than about 12 mA,
  switch it through an NPN transistor instead of driving it directly.
- **GPIO27 - passive buzzer / ultrasonic speaker:** the firmware emits four
  alternating 20 kHz / 19.6 kHz bursts (120 ms on, 220 ms gap), repeated.
  Connect the piezo **+ to GPIO27** and **- to GND**; a 100-330 ohm series
  resistor is optional. A piezo is not inductive, so no flyback diode is
  needed. If you use a magnetic/coil passive buzzer, add a diode across it and
  prefer a transistor driver. The phone receiver listens for the 20 kHz
  pattern; the ESP32 does not need a microphone.

### LCD

Standard 16x2 with a PCF8574 I2C backpack: `SDA=21`, `SCL=22`, `VCC=5V`,
`GND=GND`. Line 1 shows the live present count; line 2 the connected WiFi SSID
(or `No WiFi`). A card tap temporarily replaces both lines with the student's
name (scrolling if long) and roll number, then restores the count.

### LED

`GPIO25` -> 220-330 ohm -> LED anode, LED cathode -> GND. Three blinks at boot;
ON once the ESP32 joins `Shusseki-Room`.

## Behaviour summary

| Event | Firmware |
|---|---|
| Card tapped | resolve UID from NVS/server, beep, LCD name + roll, POST `/rfid` to the register |
| Known card | one short beep |
| Unknown/new card or saved mapping | two short beeps |
| WiFi joins | LED on, re-announce session |
| No WiFi | a tap still resolves from NVS and shows on the LCD; it is not queued |

## Card details (name + roll)

The reader takes details from the card itself when they are written on it.
Two layouts are supported (ASCII text, a `ROLL|NAME` run somewhere in the
data):

1. **MIFARE Classic** - sector 1, blocks 4-6, key A default
   `FF FF FF FF FF FF` (fallbacks: sector 0 blocks 1-2, and the common keys).
   Write e.g. `BL.SC.U4CSE24043|Roshna George`.
2. **NTAG / Ultralight** - pages 4-15, raw text or an NDEF text record
   containing `ROLL|NAME`.

If the card has no record (UID-only cards are common), register it once:

1. Tap the card (the last UID is kept by the node).
2. Join the ESP32's open **`atlas`** WiFi from a phone/PC.
3. Open **http://192.168.4.1/** and save the roll + name for that UID.
4. Tap the same card again - it now marks attendance with those details.

The binding is stored in **NVS**, so it still works after a reboot. Unknown
cards are never lost: they are recorded as `RFID-<UID>` / `Card <UID>` with a
double beep, and can be named later.

Some tags (including UID-only tokens) do not answer the ISO14443A **SELECT**
step. The reader then uses the anticoll UID and skips card-resident data; bind
that UID once via the registration page - after that, the LCD shows the
student's **name (line 1)** and **roll number (line 2)** for 6 s on every tap,
and the register shows **Name | Roll no | Present**.

Attendance rows are non-expiring (only **CLEAR ATTENDANCE** resets them). The
server auto-enrolls the name/roll into the roster on the first tap and the
register/CSV show them.

The server endpoint is `POST /api/sessions/<id>/rfid` with:

```json
{"uid":"A1B2C3D4","studentId":"BL.SC.U4CSE24043","studentName":"Roshna George","at":1760000000000}
```
