# attendance-node - ESP32-DEVKITV1 wiring

KiCad 10 schematic for a DOIT ESP32 DEVKIT V1 (30-pin) that drives an I2C 1602
LCD, an RFID-RC522 reader, a WiFi status LED and two buzzers (active + passive /
ultrasonic). The current firmware does not use a microSD card or push buttons;
the older schematic symbols for those parts are not populated. The buzzers are
wired directly to GPIO26/27 in the current build; the KiCad sheet still shows
the old transistor driver pads (Q1/Q2/R4/R5/D3), which are unpopulated.

Open `attendance-node.kicad_pro` in KiCad to edit the sheet. The plots
`attendance-node.pdf`, `attendance-node.svg` and `attendance-node.png` show the
current state.

## Connections

Pin numbers refer to the U1 symbol. They follow the 30-pin header order of the
board. Pins 1 to 15 run down the left side from EN to VIN. Pins 16 to 30 run
down the right side from IO23 to 3V3.

| Signal | ESP32 GPIO | U1 pin | Connects to | Notes |
|---|---|---|---|---|
| I2C SDA | IO21 | 20 | J1 pin 3 | LCD data. Matches the firmware default in `lcd.c` |
| I2C SCL | IO22 | 17 | J1 pin 4 | LCD clock. Backpack address 0x27 or 0x3F |
| SPI SCK | IO18 | 22 | J2 pin 2 | RC522 clock |
| SPI MOSI | IO23 | 16 | J2 pin 3 | RC522 data out |
| SPI MISO | IO19 | 21 | J2 pin 4 | RC522 data in |
| RC522 CS | IO5 | 23 | J2 pin 1 | Chip select for the reader |
| RC522 RST | IO17 | 24 | J2 pin 7 | Hard reset for the reader |
| RC522 IRQ | - | - | J2 pin 5 | Open. The firmware polls the reader |
| WiFi LED | IO25 | 11 | D1 anode (through R1) | 220-330 ohm; cathode to GND |
| Active buzzer | IO26 | 9 | BZ1 pin 1 | BZ1 pin 2 to GND. Direct drive, no transistor |
| Passive buzzer | IO27 | 10 | BZ2 pin 1 | BZ2 pin 2 to GND. Direct drive, no transistor |
| 5V input | VIN | 15 | J4 pin 1 | J4 pin 2 to GND |
| 3V3 rail | 3V3 | 30 | J2 pin 8 | Feeds the RC522 only |
| Ground | GND | 14, 29 | J1.1, J2.6, J4.2, BZ1.2, BZ2.2 | Common ground |

Module headers:

| Ref | Module | Pins |
|---|---|---|
| J1 | LCD1602 with PCF8574 backpack | 1 GND, 2 VCC 5V, 3 SDA, 4 SCL |
| J2 | RFID-RC522 | 1 SDA/NSS, 2 SCK, 3 MOSI, 4 MISO, 5 IRQ, 6 GND, 7 RST, 8 VCC 3V3 |
| J4 | 5V DC input | 1 +5V, 2 GND |

## Description

The ESP32 DevKit V1 is the only controller on the sheet. J4 supplies 5V to the
VIN pin. The 5V rail feeds the LCD backlight; the buzzers are driven directly
from the 3.3V GPIO pins. The DevKit regulator supplies the 3V3 rail, which feeds
the RC522 only. Both ground pins of the DevKit connect to the common ground net.

The LCD1602 module uses the I2C bus on GPIO21 (SDA) and GPIO22 (SCL). These two
pins match the firmware defaults in `esp32-transmitter/src/lcd.c`. The backpack
answers at address 0x27 or 0x3F, so the firmware probes both addresses.

The RC522 reader uses SPI: GPIO18 is the clock, GPIO23 carries MOSI and GPIO19
carries MISO. GPIO5 selects the RC522 and GPIO17 resets it. The IRQ pin stays
open because the firmware polls the reader.

The RC522 receives 3.3V because the MFRC522 tolerates no more than 3.6V.

Each buzzer is wired directly to its GPIO; there is no transistor. GPIO26
drives the active buzzer: BZ1 pin 1 to GPIO26, pin 2 to GND. The active buzzer
has a built-in oscillator, so a DC level makes the sound. GPIO27 drives the
passive buzzer: BZ2 pin 1 to GPIO27, pin 2 to GND. The passive buzzer needs a
square wave, so the firmware uses LEDC PWM at 20/19.6 kHz. A piezo element does
not need a flyback diode; a magnetic buzzer would.

GPIO25 drives the green WiFi status LED through R1. Do not use GPIO34, GPIO35,
GPIO36 and GPIO39 as outputs. These pins accept input only. GPIO0, GPIO2,
GPIO5, GPIO12 and GPIO15 set the boot mode, so the sheet leaves them
unconnected except GPIO5.

## Sources

| Part | Source |
|---|---|
| ESP32-DEVKITV1 header order | https://github.com/shridattdudhat/ESP32-DEVKITV1 |
| ESP32 datasheet | https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf |
| I2C 1602 LCD backpack | https://www.handsontec.com/dataspecs/module/I2C_1602_LCD.pdf |
| MFRC522 datasheet | https://www.nxp.com/docs/en/data-sheet/MFRC522.pdf |
| Active buzzer module | https://circuit.rocks/products/buzzer-module |
| Passive buzzer module | https://arduinomodules.info/ky-006-passive-buzzer-module/ |
