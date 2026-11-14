#pragma once

#include <stdbool.h>
#include <stddef.h>

/**
 * Offline RFID UID -> roll/name mapping stored in NVS.
 *
 * The room node has no microSD slot: bindings entered on the phone or the
 * SoftAP page are kept in NVS so a card still resolves without the server.
 */

bool mapping_lookup_uid(const char *uid, char *roll, size_t roll_sz,
                        char *name, size_t name_sz);

bool mapping_add(const char *uid, const char *roll, const char *name);
