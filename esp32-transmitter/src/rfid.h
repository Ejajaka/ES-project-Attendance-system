#pragma once

#include <stdbool.h>
#include <stddef.h>
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
 * Poll for a card. On success fills `uid` (up to 4 bytes), `uid_len` and the
 * SAK (card type). Returns false when no card is present (the normal case).
 */
bool rfid_read_uid(uint8_t uid[10], uint8_t *uid_len, uint8_t *sak);

/**
 * Read the student record written on the card, if any.
 *
 * Supported layouts (ASCII text, `ROLL|NAME`, padded):
 *   - MIFARE Classic: sector 1 blocks 4-6 (default key A FF FF FF FF FF FF),
 *     falling back to sector 0 blocks 1-2.
 *   - NTAG/Ultralight: pages 4..15 (raw text or the text payload of an NDEF
 *     record).
 *
 * Returns true and copies the first printable `ROLL|NAME` run to `out`.
 */
bool rfid_read_record(const uint8_t uid[4], uint8_t sak, char *out,
                      size_t out_sz);

/** Power-cycle the antenna field so a card left on the reader re-answers. */
void rfid_cycle_field(void);
