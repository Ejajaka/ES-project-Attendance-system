#include "storage.h"

#include <ctype.h>
#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "driver/sdspi_host.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "nvs.h"
#include "sdmmc_cmd.h"

#define NVS_RFID_NS "rfid"

static const char *TAG = "sd";

#define SD_CS_GPIO 4
#define SD_MOUNT "/sdcard"
#define SD_PENDING SD_MOUNT "/pending"
#define SD_MAP SD_MOUNT "/rfid.csv"
#define SD_LOG SD_MOUNT "/attendance.csv"

static bool s_ok = false;
static sdmmc_card_t *s_card = NULL;
static uint32_t s_seq = 0;

bool storage_ok(void)
{
    return s_ok;
}

bool storage_init(void)
{
    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = SPI2_HOST;
    /* Long breadboard wires + a shared bus: 10 MHz is much more forgiving
       than the 20 MHz default while remaining plenty for an attendance log. */
    host.max_freq_khz = 10000;

    sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot.host_id = SPI2_HOST;
    slot.gpio_cs = SD_CS_GPIO;

    esp_vfs_fat_mount_config_t mcfg = {
        .format_if_mount_failed = false,
        .max_files = 6,
        .allocation_unit_size = 16 * 1024,
    };

    esp_err_t err = esp_vfs_fat_sdspi_mount(SD_MOUNT, &host, &slot, &mcfg, &s_card);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "no microSD card (CS=%d): %s — offline log disabled",
                 SD_CS_GPIO, esp_err_to_name(err));
        s_ok = false;
        return false;
    }

    mkdir(SD_PENDING, 0777);

    /* Create the editable UID mapping with a header on a fresh card. */
    FILE *map = fopen(SD_MAP, "r");
    if (!map) {
        map = fopen(SD_MAP, "w");
        if (map) {
            fputs("uid,roll,name\n", map);
            fflush(map);
            ESP_LOGI(TAG, "created %s (edit uid,roll,name on a PC)", SD_MAP);
        }
    }
    if (map) fclose(map);

    s_ok = true;
    ESP_LOGI(TAG, "microSD ready (CS=%d, %llu MB)", SD_CS_GPIO,
             (unsigned long long)(s_card ? ((uint64_t)s_card->csd.capacity *
                                            s_card->csd.sector_size) >> 20
                                         : 0));
    return true;
}

static char *trim(char *s)
{
    while (*s && isspace((unsigned char)*s)) s++;
    char *end = s + strlen(s);
    while (end > s && isspace((unsigned char)end[-1])) *--end = '\0';
    return s;
}

bool storage_lookup_uid(const char *uid, char *roll, size_t roll_sz,
                        char *name, size_t name_sz)
{
    if (!uid || !*uid) return false;

    bool found = false;
    FILE *f = s_ok ? fopen(SD_MAP, "r") : NULL;
    if (f) {
        char line[192];
        while (fgets(line, sizeof(line), f)) {
            char *l = trim(line);
            if (!*l || l[0] == '#') continue;
            char *c1 = strchr(l, ',');
            if (!c1) continue;
            *c1 = '\0';
            char *c2 = strchr(c1 + 1, ',');
            if (!c2) continue;
            *c2 = '\0';
            const char *map_uid = trim(l);
            const char *map_roll = trim(c1 + 1);
            const char *map_name = trim(c2 + 1);
            if (strcasecmp(map_uid, "uid") == 0) continue; /* header */
            if (strcasecmp(map_uid, uid) != 0) continue;
            /* Keep scanning: a later line is a re-registration and wins. */
            if (roll_sz) snprintf(roll, roll_sz, "%.*s", (int)(roll_sz - 1), map_roll);
            if (name_sz) snprintf(name, name_sz, "%.*s", (int)(name_sz - 1), map_name);
            found = true;
        }
        fclose(f);
    }
    if (found) return true;

    /* NVS mirror: registration survives a missing microSD card. */
    nvs_handle_t h;
    if (nvs_open(NVS_RFID_NS, NVS_READONLY, &h) == ESP_OK) {
        char key[16];
        snprintf(key, sizeof(key), "u%s", uid);
        char val[160];
        size_t len = sizeof(val);
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
    }
    return found;
}

bool storage_add_mapping(const char *uid, const char *roll, const char *name)
{
    if (!uid || !*uid || !roll || !*roll || !name || !*name) return false;
    bool saved = false;

    if (s_ok) {
        FILE *f = fopen(SD_MAP, "a");
        if (f) {
            fseek(f, 0, SEEK_END);
            if (ftell(f) == 0) fputs("uid,roll,name\n", f);
            fprintf(f, "%s,%s,%s\n", uid, roll, name);
            fclose(f);
            saved = true;
            ESP_LOGI(TAG, "mapping %s -> %s,%s written to SD", uid, roll, name);
        }
    }

    /* Always keep an NVS copy: a missing card must not lose the binding. */
    nvs_handle_t h;
    if (nvs_open(NVS_RFID_NS, NVS_READWRITE, &h) == ESP_OK) {
        char key[16];
        snprintf(key, sizeof(key), "u%s", uid);
        char val[160];
        snprintf(val, sizeof(val), "%s|%s", roll, name);
        if (nvs_set_str(h, key, val) == ESP_OK && nvs_commit(h) == ESP_OK) {
            saved = true;
            ESP_LOGI(TAG, "mapping %s -> %s,%s saved to NVS", uid, roll, name);
        }
        nvs_close(h);
    }
    return saved;
}

static void csv_escape(const char *in, char *out, size_t out_sz)
{
    size_t o = 0;
    if (out_sz < 3) {
        if (out_sz) out[0] = '\0';
        return;
    }
    out[o++] = '"';
    for (const char *p = in; *p && o + 2 < out_sz; p++) {
        char c = *p;
        if (c == '"' || c == '\n' || c == '\r') {
            out[o++] = '"'; /* CSV doubles the quote */
        }
        out[o++] = (c == '\n' || c == '\r') ? ' ' : c;
    }
    out[o++] = '"';
    out[o] = '\0';
}

void storage_log_scan(int64_t at_ms, const char *uid, const char *roll,
                      const char *name)
{
    if (!s_ok) return;
    FILE *f = fopen(SD_LOG, "a");
    if (!f) {
        ESP_LOGW(TAG, "open %s failed", SD_LOG);
        return;
    }
    fseek(f, 0, SEEK_END);
    if (ftell(f) == 0) {
        fputs("at_ms,uid,roll,name\n", f);
    }
    char r[96], n[96];
    csv_escape(roll, r, sizeof(r));
    csv_escape(name, n, sizeof(n));
    fprintf(f, "%lld,%s,%s,%s\n", (long long)at_ms, uid, r, n);
    fclose(f);
}

bool storage_enqueue(const char *json)
{
    if (!s_ok || !json) return false;
    char path[128];
    snprintf(path, sizeof(path), SD_PENDING "/%lld-%lu.json",
             (long long)time(NULL), (unsigned long)s_seq++);
    FILE *f = fopen(path, "w");
    if (!f) {
        ESP_LOGW(TAG, "queue write failed: %s", path);
        return false;
    }
    fputs(json, f);
    fclose(f);
    ESP_LOGI(TAG, "queued %s", path);
    return true;
}

static bool is_json_entry(const char *name)
{
    size_t n = strlen(name);
    return n > 5 && strcmp(name + n - 5, ".json") == 0;
}

int storage_sync_pending(storage_post_fn post)
{
    if (!s_ok || !post) return 0;
    DIR *d = opendir(SD_PENDING);
    if (!d) return 0;

    struct dirent *e;
    int uploaded = 0;
    char path[320];
    char body[640];
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.' || !is_json_entry(e->d_name)) continue;
        snprintf(path, sizeof(path), SD_PENDING "/%s", e->d_name);
        FILE *f = fopen(path, "r");
        if (!f) continue;
        size_t n = fread(body, 1, sizeof(body) - 1, f);
        fclose(f);
        body[n] = '\0';
        if (n == 0) {
            unlink(path);
            continue;
        }
        int status = post(body);
        if (status >= 200 && status < 300) {
            if (unlink(path) == 0) uploaded++;
        } else if (status < 0 || status == 0) {
            /* Server unreachable / not configured: keep the queue and stop
               early instead of hammering every file. */
            break;
        } else {
            ESP_LOGW(TAG, "server rejected queued tap (%d): %s", status, body);
        }
    }
    closedir(d);
    return uploaded;
}

int storage_clear_pending(void)
{
    if (!s_ok) return 0;
    DIR *d = opendir(SD_PENDING);
    if (!d) return 0;
    struct dirent *e;
    int removed = 0;
    char path[320];
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.' || !is_json_entry(e->d_name)) continue;
        snprintf(path, sizeof(path), SD_PENDING "/%s", e->d_name);
        if (unlink(path) == 0) removed++;
    }
    closedir(d);
    return removed;
}

int storage_pending_count(void)
{
    if (!s_ok) return 0;
    DIR *d = opendir(SD_PENDING);
    if (!d) return 0;
    struct dirent *e;
    int count = 0;
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] != '.' && is_json_entry(e->d_name)) count++;
    }
    closedir(d);
    return count;
}
