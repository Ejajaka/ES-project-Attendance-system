# attendance-node — ESP32-DEVKITV1 wiring

KiCad 10 schematic for a DOIT ESP32 DEVKIT V1 (30-pin) that drives an I2C 1602
LCD, an RFID-RC522 reader, a microSD adapter, two push buttons and two buzzers.

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
| SPI SCK | IO18 | 22 | J2 pin 2, J3 pin 5 | Shared clock for RC522 and microSD |
| SPI MOSI | IO23 | 16 | J2 pin 3, J3 pin 4 | Shared data out |
| SPI MISO | IO19 | 21 | J2 pin 4, J3 pin 3 | Shared data in |
| RC522 CS | IO5 | 23 | J2 pin 1 | Chip select for the reader |
| RC522 RST | IO17 | 24 | J2 pin 7 | Hard reset for the reader |
| RC522 IRQ | — | — | J2 pin 5 | Open. The firmware polls the reader |
| microSD CS | IO4 | 26 | J3 pin 6 | Chip select for the card |
| Button 1 | IO32 | 6 | SW1 pin 2 | SW1 pin 1 to GND. Internal pull-up |
| Button 2 | IO33 | 7 | SW2 pin 2 | SW2 pin 1 to GND. Internal pull-up |
| Active buzzer | IO26 | 9 | R4, then Q1 base | Q1 collector to BZ1 pin 2. BZ1 pin 1 to +5V |
| Passive buzzer | IO27 | 10 | R5, then Q2 base | Q2 collector to BZ2 pin 2 and D3 anode. D3 cathode to +5V |
| 5V input | VIN | 15 | J4 pin 1 | J4 pin 2 to GND |
| 3V3 rail | 3V3 | 30 | J2 pin 8 | Feeds the RC522 only |
| Ground | GND | 14, 29 | J1.1, J2.6, J3.1, J4.2, Q1.3, Q2.3, SW1.1, SW2.1 | Common ground |

Module headers:

| Ref | Module | Pins |
|---|---|---|
| J1 | LCD1602 with PCF8574 backpack | 1 GND, 2 VCC 5V, 3 SDA, 4 SCL |
| J2 | RFID-RC522 | 1 SDA/NSS, 2 SCK, 3 MOSI, 4 MISO, 5 IRQ, 6 GND, 7 RST, 8 VCC 3V3 |
| J3 | microSD SPI adapter (HW-125) | 1 GND, 2 VCC 5V, 3 MISO, 4 MOSI, 5 SCK, 6 CS |
| J4 | 5V DC input | 1 +5V, 2 GND |

## Description

The ESP32 DevKit V1 is the only controller on the sheet. J4 supplies 5V to the
VIN pin. The 5V rail also feeds both buzzers, the LCD backlight and the microSD
adapter. The DevKit regulator supplies the 3V3 rail, which feeds the RC522 only.
Both ground pins of the DevKit connect to the common ground net.

The LCD1602 module uses the I2C bus on GPIO21 (SDA) and GPIO22 (SCL). These two
pins match the firmware defaults in `esp32-transmitter/src/lcd.c`. The backpack
answers at address 0x27 or 0x3F, so the firmware probes both addresses.

The RC522 reader and the microSD adapter share one SPI bus. GPIO18 is the clock,
GPIO23 carries MOSI and GPIO19 carries MISO. Each device has its own chip
select. GPIO5 selects the RC522 and GPIO4 selects the microSD adapter. GPIO17
resets the RC522. The IRQ pin of the RC522 stays open because the firmware polls
the reader.

The two modules need different supply voltages. The RC522 receives 3.3V because
the MFRC522 tolerates no more than 3.6V. The microSD adapter receives 5V because
its board carries a 3.3V regulator and a level shifter.

Two tactile buttons connect to GPIO32 and GPIO33. Each button pulls its pin to
ground. The internal pull-up holds the pin high. The firmware debounces both
buttons in software, so the sheet has no debounce capacitors.

Each buzzer has its own NPN low-side switch. GPIO26 drives the active buzzer
through R4 and Q1. The active buzzer has a built-in oscillator, so a DC level
makes the sound. GPIO27 drives the passive buzzer through R5 and Q2. The passive
buzzer needs a square wave, so the firmware uses LEDC PWM. D3 clamps the coil of
the passive buzzer.

GPIO25 stays free because the firmware uses it for the ultrasonic transmitter
and the WiFi status LED. Do not use GPIO34, GPIO35, GPIO36 and GPIO39 as
outputs. These pins accept input only. GPIO0, GPIO2, GPIO5, GPIO12 and GPIO15
set the boot mode, so the sheet leaves them unconnected except GPIO5.

## Sources

| Part | Source |
|---|---|
| ESP32-DEVKITV1 header order | https://github.com/shridattdudhat/ESP32-DEVKITV1 |
| ESP32 datasheet | https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf |
| I2C 1602 LCD backpack | https://www.handsontec.com/dataspecs/module/I2C_1602_LCD.pdf |
| MFRC522 datasheet | https://www.nxp.com/docs/en/data-sheet/MFRC522.pdf |
| microSD SPI adapter | https://components101.com/modules/micro-sd-card-module-pinout-features-datasheet-alternatives |
| Active buzzer module | https://circuit.rocks/products/buzzer-module |
| Passive buzzer module | https://arduinomodules.info/ky-006-passive-buzzer-module/ |
