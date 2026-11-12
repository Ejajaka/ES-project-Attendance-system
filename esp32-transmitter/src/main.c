/*
 * Shusseki ESP32 room TRANSMITTER (Soshin role).
 *
 * Replicates the phone app's transmitter behaviour so a phone receiver finds the
 * room without any room-side phone being present:
 *
 *   1. Rolls an RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step) from the preset
 *      room secret — the same algorithm as shared/src/rollingCode.ts.
 *   2. Advertises it over BLE as manufacturer data `<nodeId>|<code>` under
 *      company id 0xABCD — the exact payload ShussekiBleModule.kt parses.
 *   3. Raises the fixed open `atlas` SoftAP (no password) for the receiver to
 *      join, and announces its SSID to the fusion server.
 *   4. Emits the alternating 1.8/2.6 kHz burst presence stamp on LEDC pin
 *      ULTRASONIC_GPIO.
 *   5. Serves a clock + config endpoint on the SoftAP (port 80): a phone joined
 *      to `atlas` can POST /api/node/time to fix the node's clock (the only
 *      reliable path in the STA-less atlas topology) and POST /api/node/config
 *      to point the node at a new fusion server.
 *
 * Tune the CONFIG block below per room. The server must be reachable from the
 * ESP32's network (the fusion server binds 0.0.0.0 on the dev PC).
 */

#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "sdkconfig.h"
#include "esp_system.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_http_client.h"
#include "esp_http_server.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_timer.h"
#if CONFIG_ESP_WIFI_ENTERPRISE_SUPPORT
#include "esp_eap_client.h"
#endif

#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_gap_ble_api.h"

#include "lcd.h"
#include "rfid.h"
#include "storage.h"

static const char *TAG = "shusseki-tx";

/** SoftAP netif, kept so we can enable NAT (AP clients -> server) on STA-up. */
static esp_netif_t *s_ap_netif = NULL;

/* ------------------------------------------------------------------ CONFIG */

/** Stable node id advertised in the BLE beacon (shown in the receiver's link view). */
#define NODE_ID "esp32-tx1"

/** Fusion server base URL (default; can be overridden at runtime via NVS). */
#define SERVER_URL "http://192.168.137.1:8787"

/** NVS namespace + key holding a runtime-configured server URL. */
#define NVS_NS "shusseki"
#define NVS_KEY_SERVER_URL "server_url"

/* Preset ROOM 01 — must match app/src/lib/presets.ts (room/session/secret). */
#define PRESET_ROOM_ID "room-1"
#define PRESET_SESSION_ID "sess-1"
#define PRESET_SECRET "shusseki-preset-1-secret"

/* SoftAP: fixed open `atlas` network (no password) that phones join directly. */
#define AP_SSID "atlas"
#define AP_PASS ""

/**
 * Join an existing WiFi so the clock can NTP-sync and the ESP32 can reach the
 * fusion server on the same LAN. Leave STA_SSID empty to fall back to the
 * build-time clock seed (DEV_SEED_EPOCH) until a phone syncs /api/node/time.
 *
 * WPA2-Personal hotspot: set SSID + password.
 * WPA2-Enterprise (802.1X): set STA_ENTERPRISE 1 + STA_USERNAME.
 */
#define STA_SSID "Shusseki-Room"
#define STA_PASSWORD "shusseki123"
#define STA_USERNAME ""
#define STA_ENTERPRISE 0

#define TOTP_STEP_S 30

/*
 * This UID-only token does not answer SELECT, so its written NDEF text cannot
 * be read by the RC522. Bind it here (NVS) until a readable NTAG is used; the
 * SoftAP card page can override this mapping at runtime.
 */
#define DEFAULT_BIND_UID "16FA551F"
#define DEFAULT_BIND_ROLL "BL.SC.U4CSE24043"
#define DEFAULT_BIND_NAME "Roshna George"

/** Green LED: on when the STA is connected to the classroom Wi-Fi. */
#define LED_GPIO 25
/** How often the LCD refreshes the live attendance count from the server. */
#define ATTENDANCE_PERIOD_MS 2000

/*
 * Extra hardware (see docs/hardware-wiring.md):
 *   RFID MFRC522  : SPI2, CS=5, RST=16 (SCK=18 MISO=19 MOSI=23)
 *   microSD       : SPI2, CS=4
 *   2 buttons     : 32 = sync now (short press), 33 = clear queue (hold 2 s)
 *   buzzer        : 26 (active-high)
 *   ultrasonic TX : 27 (LEDC, 1.8/2.6 kHz alternating bursts)
 */
#define RFID_CS_GPIO 5
#define RFID_RST_GPIO 17
#define SD_CS_GPIO 4
#define SPI_SCK_GPIO 18
#define SPI_MISO_GPIO 19
#define SPI_MOSI_GPIO 23
#define BTN_SYNC_GPIO 32
#define BTN_CLEAR_GPIO 33
#define BUZZER_GPIO 26
#define ULTRASONIC_GPIO 27
/** How often queued RFID taps are retried while the STA is up. */
#define SYNC_PERIOD_MS 15000
/**
 * microSD is optional. While the SD adapter is not physically mounted, leave
 * this at 0: a failed FAT mount on the shared SPI bus can disturb the RFID
 * reader. Set to 1 once the card adapter is wired.
 */
#ifndef SD_ENABLED
#define SD_ENABLED 0
#endif
/** Minimal hardware smoke test: LCD + RC522 only (no WiFi/BLE/server/SD). */
#ifndef RFID_TEST_MODE
#define RFID_TEST_MODE 0
#endif

/** Set when the STA gets an IP so the LCD refreshes immediately. */
static volatile bool s_attendance_now = false;
/** STA link state, shown on LCD line 2. */
static volatile bool s_wifi_up = false;
/** Set by the buttons / a card tap to run an SD queue sync now. */
static volatile bool s_sync_now = false;
/** Set when the STA gets an IP so the session is announced immediately. */
static volatile bool s_announce_now = false;
/** Last card UID, shown on the SoftAP registration page. */
static char s_last_uid[16] = "";
/** Set by the clear button (hold 2 s). */
static volatile bool s_clear_now = false;
/** microSD mounted successfully. */
static bool s_sd_ok = false;
/** Temporary LCD text requested by another task (printed by the sync task). */
static char s_msg0[17];
static char s_msg1[17];
static volatile bool s_msg_pending = false;
static uint32_t s_lcd_temp_until_ms = 0;

#ifndef DEV_SEED_EPOCH
#define DEV_SEED_EPOCH 0
#endif

/* Sync-task cadence: announce ~every 50 s, poll presence ~every 25 s. */
#define ANNOUNCE_PERIOD_MS 50000
#define POLL_PERIOD_MS 25000
/** Backoff multiplier applied to ANNOUNCE_PERIOD_MS after a failed announce. */
#define ANNOUNCE_BACKOFF_FACTOR 4

/*
 * A phone's clock is the source of truth here: accept an offer within
 * ±CLOCK_SYNC_TOL_S of the node's own time, OR any monotonically newer value.
 * Only a stale (older-than-tolerance) value is rejected so garbage can never
 * rewind the clock.
 */
#define CLOCK_SYNC_TOL_S 90

static int http_post_json(const char *path, const char *body);
static int http_post_json_resp(const char *path, const char *body, char *out,
                               size_t outsz);

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

/** Ask for a temporary LCD message; the sync task does the actual I2C write. */
static void lcd_show_temp(const char *line0, const char *line1, uint32_t ms)
{
    snprintf(s_msg0, sizeof(s_msg0), "%s", line0 ? line0 : "");
    snprintf(s_msg1, sizeof(s_msg1), "%s", line1 ? line1 : "");
    s_lcd_temp_until_ms = now_ms() + ms;
    s_msg_pending = true;
}

/* --------------------------------------------------------------------- LED */

static bool s_led_on = false;

static void led_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << LED_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io);
    gpio_set_level(LED_GPIO, 0);
    s_led_on = false;

    /* Visible self-test: three quick blinks at boot. */
    for (int i = 0; i < 3; i++) {
        gpio_set_level(LED_GPIO, 1);
        vTaskDelay(pdMS_TO_TICKS(200));
        gpio_set_level(LED_GPIO, 0);
        vTaskDelay(pdMS_TO_TICKS(200));
    }
    ESP_LOGI(TAG, "LED boot test: 3 blinks on GPIO%d (active-high)", LED_GPIO);
}

/** Green LED = Wi-Fi link state (ON only once the STA has an IP). */
static void led_set(bool on)
{
    if (on == s_led_on) {
        return;
    }
    s_led_on = on;
    gpio_set_level(LED_GPIO, on ? 1 : 0);
    ESP_LOGI(TAG, "LED %s (wifi %s)", on ? "ON" : "OFF",
             on ? "connected" : "down");
}

/* --------------------------------------------------------- buzzer + buttons */

static void buzzer_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << BUZZER_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io);
    gpio_set_level(BUZZER_GPIO, 0);
}

/** Active-high buzzer. Short = card accepted, double = unknown card. */
static void buzzer_beep(int ms)
{
    if (ms <= 0) return;
    gpio_set_level(BUZZER_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(ms));
    gpio_set_level(BUZZER_GPIO, 0);
}

static void buttons_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << BTN_SYNC_GPIO) | (1ULL << BTN_CLEAR_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io);
}

/**
 * BTN1 (GPIO32): short press → upload the SD queue now.
 * BTN2 (GPIO33): hold 2 s → clear the SD queue (server rows are untouched).
 * The actual SD/HTTP work happens in sync_task so the two never race.
 */
static void button_task(void *arg)
{
    (void)arg;
    int sync_held = 0;
    int clear_held = 0;
    /* Arm only after seeing the pin high: a miswired/stuck-low button must not
       fire a clear at boot. The raw levels are logged in the [hw] summary. */
    bool sync_armed = false;
    bool clear_armed = false;
    for (;;) {
        bool sync_low = gpio_get_level(BTN_SYNC_GPIO) == 0;
        bool clear_low = gpio_get_level(BTN_CLEAR_GPIO) == 0;

        if (!sync_low) sync_armed = true;
        if (!clear_low) clear_armed = true;

        if (sync_armed && sync_low) {
            sync_held++;
        } else {
            if (sync_armed && sync_held >= 2) {
                ESP_LOGI(TAG, "[btn] sync requested");
                s_sync_now = true;
            }
            sync_held = 0;
        }
        if (clear_armed && clear_low) {
            clear_held++;
            if (clear_held == 200) { /* 200 × 10 ms = 2 s */
                ESP_LOGI(TAG, "[btn] clear-local requested (hold)");
                s_clear_now = true;
            }
        } else {
            clear_held = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

/* --------------------------------------------------------------- ultrasonic */

/**
 * Restores the Soshin ultrasonic presence stamp: four alternating 1.8/2.6 kHz
 * bursts (120 ms on, 220 ms gap) then a pause, repeating. Drive a piezo or a
 * small amp+speaker from GPIO27.
 */
static void ultrasonic_init(void)
{
    ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 2600,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    if (ledc_timer_config(&timer) != ESP_OK) {
        ESP_LOGW(TAG, "ultrasonic LEDC timer init failed");
        return;
    }
    ledc_channel_config_t ch = {
        .gpio_num = ULTRASONIC_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
        .hpoint = 0,
    };
    if (ledc_channel_config(&ch) != ESP_OK) {
        ESP_LOGW(TAG, "ultrasonic LEDC channel init failed");
        return;
    }
    ESP_LOGI(TAG, "ultrasonic stamp on GPIO%d (1.8/2.6 kHz)", ULTRASONIC_GPIO);
}

static void ultrasonic_task(void *arg)
{
    (void)arg;
    static const uint32_t freqs[4] = {1800, 2600, 1800, 2600};
    for (;;) {
        for (int i = 0; i < 4; i++) {
            ledc_set_freq(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0, freqs[i]);
            ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 512); /* 50% */
            ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
            vTaskDelay(pdMS_TO_TICKS(120));
            ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
            ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
            vTaskDelay(pdMS_TO_TICKS(220));
        }
        vTaskDelay(pdMS_TO_TICKS(600));
    }
}

/* ----------------------------------------------------------------- SPI bus */

static void spi_init(void)
{
    spi_bus_config_t bus = {
        .mosi_io_num = SPI_MOSI_GPIO,
        .miso_io_num = SPI_MISO_GPIO,
        .sclk_io_num = SPI_SCK_GPIO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4096,
    };
    esp_err_t err = spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "SPI2 init failed: %s", esp_err_to_name(err));
    }
}

/* ---------------------------------------------------------------- RFID + SD */

static void json_escape(const char *in, char *out, size_t outsz)
{
    size_t o = 0;
    for (const char *p = in; p && *p && o + 2 < outsz; p++) {
        char c = *p;
        if (c == '"' || c == '\\') {
            out[o++] = '\\';
            out[o++] = c;
        } else if (c == '\n' || c == '\r') {
            out[o++] = ' ';
        } else {
            out[o++] = c;
        }
    }
    out[o] = '\0';
}

static int post_rfid(const char *json)
{
    return http_post_json("/api/sessions/" PRESET_SESSION_ID "/rfid", json);
}

/** Extract a string field from the small JSON responses we consume. */
static bool json_get(const char *json, const char *key, char *out, size_t outsz)
{
    if (!json || !key || !out || outsz == 0) return false;
    char needle[40];
    snprintf(needle, sizeof(needle), "\"%s\":\"", key);
    const char *p = strstr(json, needle);
    if (!p) return false;
    p += strlen(needle);
    size_t o = 0;
    while (*p && *p != '"' && o + 1 < outsz) {
        if (*p == '\\' && p[1]) p++;
        out[o++] = *p++;
    }
    out[o] = '\0';
    return o > 0;
}

/** One card tap: card record → SD mapping → UID, mirror + queue for server. */
static void handle_card(const char *uid_hex, const char *record)
{
    snprintf(s_last_uid, sizeof(s_last_uid), "%s", uid_hex);
    char roll[64];
    char name[64];
    bool have_details = false;

    /* 1. Details written on the card itself.
       `ROLL|NAME` (project format) or `NAME,ROLL` (the register's order). */
    if (record && strpbrk(record, "|,")) {
        char rec[96];
        snprintf(rec, sizeof(rec), "%s", record);
        char *bar = strpbrk(rec, "|,");
        if (bar) {
            bool pipe = *bar == '|';
            *bar = '\0';
            char *r = rec;
            char *n = bar + 1;
            while (*r == ' ') r++;
            while (*n == ' ') n++;
            char *e = r + strlen(r);
            while (e > r && e[-1] == ' ') *--e = '\0';
            char *ne = n + strlen(n);
            while (ne > n && ne[-1] == ' ') *--ne = '\0';
            if (*r && *n) {
                if (pipe) {
                    snprintf(roll, sizeof(roll), "%.63s", r);
                    snprintf(name, sizeof(name), "%.63s", n);
                } else {
                    /* "name,roll" per the requested register format. */
                    snprintf(name, sizeof(name), "%.63s", r);
                    snprintf(roll, sizeof(roll), "%.63s", n);
                }
                have_details = true;
            }
        }
    }

    /* 2. UID → roll/name mapping on the microSD card. */
    if (!have_details && s_sd_ok) {
        have_details = storage_lookup_uid(uid_hex, roll, sizeof(roll), name,
                                          sizeof(name));
    }

    /* 3. Unknown card: still record it (never lose a tap). */
    if (!have_details) {
        snprintf(roll, sizeof(roll), "RFID-%s", uid_hex);
        snprintf(name, sizeof(name), "Card %s", uid_hex);
    }

    int64_t at = (int64_t)time(NULL) * 1000;

    char er[96];
    char en[96];
    char json[384];
    json_escape(roll, er, sizeof(er));
    json_escape(name, en, sizeof(en));
    snprintf(json, sizeof(json),
             "{\"uid\":\"%s\",\"studentId\":\"%s\",\"studentName\":\"%s\","
             "\"at\":%lld}",
             uid_hex, er, en, (long long)at);

    /* Online: the server's phone-entered UID mapping is authoritative and its
       response carries the final name/roll for the LCD. Offline: queue on SD
       (or keep the local mapping) and retry later. */
    bool queued = false;
    bool server_matched = false;
    if (s_wifi_up) {
        char resp[512];
        int status = http_post_json_resp(
            "/api/sessions/" PRESET_SESSION_ID "/rfid", json, resp,
            sizeof(resp));
        ESP_LOGI(TAG, "[rfid] server -> %d", status);
        if (status >= 200 && status < 300) {
            char sname[64];
            char sroll[64];
            char ssource[16];
            if (json_get(resp, "name", sname, sizeof(sname))) {
                snprintf(name, sizeof(name), "%s", sname);
            }
            if (json_get(resp, "studentId", sroll, sizeof(sroll))) {
                snprintf(roll, sizeof(roll), "%s", sroll);
            }
            if (json_get(resp, "source", ssource, sizeof(ssource))) {
                server_matched = strcmp(ssource, "rfid") != 0;
            }
            have_details = server_matched;
        } else {
            queued = s_sd_ok && storage_enqueue(json);
            s_sync_now = queued;
        }
    } else {
        queued = s_sd_ok && storage_enqueue(json);
        s_sync_now = queued;
    }
    if (s_sd_ok) {
        storage_log_scan(at, uid_hex, roll, name);
    }

    if (have_details) {
        buzzer_beep(100);
    } else {
        buzzer_beep(60);
        vTaskDelay(pdMS_TO_TICKS(80));
        buzzer_beep(60);
    }
    /* LCD: the student's name on line 0 and roll number on line 1. */
    char line0[17];
    char line1[17];
    snprintf(line0, sizeof(line0), "%.16s", name);
    snprintf(line1, sizeof(line1), "%.16s", roll);
    lcd_show_temp(line0, line1, 4000);
    const char *source = (record && strpbrk(record, "|,"))
                             ? "card"
                             : server_matched ? "server"
                                              : (have_details ? "local" : "uid");
    ESP_LOGI(TAG, "[rfid] uid=%s roll=%s name=%s source=%s queued=%d",
             uid_hex, roll, name, source, queued);
}

/** Poll the reader; a card left on the antenna is re-reported after 3 s. */
static void rfid_task(void *arg)
{
    (void)arg;
    uint8_t uid[10];
    uint8_t uid_len = 0;
    uint8_t sak = 0;
    char last_uid[16] = "";
    TickType_t last_at = 0;

    for (;;) {
        if (rfid_read_uid(uid, &uid_len, &sak) && uid_len > 0) {
            char hex[16];
            size_t o = 0;
            for (uint8_t i = 0; i < uid_len && o + 2 < sizeof(hex); i++) {
                o += (size_t)snprintf(hex + o, sizeof(hex) - o, "%02X", uid[i]);
            }
            hex[o] = '\0';

            TickType_t now = xTaskGetTickCount();
            if (strcmp(hex, last_uid) != 0 ||
                now - last_at > pdMS_TO_TICKS(3000)) {
                char record[96];
                bool has_record = rfid_read_record(uid, sak, record,
                                                    sizeof(record));
                if (has_record) {
                    ESP_LOGI(TAG, "[rfid] card record: %s (sak=0x%02x)",
                             record, sak);
                }
                handle_card(hex, has_record ? record : NULL);
                snprintf(last_uid, sizeof(last_uid), "%s", hex);
                last_at = now;
            }
            /* Power-cycle the field once so a card left on the reader can
               answer REQA again on the next poll. */
            rfid_cycle_field();
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}

/* --------------------------------------------------------------------- TOTP */

/*
 * Self-contained SHA-1 + HMAC-SHA1. ESP-IDF 6.1's mbedtls moved the HMAC and
 * low-level SHA-1 entry points behind internal headers, so we roll our own
 * (identical to the pure-JS HMAC-SHA1 in shared/src/rollingCode.ts).
 */

typedef struct {
    uint32_t h[5];
    uint64_t len;
    uint8_t buf[64];
    size_t buflen;
} sha1_ctx_t;

static uint32_t rol32(uint32_t x, int n)
{
    return (x << n) | (x >> (32 - n));
}

static void sha1_block(sha1_ctx_t *c, const uint8_t *p)
{
    uint32_t w[80];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    }
    for (int i = 16; i < 80; i++) {
        w[i] = rol32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    uint32_t a = c->h[0], b = c->h[1], d = c->h[2], e = c->h[3], f = c->h[4];
    for (int i = 0; i < 80; i++) {
        uint32_t fn, k;
        if (i < 20) {
            fn = (b & d) | ((~b) & e);
            k = 0x5A827999;
        } else if (i < 40) {
            fn = b ^ d ^ e;
            k = 0x6ED9EBA1;
        } else if (i < 60) {
            fn = (b & d) | (b & e) | (d & e);
            k = 0x8F1BBCDC;
        } else {
            fn = b ^ d ^ e;
            k = 0xCA62C1D6;
        }
        uint32_t t = rol32(a, 5) + fn + f + k + w[i];
        f = e;
        e = d;
        d = rol32(b, 30);
        b = a;
        a = t;
    }
    c->h[0] += a;
    c->h[1] += b;
    c->h[2] += d;
    c->h[3] += e;
    c->h[4] += f;
}

static void sha1_init(sha1_ctx_t *c)
{
    c->h[0] = 0x67452301;
    c->h[1] = 0xEFCDAB89;
    c->h[2] = 0x98BADCFE;
    c->h[3] = 0x10325476;
    c->h[4] = 0xC3D2E1F0;
    c->len = 0;
    c->buflen = 0;
}

static void sha1_update(sha1_ctx_t *c, const uint8_t *p, size_t n)
{
    c->len += n;
    while (n > 0) {
        size_t take = 64 - c->buflen;
        if (take > n) {
            take = n;
        }
        memcpy(c->buf + c->buflen, p, take);
        c->buflen += take;
        p += take;
        n -= take;
        if (c->buflen == 64) {
            sha1_block(c, c->buf);
            c->buflen = 0;
        }
    }
}

static void sha1_final(sha1_ctx_t *c, uint8_t out[20])
{
    uint64_t bits = c->len * 8;
    uint8_t pad = 0x80, zero = 0, lb[8];
    sha1_update(c, &pad, 1);
    while (c->buflen != 56) {
        sha1_update(c, &zero, 1);
    }
    for (int i = 0; i < 8; i++) {
        lb[i] = (uint8_t)(bits >> (56 - i * 8));
    }
    sha1_update(c, lb, 8);
    for (int i = 0; i < 5; i++) {
        out[i * 4] = (uint8_t)(c->h[i] >> 24);
        out[i * 4 + 1] = (uint8_t)(c->h[i] >> 16);
        out[i * 4 + 2] = (uint8_t)(c->h[i] >> 8);
        out[i * 4 + 3] = (uint8_t)(c->h[i]);
    }
}

static void hmac_sha1(const uint8_t *key, size_t keylen, const uint8_t *msg,
                      size_t msglen, uint8_t out[20])
{
    uint8_t k[64], ipad[64], opad[64];
    memset(k, 0, sizeof(k));
    if (keylen > 64) {
        sha1_ctx_t c;
        sha1_init(&c);
        sha1_update(&c, key, keylen);
        sha1_final(&c, k);
    } else {
        memcpy(k, key, keylen);
    }
    for (int i = 0; i < 64; i++) {
        ipad[i] = k[i] ^ 0x36;
        opad[i] = k[i] ^ 0x5C;
    }
    sha1_ctx_t c;
    sha1_init(&c);
    sha1_update(&c, ipad, 64);
    sha1_update(&c, msg, msglen);
    sha1_final(&c, out);
    sha1_init(&c);
    sha1_update(&c, opad, 64);
    sha1_update(&c, out, 20);
    sha1_final(&c, out);
}

/** RFC 6238 rolling code for an explicit counter, as 6 zero-padded digits. */
static void totp_code_for(const char *secret, uint64_t counter, char out[7])
{
    uint8_t msg[8], digest[20];
    for (int i = 7; i >= 0; i--) {
        msg[i] = (uint8_t)(counter & 0xFF);
        counter >>= 8;
    }

    hmac_sha1((const uint8_t *)secret, strlen(secret), msg, sizeof(msg), digest);

    int off = digest[19] & 0x0F;
    uint32_t bin = ((uint32_t)(digest[off] & 0x7F) << 24) |
                   ((uint32_t)digest[off + 1] << 16) |
                   ((uint32_t)digest[off + 2] << 8) |
                   ((uint32_t)digest[off + 3]);
    snprintf(out, 7, "%06u", (unsigned)(bin % 1000000u));
}

/* ------------------------------------------------------------------- base64 */

/** Minimal base64 encoder for UTF-8 strings (the server decodes the secret as base64). */
static void base64_utf8(const char *in, char *out, size_t outsz)
{
    static const char *A =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t len = strlen(in), o = 0;
    for (size_t i = 0; i < len && o + 5 < outsz; i += 3) {
        uint32_t b0 = (uint8_t)in[i];
        uint32_t b1 = (i + 1 < len) ? (uint8_t)in[i + 1] : 0;
        uint32_t b2 = (i + 2 < len) ? (uint8_t)in[i + 2] : 0;
        out[o++] = A[b0 >> 2];
        out[o++] = A[((b0 & 0x03) << 4) | (b1 >> 4)];
        out[o++] = (i + 1 < len) ? A[((b1 & 0x0F) << 2) | (b2 >> 6)] : '=';
        out[o++] = (i + 2 < len) ? A[b2 & 0x3F] : '=';
    }
    out[o] = '\0';
}

/* --------------------------------------------------------------------- HTTP */

/** Server URL for outbound calls. Default SERVER_URL; overridden from NVS. */
static char s_server_url[128] = SERVER_URL;

static int http_post_json(const char *path, const char *body)
{
    if (strlen(s_server_url) == 0) {
        /* No server configured yet: skip the call cleanly instead of erroring. */
        return 0;
    }
    char url[256];
    snprintf(url, sizeof(url), "%s%s", s_server_url, path);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 2000,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) {
        return -1;
    }
    esp_http_client_set_header(c, "Content-Type", "application/json");
    esp_http_client_set_post_field(c, body, strlen(body));
    esp_err_t err = esp_http_client_perform(c);
    int status = (err == ESP_OK) ? esp_http_client_get_status_code(c) : -1;
    esp_http_client_cleanup(c);
    return status;
}

/** POST JSON and capture the response body (for the RFID UID lookup). */
static int http_post_json_resp(const char *path, const char *body, char *out,
                               size_t outsz)
{
    if (out && outsz) out[0] = '\0';
    if (strlen(s_server_url) == 0) return 0;
    char url[256];
    snprintf(url, sizeof(url), "%s%s", s_server_url, path);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return -1;
    esp_http_client_set_header(c, "Content-Type", "application/json");

    int status = -1;
    size_t total = 0;
    if (esp_http_client_open(c, strlen(body)) == ESP_OK) {
        esp_http_client_write(c, body, strlen(body));
        esp_http_client_fetch_headers(c);
        if (out && outsz > 1) {
            int n;
            while ((n = esp_http_client_read(c, out + total,
                                             (int)(outsz - 1 - total))) > 0) {
                total += (size_t)n;
                if (total >= outsz - 1) break;
            }
        }
        status = esp_http_client_get_status_code(c);
        esp_http_client_close(c);
    }
    if (out && outsz) out[total] = '\0';
    esp_http_client_cleanup(c);
    return status;
}

/** GET a path and copy the body into `out` (NUL-terminated). Returns status. */
static int http_get_text(const char *path, char *out, size_t outsz)
{
    out[0] = '\0';
    if (strlen(s_server_url) == 0 || outsz < 2) {
        return 0;
    }
    char url[256];
    snprintf(url, sizeof(url), "%s%s", s_server_url, path);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 2500,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) {
        return -1;
    }
    int status = -1;
    size_t total = 0;
    if (esp_http_client_open(c, 0) == ESP_OK) {
        esp_http_client_fetch_headers(c);
        int n;
        while ((n = esp_http_client_read(c, out + total,
                                         (int)(outsz - 1 - total))) > 0) {
            total += (size_t)n;
            if (total >= outsz - 1) {
                break;
            }
        }
        status = esp_http_client_get_status_code(c);
        esp_http_client_close(c);
    }
    out[total] = '\0';
    esp_http_client_cleanup(c);
    return status;
}

/**
 * LCD: live register count from the fusion server.
 * Line 1 "Present: X" (live); line 2 is the connected Wi-Fi SSID.
 */
static void refresh_attendance_lcd(void)
{
    lcd_tick_recover();
    /* A card tap / button message owns the LCD for a moment. */
    if (now_ms() < s_lcd_temp_until_ms) {
        return;
    }
    char body[2048];
    int status = http_get_text("/api/sessions/" PRESET_SESSION_ID "/attendance",
                               body, sizeof(body));
    if (status != 200) {
        lcd_print(0, "No server");
        lcd_print(1, s_wifi_up ? STA_SSID : "No WiFi");
        ESP_LOGW(TAG, "[lcd] attendance fetch status=%d", status);
        return;
    }

    int present = 0;
    int roster = 0;
    const char *p = strstr(body, "\"presentCount\":");
    if (p) {
        present = atoi(p + strlen("\"presentCount\":"));
    }
    p = strstr(body, "\"rosterCount\":");
    if (p) {
        roster = atoi(p + strlen("\"rosterCount\":"));
    }

    char line0[17];
    snprintf(line0, sizeof(line0), "Present: %d", present);
    lcd_print(0, line0);
    lcd_print(1, s_wifi_up ? STA_SSID : "No WiFi");
    ESP_LOGI(TAG, "[lcd] attendance %d/%d", present, roster);
}

/* --------------------------------------------------------------------- NVS */

/** Load a runtime server URL out of NVS (set via /api/node/config), if any. */
static void config_load_from_nvs(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(s_server_url) - 1;
        esp_err_t err = nvs_get_str(h, NVS_KEY_SERVER_URL, s_server_url, &len);
        nvs_close(h);
        if (err == ESP_OK) {
            // Never trust a loopback URL from a previous config: on-device it
            // points at the ESP32 itself, so the sync task spins on TLS errors
            // and starves BLE advertising. Fall back to the compile-time URL.
            if (strstr(s_server_url, "127.0.0.1") != NULL ||
                strstr(s_server_url, "localhost") != NULL ||
                strstr(s_server_url, "0.0.0.0") != NULL) {
                ESP_LOGW(TAG, "ignoring loopback server URL from NVS: %s",
                         s_server_url);
                snprintf(s_server_url, sizeof(s_server_url), "%s", SERVER_URL);
            } else {
                ESP_LOGI(TAG, "server URL from NVS: %s", s_server_url);
            }
        }
    }
    if (strlen(s_server_url) == 0) {
        ESP_LOGI(TAG, "no server URL configured; sync task is idle");
    }
}

/** Persist a new server URL into NVS (used immediately, and across reboots). */
static esp_err_t config_save_server_url(const char *url)
{
    nvs_handle_t h;
    esp_err_t err;
    if ((err = nvs_open(NVS_NS, NVS_READWRITE, &h)) != ESP_OK) {
        return err;
    }
    if ((err = nvs_set_str(h, NVS_KEY_SERVER_URL, url)) != ESP_OK) {
        nvs_close(h);
        return err;
    }
    err = nvs_commit(h);
    nvs_close(h);
    return err;
}

/* ----------------------------------------------------------------- node api */

/*
 * HTTP server on the SoftAP (192.168.4.1): a phone joined to `atlas` syncs the
 * node's clock and configures the fusion server here.
 *
 *   POST /api/node/time?unix=<seconds> | ?ms=<millis>
 *   POST /api/node/config?serverUrl=<url>
 *   GET  /api/node  -> diagnostics JSON
 *
 * These handlers run in esp_http_server's own task; they never touch BLE.
 */

static httpd_handle_t s_httpd = NULL;

static void send_status(httpd_req_t *req, const char *status)
{
    httpd_resp_set_status(req, status);
    httpd_resp_send(req, NULL, 0);
}

/** Receive + discard the request body so the client sees a clean response. */
static void httpd_drain_body(httpd_req_t *req)
{
    char sink[64];
    int remaining = (int)req->content_len;
    while (remaining > 0) {
        int n = httpd_req_recv(req, sink, remaining < (int)sizeof(sink)
                                   ? remaining
                                   : (int)sizeof(sink));
        if (n <= 0) {
            break;
        }
        remaining -= n;
    }
}

/** Parse ?unix=<seconds> or ?ms=<millis>; stores the result in seconds. */
static bool httpd_time_query(httpd_req_t *req, const char *name, time_t *out)
{
    char val[128];
    if (httpd_req_get_url_query_str(req, val, sizeof(val)) != ESP_OK) {
        return false;
    }
    char arg[24];
    if (httpd_query_key_value(val, name, arg, sizeof(arg)) != ESP_OK) {
        return false;
    }
    char *end = NULL;
    unsigned long long n = strtoull(arg, &end, 10);
    if (end == arg || *end != '\0' || n == 0) {
        return false;
    }
    *out = (time_t)(strcmp(name, "ms") == 0 ? n / 1000 : n);
    return true;
}

/** POST /api/node/time — ingest the phone's clock (guarded, monotonic). */
static esp_err_t node_time_post(httpd_req_t *req)
{
    httpd_drain_body(req);

    time_t offered = 0;
    if (!httpd_time_query(req, "unix", &offered) &&
        !httpd_time_query(req, "ms", &offered)) {
        ESP_LOGW(TAG, "[time-sync] rejected: missing/invalid ?unix or ?ms");
        send_status(req, "400 Bad Request");
        return ESP_OK;
    }

    time_t now = time(NULL);
    long delta = (long)(offered - now);
    if (delta < -CLOCK_SYNC_TOL_S) {
        /* Stale offer: applying it would rewind the clock — refuse. */
        ESP_LOGW(TAG, "[time-sync] REJECTED offered=%ld (node=%ld, delta=%ld s "
                      "stale — refusing to rewind)",
                 (long)offered, (long)now, delta);
        send_status(req, "409 Conflict");
        return ESP_OK;
    }

    struct timeval tv = {.tv_sec = offered, .tv_usec = 0};
    settimeofday(&tv, NULL);
    ESP_LOGI(TAG, "[time-sync] accepted offered=%ld (node was %ld, delta=%ld s), "
                  "clock now %ld",
             (long)offered, (long)now, delta, (long)time(NULL));
    send_status(req, "204 No Content");
    return ESP_OK;
}

/** POST /api/node/config — set the fusion server URL (NVS + RAM). */
static esp_err_t node_config_post(httpd_req_t *req)
{
    httpd_drain_body(req);

    char query[256];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) {
        ESP_LOGW(TAG, "[config] rejected: missing query (?serverUrl=...)");
        send_status(req, "400 Bad Request");
        return ESP_OK;
    }
    char url[128];
    if (httpd_query_key_value(query, "serverUrl", url, sizeof(url)) != ESP_OK) {
        ESP_LOGW(TAG, "[config] rejected: missing/runt serverUrl");
        send_status(req, "400 Bad Request");
        return ESP_OK;
    }
    if (strncmp(url, "http", 4) != 0 || strlen(url) < 10) {
        ESP_LOGW(TAG, "[config] rejected: serverUrl not a URL: '%s'", url);
        send_status(req, "400 Bad Request");
        return ESP_OK;
    }

    /* URL-unescape (a curl/phone URL query must be %xx-decoded before use). */
    for (char *w = url, *r = url; ; ++w, ++r) {
        if (*r == '%' && r[1] && r[2]) {
            char hex[3] = {(char)r[1], (char)r[2], 0};
            *w = (char)strtol(hex, NULL, 16);
            r += 2;
            continue;
        }
        *w = *r;
        if (!*r) {
            break;
        }
    }

    esp_err_t err = config_save_server_url(url);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "[config] NVS write failed: 0x%x", err);
        send_status(req, "500 Internal Server Error");
        return ESP_OK;
    }

    snprintf(s_server_url, sizeof(s_server_url), "%s", url);
    ESP_LOGI(TAG, "[config] server URL set to %s", s_server_url);
    send_status(req, "204 No Content");
    return ESP_OK;
}

/** GET /api/node — diagnostics: node, session, room, SSID, server, clock. */
static esp_err_t node_get(httpd_req_t *req)
{
    char json[320];
    snprintf(json, sizeof(json),
             "{\"nodeId\":\"%s\",\"sessionId\":\"%s\",\"roomId\":\"%s\","
             "\"ssid\":\"%s\",\"serverUrl\":\"%s\",\"unix\":%ld,"
             "\"lastUid\":\"%s\",\"sd\":%s}",
             NODE_ID, PRESET_SESSION_ID, PRESET_ROOM_ID, AP_SSID, s_server_url,
             (long)time(NULL), s_last_uid, s_sd_ok ? "true" : "false");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
    return ESP_OK;
}

/** Decode a URL query value in place (%xx and '+'). */
static void url_decode(char *s)
{
    for (char *w = s, *r = s; ; ++w, ++r) {
        if (*r == '+') {
            *w = ' ';
        } else if (*r == '%' && r[1] && r[2]) {
            char hex[3] = {r[1], r[2], 0};
            *w = (char)strtol(hex, NULL, 16);
            r += 2;
        } else {
            *w = *r;
        }
        if (!*r) break;
    }
}

/**
 * SoftAP card registration page: tap a card, open http://192.168.4.1/ on any
 * phone joined to `atlas`, and bind that UID to a roll/name. The binding is
 * written to /sdcard/rfid.csv (when present) and mirrored in NVS, so UID-only
 * cards can still mark attendance with full details.
 */
static esp_err_t node_index_get(httpd_req_t *req)
{
    char html[1200];
    snprintf(html, sizeof(html),
             "<!doctype html><meta name=viewport content='width=device-width'>"
             "<title>Shusseki card</title><body style='font-family:sans-serif;"
             "max-width:420px;margin:24px auto;padding:0 12px'>"
             "<h2>Shusseki card</h2>"
             "<p>Last card UID: <b>%s</b></p>"
             "<form method='get' action='/api/node/rfid'>"
             "<p>UID<br><input name='uid' value='%s' style='width:100%%'></p>"
             "<p>Roll number<br><input name='roll' style='width:100%%'></p>"
             "<p>Name<br><input name='name' style='width:100%%'></p>"
             "<button type='submit'>Save card</button></form>"
             "<p style='color:#666'>Tap a card, reload this page, then save "
             "its roll and name. Taps after that mark attendance with these "
             "details.</p></body>",
             s_last_uid[0] ? s_last_uid : "(none)", s_last_uid);
    httpd_resp_set_type(req, "text/html");
    httpd_resp_send(req, html, HTTPD_RESP_USE_STRLEN);
    return ESP_OK;
}

/** GET /api/node/rfid?uid=..&roll=..&name=.. — bind a card. */
static esp_err_t node_rfid_get(httpd_req_t *req)
{
    char query[384];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) {
        send_status(req, "400 Bad Request");
        return ESP_OK;
    }
    char uid[32], roll[64], name[64];
    if (httpd_query_key_value(query, "uid", uid, sizeof(uid)) != ESP_OK ||
        httpd_query_key_value(query, "roll", roll, sizeof(roll)) != ESP_OK ||
        httpd_query_key_value(query, "name", name, sizeof(name)) != ESP_OK) {
        send_status(req, "400 Bad Request");
        return ESP_OK;
    }
    url_decode(uid);
    url_decode(roll);
    url_decode(name);
    for (char *p = uid; *p; p++) *p = (char)toupper((unsigned char)*p);
    if (!*uid || !*roll || !*name) {
        send_status(req, "400 Bad Request");
        return ESP_OK;
    }
    bool saved = storage_add_mapping(uid, roll, name);
    ESP_LOGI(TAG, "[rfid] bind uid=%s roll=%s name=%s saved=%d", uid, roll,
             name, saved);
    char html[512];
    snprintf(html, sizeof(html),
             "<!doctype html><meta name=viewport content='width=device-width'>"
             "<body style='font-family:sans-serif;max-width:420px;margin:24px "
             "auto'><h2>%s</h2><p>%s &rarr; %s (%s)</p>"
             "<p><a href='/'>Register another card</a></p></body>",
             saved ? "Card saved" : "Save failed", uid, roll, name);
    httpd_resp_set_type(req, "text/html");
    httpd_resp_send(req, html, HTTPD_RESP_USE_STRLEN);
    lcd_show_temp("Card", roll, 2500);
    buzzer_beep(100);
    return ESP_OK;
}

static const httpd_uri_t node_api_uris[] = {
    {.uri = "/api/node/time", .method = HTTP_POST, .handler = node_time_post},
    {.uri = "/api/node/config", .method = HTTP_POST, .handler = node_config_post},
    {.uri = "/api/node/rfid", .method = HTTP_GET, .handler = node_rfid_get},
    {.uri = "/api/node", .method = HTTP_GET, .handler = node_get},
    {.uri = "/", .method = HTTP_GET, .handler = node_index_get},
};

static void node_api_init(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.lru_purge_enable = true;
    if (httpd_start(&s_httpd, &cfg) == ESP_OK) {
        for (size_t i = 0; i < sizeof(node_api_uris) / sizeof(node_api_uris[0]); i++) {
            httpd_register_uri_handler(s_httpd, &node_api_uris[i]);
        }
        ESP_LOGI(TAG, "node API on SoftAP port 80: / (card registration), "
                      "/api/node/time /api/node/config /api/node/rfid /api/node");
    } else {
        ESP_LOGW(TAG, "node API start failed");
    }
}

/* ---------------------------------------------------------------------- BLE */

static uint8_t s_mfg[40];
static esp_ble_adv_data_t s_adv_data = {
    .set_scan_rsp = false,
    .include_name = false,
    .include_txpower = false,
    .min_interval = 0x20,
    .max_interval = 0x40,
    .appearance = 0,
    .manufacturer_len = 0,
    .p_manufacturer_data = NULL,
    .service_data_len = 0,
    .p_service_data = NULL,
    .service_uuid_len = 0,
    .p_service_uuid = NULL,
    .flag = (ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT),
};
static esp_ble_adv_params_t s_adv_params = {
    .adv_int_min = 0x20,
    .adv_int_max = 0x40,
    .adv_type = ADV_TYPE_NONCONN_IND,
    .own_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .channel_map = ADV_CHNL_ALL,
    .adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};

static void gap_event_handler(esp_gap_ble_cb_event_t event,
                              esp_ble_gap_cb_param_t *param)
{
    switch (event) {
    case ESP_GAP_BLE_ADV_DATA_SET_COMPLETE_EVT:
        esp_ble_gap_start_advertising(&s_adv_params);
        break;
    case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
        if (param->adv_start_cmpl.status != ESP_BT_STATUS_SUCCESS) {
            ESP_LOGW(TAG, "advertising start failed: 0x%02x",
                     param->adv_start_cmpl.status);
        }
        break;
    default:
        break;
    }
}

/** (Re)publish the beacon with a new rolling code: `<nodeId>|<code>` @ 0xABCD. */
static void ble_advertise_code(const char *code)
{
    char payload[40];
    snprintf(payload, sizeof(payload), "%s|%s", NODE_ID, code);
    size_t n = strlen(payload);

    s_mfg[0] = 0xCD; /* company id 0xABCD, little-endian */
    s_mfg[1] = 0xAB;
    memcpy(&s_mfg[2], payload, n);

    s_adv_data.manufacturer_len = (uint16_t)(n + 2);
    s_adv_data.p_manufacturer_data = s_mfg;

    esp_ble_gap_stop_advertising();
    esp_ble_gap_config_adv_data(&s_adv_data); /* restarts in the callback */
}

static void bt_init(void)
{
    esp_bt_controller_config_t btc = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_bt_controller_init(&btc));
    ESP_ERROR_CHECK(esp_bt_controller_enable(ESP_BT_MODE_BLE));
    ESP_ERROR_CHECK(esp_bluedroid_init());
    ESP_ERROR_CHECK(esp_bluedroid_enable());
    ESP_ERROR_CHECK(esp_ble_gap_register_callback(gap_event_handler));
    ESP_ERROR_CHECK(esp_ble_gap_set_device_name("Shusseki-ESP32-TX"));
}

/* -------------------------------------------------------------- WiFi + time */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id,
                               void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_AP_START) {
        ESP_LOGI(TAG, "SoftAP up: ssid=\"%s\" (open, no password)", AP_SSID);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = (wifi_event_sta_disconnected_t *)data;
        ESP_LOGW(TAG, "STA disconnected, reason=%d — retrying", e->reason);
        led_set(false);
        s_wifi_up = false;
        s_attendance_now = true;
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "STA got IP " IPSTR, IP2STR(&e->ip_info.ip));
        led_set(true);
        s_wifi_up = true;
        s_attendance_now = true;
        s_sync_now = true;
        s_announce_now = true;
        // Route SoftAP clients out through the STA network (reaches the server).
        if (s_ap_netif && esp_netif_napt_enable(s_ap_netif) == ESP_OK) {
            ESP_LOGI(TAG, "NAPT enabled on SoftAP");
        }
    }
}

static void wifi_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();
    s_ap_netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");

    bool use_sta = strlen(STA_SSID) > 0;
    if (use_sta) {
        esp_netif_create_default_wifi_sta();
    }

    wifi_init_config_t ic = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&ic));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                               &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                               &wifi_event_handler, NULL));

    wifi_config_t ap = {0};
    strncpy((char *)ap.ap.ssid, AP_SSID, sizeof(ap.ap.ssid));
    ap.ap.ssid_len = strlen(AP_SSID);
    strncpy((char *)ap.ap.password, AP_PASS, sizeof(ap.ap.password));
    ap.ap.max_connection = 4;
    /* Open network: WIFI_AUTH_OPEN + empty password = no password prompt. */
    ap.ap.authmode = WIFI_AUTH_OPEN;

    wifi_config_t sta = {0};
    if (use_sta) {
        strncpy((char *)sta.sta.ssid, STA_SSID, sizeof(sta.sta.ssid));
#if STA_ENTERPRISE
        sta.sta.threshold.authmode = WIFI_AUTH_WPA2_ENTERPRISE;
#else
        strncpy((char *)sta.sta.password, STA_PASSWORD, sizeof(sta.sta.password));
        sta.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
#endif
    }

    ESP_ERROR_CHECK(esp_wifi_set_mode(use_sta ? WIFI_MODE_APSTA : WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    if (use_sta) {
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
#if STA_ENTERPRISE && CONFIG_ESP_WIFI_ENTERPRISE_SUPPORT
        esp_eap_client_set_identity((const unsigned char *)STA_USERNAME,
                                    (int)strlen(STA_USERNAME));
        esp_eap_client_set_username((const unsigned char *)STA_USERNAME,
                                    (int)strlen(STA_USERNAME));
        esp_eap_client_set_password((const unsigned char *)STA_PASSWORD,
                                    (int)strlen(STA_PASSWORD));
        esp_eap_client_set_eap_methods(ESP_EAP_TYPE_PEAP);
        ESP_ERROR_CHECK(esp_wifi_sta_enterprise_enable());
#endif
    }
    ESP_ERROR_CHECK(esp_wifi_start());
}

static void sntp_sync_cb(struct timeval *tv)
{
    ESP_LOGI(TAG, "SNTP synced: unix=%ld", (long)tv->tv_sec);
}

static void time_init(void)
{
    /* The LCD clock shows local IST; TOTP keeps using UTC internally. */
    setenv("TZ", "IST-5:30", 1);
    tzset();

    bool synced = false;
    if (strlen(STA_SSID) > 0) {
        esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
        cfg.sync_cb = sntp_sync_cb;
        esp_netif_sntp_init(&cfg);
        ESP_LOGI(TAG, "waiting for SNTP...");
        if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(2000)) == ESP_OK) {
            synced = true;
            ESP_LOGI(TAG, "SNTP synced");
        } else {
            ESP_LOGW(TAG, "SNTP not synced in 2s; will keep trying in background");
        }
    }
    if (!synced) {
        if (DEV_SEED_EPOCH > 0) {
            struct timeval tv = {.tv_sec = (time_t)DEV_SEED_EPOCH, .tv_usec = 0};
            settimeofday(&tv, NULL);
            ESP_LOGW(TAG, "clock seeded from build time (%ld) — no NTP",
                     (long)DEV_SEED_EPOCH);
        } else {
            ESP_LOGW(TAG, "no time source; rolling codes use an epoch-0 counter");
        }
    }
}

/* ------------------------------------------------------------------- sync task */

/**
 * Announce session + hotspot registration. Returns true only when BOTH POSTs
 * got a 2xx (http_post_json returns 0 when no server is configured, treated as
 * skip) — a session that announced a hotspot without registering the secret is
 * not a healthy announce.
 */
static bool announce_session(void)
{
    char secret_b64[64];
    base64_utf8(PRESET_SECRET, secret_b64, sizeof(secret_b64));

    char body[288];
    snprintf(body, sizeof(body),
             "{\"sessionId\":\"%s\",\"roomId\":\"%s\",\"secret\":\"%s\"}",
             PRESET_SESSION_ID, PRESET_ROOM_ID, secret_b64);
    int status_session = http_post_json("/api/sessions", body);
    ESP_LOGI(TAG, "POST /api/sessions -> %d", status_session);

    snprintf(body, sizeof(body),
             "{\"deviceId\":\"%s\",\"ssid\":\"%s\",\"passphrase\":\"%s\"}",
             NODE_ID, AP_SSID, AP_PASS);
    int status_hotspot =
        http_post_json("/api/sessions/" PRESET_SESSION_ID "/hotspot", body);
    ESP_LOGI(TAG, "POST /api/sessions/" PRESET_SESSION_ID "/hotspot -> %d",
             status_hotspot);

    return status_session >= 200 && status_session < 300 &&
           status_hotspot >= 200 && status_hotspot < 300;
}

/** Room-side "receive": fetch the server's presence roster and report the count. */
static void poll_presence(void)
{
    if (strlen(s_server_url) == 0) {
        return;
    }
    char url[256];
    snprintf(url, sizeof(url), "%s/api/sessions/%s/presence", s_server_url,
             PRESET_SESSION_ID);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 2000,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) {
        return;
    }
    char body[2048];
    int total = 0;
    if (esp_http_client_open(c, 0) == ESP_OK) {
        esp_http_client_fetch_headers(c);
        int n;
        while ((n = esp_http_client_read(c, body + total,
                                         (int)sizeof(body) - 1 - total)) > 0) {
            total += n;
            if (total >= (int)sizeof(body) - 1) {
                break;
            }
        }
    }
    body[total] = '\0';
    int present = 0;
    for (const char *p = body; (p = strstr(p, "\"present\":true")) != NULL; p++) {
        present++;
    }
    ESP_LOGI(TAG, "[room] session=%s present_devices=%d", PRESET_SESSION_ID,
             present);
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
}

/**
 * Own FreeRTOS task for ALL blocking server HTTP: re-announce (~every 50 s) and
 * poll presence (~every 25 s), hiding failures from the burst + BLE cadence.
 * If the last announce failed, it backs off — the next one waits ~4x longer.
 */
static void sync_task(void *arg)
{
    /* The first announce fires immediately (mirrors the old startup announce). */
    TickType_t last_announce = xTaskGetTickCount() - pdMS_TO_TICKS(ANNOUNCE_PERIOD_MS);
    TickType_t last_poll = xTaskGetTickCount();
    TickType_t last_attendance =
        xTaskGetTickCount() - pdMS_TO_TICKS(ATTENDANCE_PERIOD_MS);
    TickType_t last_sync = xTaskGetTickCount() - pdMS_TO_TICKS(SYNC_PERIOD_MS);
    bool announce_backoff = false;
    bool server_configured = strlen(s_server_url) > 0;
    TickType_t boot_ticks = xTaskGetTickCount();
    TickType_t last_sd_retry = 0;
    bool hw_logged = false;

    for (;;) {
        TickType_t now_ticks = xTaskGetTickCount();

        /* One delayed summary so a serial monitor attached after flashing still
           sees whether the SD / RFID / input hardware initialised. */
        if (!hw_logged && now_ticks - boot_ticks >= pdMS_TO_TICKS(4000)) {
            hw_logged = true;
            ESP_LOGI(TAG,
                     "[hw] sd=%s rfid=%s buzzer=GPIO%d ultrasound=GPIO%d "
                     "buttons=%d/%d levels=%d/%d pending=%d",
                     s_sd_ok ? "ok" : "missing",
                     rfid_ready() ? "ok" : "missing", BUZZER_GPIO,
                     ULTRASONIC_GPIO, BTN_SYNC_GPIO, BTN_CLEAR_GPIO,
                     gpio_get_level(BTN_SYNC_GPIO),
                     gpio_get_level(BTN_CLEAR_GPIO), storage_pending_count());
        }

        /* SD retry is intentionally off while testing without a card: each
           mount attempt stalls the SPI bus shared with the RFID reader. */
        (void)last_sd_retry;

        /* Re-pick the runtime server URL so a fresh /api/node/config is honoured. */
        bool configured = strlen(s_server_url) > 0;
        if (configured != server_configured) {
            server_configured = configured;
            announce_backoff = false; /* first attempt after (re)config: no backoff */
        }

        /* Fresh IP: announce immediately instead of waiting for the 50 s tick,
           so a server restart can't leave the session missing for a minute. */
        if (s_announce_now && configured) {
            s_announce_now = false;
            last_announce = now_ticks;
            announce_backoff = !announce_session();
        }

        /* A failed announce backs the next re-announcement off by 4x, so a
           dead/unreachable server can't hog the sync task while it stalls. */
        TickType_t announce_target =
            pdMS_TO_TICKS(ANNOUNCE_PERIOD_MS * (announce_backoff
                                                   ? ANNOUNCE_BACKOFF_FACTOR
                                                   : 1));
        if (now_ticks - last_announce >= announce_target) {
            if (configured) {
                last_announce = now_ticks;
                announce_backoff = !announce_session();
            } else {
                /* Idle until configured; retry softly so a config change lands fast. */
                last_announce = now_ticks - pdMS_TO_TICKS(ANNOUNCE_PERIOD_MS);
            }
        }

        if (now_ticks - last_poll >= pdMS_TO_TICKS(POLL_PERIOD_MS)) {
            last_poll = now_ticks;
            if (configured) {
                poll_presence();
            }
        }

        if (s_attendance_now) {
            s_attendance_now = false;
            last_attendance = now_ticks;
            if (configured) {
                refresh_attendance_lcd();
            }
        }

        if (now_ticks - last_attendance >= pdMS_TO_TICKS(ATTENDANCE_PERIOD_MS)) {
            last_attendance = now_ticks;
            if (configured) {
                refresh_attendance_lcd();
            }
        }

        /* Temporary card/button message requested by another task. */
        if (s_msg_pending) {
            s_msg_pending = false;
            lcd_print(0, s_msg0);
            lcd_print(1, s_msg1);
        }

        /* Button 2: drop the local upload queue (server rows are untouched). */
        if (s_clear_now) {
            s_clear_now = false;
            int removed = s_sd_ok ? storage_clear_pending() : 0;
            ESP_LOGI(TAG, "[sd] cleared %d local queued tap(s)", removed);
            lcd_show_temp("Queue", s_sd_ok ? "cleared" : "no SD", 2000);
            buzzer_beep(150);
        }

        /* Upload card taps: on demand (button / fresh tap / WiFi up) and
           periodically while the STA is connected. */
        if (configured && s_wifi_up && s_sd_ok &&
            (s_sync_now ||
             now_ticks - last_sync >= pdMS_TO_TICKS(SYNC_PERIOD_MS))) {
            s_sync_now = false;
            last_sync = now_ticks;
            int uploaded = storage_sync_pending(post_rfid);
            int left = storage_pending_count();
            if (uploaded > 0) {
                ESP_LOGI(TAG, "[sd] uploaded %d tap(s), %d still queued",
                         uploaded, left);
                lcd_show_temp("Synced", left ? "more pending" : "all taps", 1600);
                buzzer_beep(120);
            } else if (left > 0) {
                ESP_LOGI(TAG, "[sd] %d tap(s) pending (server unreachable)",
                         left);
            }
        }

        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

/* --------------------------------------------------------------------- BLE task */

/**
 * BLE refresh task (runs alone — the only task touching the GAP functions).
 * Rolls the TOTP and re-advertises on every step change.
 */
static void ble_task(void *arg)
{
    char code[7];
    uint64_t last_step = UINT64_MAX;

    for (;;) {
        time_t now = time(NULL);
        uint64_t step = (uint64_t)now / TOTP_STEP_S;
        if (last_step == UINT64_MAX) {
            /* Deterministic sanity vector: counter 0 is verifiable against shared/Node. */
            totp_code_for(PRESET_SECRET, 0, code);
            ESP_LOGI(TAG, "[totp] sanity counter=0 code=%s", code);
        }
        if (step != last_step) {
            last_step = step;
            totp_code_for(PRESET_SECRET, step, code);
            ESP_LOGI(TAG, "[tx] unix=%ld step=%llu code=%s", (long)now,
                     (unsigned long long)step, code);
            ble_advertise_code(code);
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Shusseki ESP32 transmitter starting (node=%s, room=%s)",
             NODE_ID, PRESET_ROOM_ID);

#if RFID_TEST_MODE
    /*
     * Standalone reader smoke test: no NVS, WiFi, BLE, server or SD. The LCD
     * shows the reader state and the hex UID of every card placed on the coil.
     */
    bool t_lcd_ok = lcd_init();
    spi_init();
    /* Park only the (unused) SD CS high; the SPI driver owns the RFID CS. */
    gpio_config_t t_sd_cs = {
        .pin_bit_mask = 1ULL << SD_CS_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&t_sd_cs);
    gpio_set_level(SD_CS_GPIO, 1);
    bool reader_ok = rfid_init();
    buzzer_init();
    if (t_lcd_ok) {
        lcd_print(0, reader_ok ? "RFID test" : "Reader FAIL");
        if (reader_ok) {
            lcd_print(1, "Tap card...");
        } else {
            char ver[24];
            snprintf(ver, sizeof(ver), "ver 0x%02X cs5 rst17", rfid_version());
            lcd_print(1, ver);
        }
    }
    ESP_LOGI(TAG, "RFID TEST MODE: reader=%s", reader_ok ? "ok" : "FAIL");
    for (;;) {
        uint8_t uid[10];
        uint8_t uid_len = 0;
        uint8_t sak = 0;
        static TickType_t last_probe = 0;
        if (reader_ok &&
            xTaskGetTickCount() - last_probe > pdMS_TO_TICKS(2000)) {
            last_probe = xTaskGetTickCount();
            /* Fresh field every 2 s: a card left ACTIVE after a failed select
               otherwise stops answering REQA forever. */
            rfid_cycle_field();
            rfid_probe();
        }
        if (reader_ok && rfid_read_uid(uid, &uid_len, &sak) && uid_len > 0) {
            char hex[24];
            size_t o = 0;
            for (uint8_t i = 0; i < uid_len && o + 2 < sizeof(hex); i++) {
                o += (size_t)snprintf(hex + o, sizeof(hex) - o, "%02X", uid[i]);
            }
            hex[o] = '\0';
            ESP_LOGI(TAG, "[test] UID=%s len=%u sak=0x%02x", hex, uid_len, sak);
            if (t_lcd_ok) {
                lcd_print(0, "UID:");
                lcd_print(1, hex);
            }
            buzzer_beep(120);
            rfid_cycle_field();
            vTaskDelay(pdMS_TO_TICKS(1500));
        } else {
            vTaskDelay(pdMS_TO_TICKS(200));
        }
    }
#endif

    esp_err_t nvs = nvs_flash_init();
    if (nvs == ESP_ERR_NVS_NO_FREE_PAGES ||
        nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    config_load_from_nvs();

    /* Bind the demo UID once (NVS). The SoftAP page can overwrite it later. */
    char bind_roll[64];
    char bind_name[64];
    if (!storage_lookup_uid(DEFAULT_BIND_UID, bind_roll, sizeof(bind_roll),
                            bind_name, sizeof(bind_name))) {
        if (storage_add_mapping(DEFAULT_BIND_UID, DEFAULT_BIND_ROLL,
                                DEFAULT_BIND_NAME)) {
            ESP_LOGI(TAG, "[rfid] bound %s -> %s, %s", DEFAULT_BIND_UID,
                     DEFAULT_BIND_ROLL, DEFAULT_BIND_NAME);
        }
    }

    led_init();

    // Show the LCD immediately at boot — it must not wait for WiFi/SNTP.
    bool lcd_ok = lcd_init();
    if (lcd_ok) {
        lcd_print(0, "Shusseki");
        lcd_print(1, STA_SSID);
    }

    spi_init();
    /* Park both chip-selects high before probing either SPI device: a floating
       RC522 CS during the SD mount can otherwise hold MISO and break detection. */
    gpio_config_t cs = {
        .pin_bit_mask = (1ULL << SD_CS_GPIO) | (1ULL << RFID_CS_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&cs);
    gpio_set_level(SD_CS_GPIO, 1);
    gpio_set_level(RFID_CS_GPIO, 1);
    if (!rfid_init()) {
        ESP_LOGW(TAG, "RFID reader unavailable (check 3.3V/SPI wiring)");
    }
#if SD_ENABLED
    s_sd_ok = storage_init();
#else
    s_sd_ok = false;
    ESP_LOGW(TAG, "microSD disabled (SD_ENABLED=0) — RFID uploads directly, "
                  "UID mappings use NVS");
#endif
    buzzer_init();
    ultrasonic_init();
    buttons_init();

    if (lcd_ok) {
        lcd_show_temp("Shusseki", s_sd_ok ? "SD ready" : "SD missing", 2500);
    }

    wifi_init();
    time_init();
    bt_init();
    node_api_init();

    xTaskCreate(sync_task, "sync", 6144, NULL, 5, NULL);
    xTaskCreate(ble_task, "ble", 6144, NULL, 5, NULL);
    xTaskCreate(rfid_task, "rfid", 4096, NULL, 4, NULL);
    xTaskCreate(button_task, "btn", 2048, NULL, 3, NULL);
    xTaskCreate(ultrasonic_task, "ultra", 2048, NULL, 3, NULL);
}


