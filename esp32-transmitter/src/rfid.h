#pragma once

#include <stdbool.h>
#include <stdint.h>

/**
 * Minimal MFRC522 (13.56 MHz) SPI reader.
 *
 * Shares SPI2 with the microSD card; the bus itself must be initialised
 * before rfid_init() is called. Only 4-byte UID cards (MIFARE Classic etc.)
 * are supported, which covers the cards used for this project.
 */

/** Attach the reader to the already-initialised SPI2 bus. */
bool rfid_init(void);

/** True once the reader answered with a plausible version register. */
bool rfid_ready(void);

/**
 * Poll for a card. On success fills `uid` (up to 4 bytes) and `uid_len`.
 * Returns false when no card is present (the normal case).
 */
bool rfid_read_uid(uint8_t uid[10], uint8_t *uid_len);

/** Power-cycle the antenna field so a card left on the reader re-answers. */
void rfid_cycle_field(void);
