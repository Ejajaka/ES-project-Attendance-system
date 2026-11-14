#include "mapping.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"

#define NVS_RFID_NS "rfid"
static const char *TAG = "mapping";

bool mapping_lookup_uid(const char *uid, char *roll, size_t roll_sz,
                        char *name, size_t name_sz)
{
    if (!uid || !*uid) return false;

    nvs_handle_t h;
    if (nvs_open(NVS_RFID_NS, NVS_READONLY, &h) != ESP_OK) return false;

    char key[16];
    snprintf(key, sizeof(key), "u%s", uid);
    char val[160];
    size_t len = sizeof(val);
    bool found = false;
    if (nvs_get_str(h, key, val, &len) == ESP_OK) {
        char *bar = strchr(val, '|');
        if (bar) {
            *bar = '\0';
            if (roll_sz) snprintf(roll, roll_sz, "%.*s", (int)(roll_sz - 1), val);
            if (name_sz) snprintf(name, name_sz, "%.*s", (int)(name_sz - 1), bar + 1);
            found = true;
        }
    }
    nvs_close(h);
    return found;
}

bool mapping_add(const char *uid, const char *roll, const char *name)
{
    if (!uid || !*uid || !roll || !*roll || !name || !*name) return false;

    nvs_handle_t h;
    if (nvs_open(NVS_RFID_NS, NVS_READWRITE, &h) != ESP_OK) return false;

    char key[16];
    snprintf(key, sizeof(key), "u%s", uid);
    char val[160];
    snprintf(val, sizeof(val), "%s|%s", roll, name);
    bool saved = nvs_set_str(h, key, val) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    if (saved) {
        ESP_LOGI(TAG, "mapping %s -> %s,%s saved", uid, roll, name);
    }
    return saved;
}
