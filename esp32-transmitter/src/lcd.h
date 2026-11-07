#pragma once

#include <stdbool.h>

/**
 * Minimal HD44780 16x2 driver over a PCF8574 I2C backpack.
 * Defaults: SDA = GPIO21, SCL = GPIO22, address 0x27 or 0x3F.
 */

/** Initialise the I2C bus + LCD. Returns false if no backpack answers. */
bool lcd_init(void);

/** Print text at row 0 or 1 (max 16 chars); pads the rest with spaces. */
void lcd_print(int row, const char *text);

/** Re-init the LCD if any I2C write failed since the last call. */
void lcd_tick_recover(void);
