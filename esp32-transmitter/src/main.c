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
 *   3. Raises a SoftAP for the receiver to join, and announces its SSID to the
 *      fusion server so the receiver can auto-join (POST /api/sessions/:id/hotspot).
 *   4. Emits the 1.8 kHz burst presence stamp on LEDC pin ULTRASONIC_GPIO.
 *
 * Tune the CONFIG block below per room. The server must be reachable from the
 * ESP32's network (the fusion server binds 0.0.0.0 on the dev PC).
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_system.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_http_client.h"
#include "nvs_flash.h"

#include "driver/ledc.h"

#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_gap_ble_api.h"

static const char *TAG = "shusseki-tx";

/* ------------------------------------------------------------------ CONFIG */

/** Stable node id advertised in the BLE beacon (shown in the receiver's link view). */
#define NODE_ID "esp32-tx1"

/** Fusion server base URL. Reachable from the ESP32's network. */
#define SERVER_URL "http://192.168.29.227:8787"

/* Preset ROOM 01 — must match app/src/lib/presets.ts (room/session/secret). */
#define PRESET_ROOM_ID "room-1"
#define PRESET_SESSION_ID "sess-1"
#define PRESET_SECRET "shusseki-preset-1-secret"

/* SoftAP that receivers auto-join (announced to the server, so any name works). */
#define AP_SSID "Shusseki-ESP32"
#define AP_PASS "shusseki123"

/**
 * Optional: join an existing WiFi that has internet so the clock can NTP-sync.
 * Leave empty to fall back to the build-time clock seed (DEV_SEED_EPOCH).
 */
#define STA_SSID ""
#define STA_PASS ""

#define TOTP_STEP_S 30

/* 1.8 kHz presence stamp on a GPIO via LEDC (drive a small amp + speaker). */
#define ENABLE_ULTRASONIC 1
#define ULTRASONIC_GPIO 25

#ifndef DEV_SEED_EPOCH
#define DEV_SEED_EPOCH 0
#endif

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

static int http_post_json(const char *path, const char *body)
{
    char url[192];
    snprintf(url, sizeof(url), "%s%s", SERVER_URL, path);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 5000,
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
        ESP_LOGI(TAG, "SoftAP up: ssid=\"%s\" pass=\"%s\"", AP_SSID, AP_PASS);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "STA got IP " IPSTR, IP2STR(&e->ip_info.ip));
    }
}

static void wifi_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();

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
    ap.ap.authmode = WIFI_AUTH_WPA2_PSK;

    wifi_config_t sta = {0};
    if (use_sta) {
        strncpy((char *)sta.sta.ssid, STA_SSID, sizeof(sta.sta.ssid));
        strncpy((char *)sta.sta.password, STA_PASS, sizeof(sta.sta.password));
    }

    ESP_ERROR_CHECK(esp_wifi_set_mode(use_sta ? WIFI_MODE_APSTA : WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    if (use_sta) {
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
    }
    ESP_ERROR_CHECK(esp_wifi_start());
}

static void time_init(void)
{
    if (strlen(STA_SSID) > 0) {
        esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
        esp_netif_sntp_init(&cfg);
        ESP_LOGI(TAG, "waiting for SNTP...");
        if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(15000)) == ESP_OK) {
            ESP_LOGI(TAG, "SNTP synced");
        } else {
            ESP_LOGW(TAG, "SNTP did not sync in time");
        }
    } else if (DEV_SEED_EPOCH > 0) {
        struct timeval tv = {.tv_sec = (time_t)DEV_SEED_EPOCH, .tv_usec = 0};
        settimeofday(&tv, NULL);
        ESP_LOGW(TAG, "clock seeded from build time (%ld) — no NTP",
                 (long)DEV_SEED_EPOCH);
    } else {
        ESP_LOGW(TAG, "no time source; rolling codes will use an epoch-0 counter");
    }
}

/* --------------------------------------------------------------- ultrasonic */

static void ultrasonic_init(void)
{
#if ENABLE_ULTRASONIC
    ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 1800,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&t));

    ledc_channel_config_t c = {
        .gpio_num = ULTRASONIC_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
        .hpoint = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&c));
    ESP_LOGI(TAG, "ultrasonic stamp on GPIO%d @ 1800 Hz", ULTRASONIC_GPIO);
#endif
}

/** 4 x 120 ms tone bursts with 220 ms gaps — matches ShussekiUltrasonicModule.kt. */
static void ultrasonic_burst(void)
{
#if ENABLE_ULTRASONIC
    for (int i = 0; i < 4; i++) {
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 512 /* 50% */);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
        vTaskDelay(pdMS_TO_TICKS(120));
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
        if (i < 3) {
            vTaskDelay(pdMS_TO_TICKS(220));
        }
    }
#endif
}

/* ------------------------------------------------------------------- main task */

static void announce_session(void)
{
    char secret_b64[64];
    base64_utf8(PRESET_SECRET, secret_b64, sizeof(secret_b64));

    char body[288];
    snprintf(body, sizeof(body),
             "{\"sessionId\":\"%s\",\"roomId\":\"%s\",\"secret\":\"%s\"}",
             PRESET_SESSION_ID, PRESET_ROOM_ID, secret_b64);
    ESP_LOGI(TAG, "POST /api/sessions -> %d", http_post_json("/api/sessions", body));

    snprintf(body, sizeof(body),
             "{\"deviceId\":\"%s\",\"ssid\":\"%s\",\"passphrase\":\"%s\"}",
             NODE_ID, AP_SSID, AP_PASS);
    ESP_LOGI(TAG, "POST /api/sessions/" PRESET_SESSION_ID "/hotspot -> %d",
             http_post_json("/api/sessions/" PRESET_SESSION_ID "/hotspot", body));
}

static void transmitter_task(void *arg)
{
    char code[7];

    /* Deterministic sanity vector: counter 0 is verifiable against shared/Node. */
    totp_code_for(PRESET_SECRET, 0, code);
    ESP_LOGI(TAG, "[totp] sanity counter=0 code=%s", code);

    announce_session();

    uint64_t last_step = UINT64_MAX;
    for (;;) {
        time_t now = time(NULL);
        uint64_t step = (uint64_t)now / TOTP_STEP_S;

        if (step != last_step) {
            last_step = step;
            totp_code_for(PRESET_SECRET, step, code);
            ESP_LOGI(TAG, "[tx] unix=%ld step=%llu code=%s", (long)now,
                     (unsigned long long)step, code);
            ble_advertise_code(code);
        }

        ultrasonic_burst();
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Shusseki ESP32 transmitter starting (node=%s, room=%s)",
             NODE_ID, PRESET_ROOM_ID);

    esp_err_t nvs = nvs_flash_init();
    if (nvs == ESP_ERR_NVS_NO_FREE_PAGES ||
        nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    wifi_init();
    time_init();
    ultrasonic_init();
    bt_init();

    xTaskCreate(transmitter_task, "tx", 8192, NULL, 5, NULL);
}
