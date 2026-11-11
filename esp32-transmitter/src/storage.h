#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/**
 * microSD attendance mirror + offline upload queue.
 *
 * Files (FAT32 card):
 *   /sdcard/attendance.csv   append-only local mirror of every card tap
 *   /sdcard/rfid.csv         card UID -> roll,name mapping (editable on a PC)
 *   /sdcard/pending/         JSON taps not yet accepted by the server
 *
 * The SPI bus must be initialised before storage_init().
 */

/** HTTP POST callback: return the status code (2xx means "stored"). */
typedef int (*storage_post_fn)(const char *json);

bool storage_init(void);
bool storage_ok(void);

/**
 * Look up a card UID in rfid.csv. Returns false when the UID is not mapped
 * (the caller then uses a generated roll/name).
 */
bool storage_lookup_uid(const char *uid, char *roll, size_t roll_sz,
                        char *name, size_t name_sz);

/**
 * Bind a UID to a roll/name. Writes /sdcard/rfid.csv when the card is mounted
 * and always mirrors the binding into NVS, so registration still works on a
 * board without a microSD card.
 */
bool storage_add_mapping(const char *uid, const char *roll, const char *name);

/** Append one tap to attendance.csv (best-effort local mirror). */
void storage_log_scan(int64_t at_ms, const char *uid, const char *roll,
                      const char *name);

/** Queue a JSON body for later upload. False when the SD is unavailable. */
bool storage_enqueue(const char *json);

/** Upload every queued body; returns how many the server accepted. */
int storage_sync_pending(storage_post_fn post);

/** Delete every queued body (local mirror is kept). */
int storage_clear_pending(void);

int storage_pending_count(void);
