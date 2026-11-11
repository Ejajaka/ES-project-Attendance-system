#include "rfid.h"

#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "rfid";

#define RFID_CS_GPIO 5
#define RFID_RST_GPIO 17

/* MFRC522 registers (datasheet §9). */
#define REG_COMMAND 0x01
#define REG_COM_IEN 0x02
#define REG_COM_IRQ 0x04
#define REG_ERROR 0x06
#define REG_FIFO_DATA 0x09
#define REG_FIFO_LEVEL 0x0A
#define REG_CONTROL 0x0C
#define REG_BIT_FRAMING 0x0D
#define REG_COLL 0x0E
#define REG_MODE 0x11
#define REG_STATUS2 0x08
#define REG_CRC_RESULT_H 0x21
#define REG_CRC_RESULT_L 0x22
#define REG_TX_CONTROL 0x14
#define REG_TX_ASK 0x15
#define REG_T_MODE 0x2A
#define REG_T_PRESCALER 0x2B
#define REG_T_RELOAD_H 0x2C
#define REG_T_RELOAD_L 0x2D
#define REG_VERSION 0x37

#define CMD_IDLE 0x00
#define CMD_TRANSCEIVE 0x0C
#define CMD_MFAUTHENT 0x0E
#define CMD_SOFT_RESET 0x0F

#define PICC_REQA 0x26
#define PICC_SEL_CL1 0x93
#define PICC_ANTICOLL 0x20
#define PICC_SELECT 0x70

static spi_device_handle_t s_spi = NULL;
static bool s_ready = false;

static void rfid_write(uint8_t reg, uint8_t value)
{
    uint8_t tx[2] = {(uint8_t)((reg << 1) & 0x7E), value};
    spi_transaction_t t = {
        .length = 8 * sizeof(tx),
        .tx_buffer = tx,
    };
    spi_device_transmit(s_spi, &t);
}

static uint8_t rfid_read(uint8_t reg)
{
    uint8_t tx[2] = {(uint8_t)(((reg << 1) & 0x7E) | 0x80), 0};
    uint8_t rx[2] = {0, 0};
    spi_transaction_t t = {
        .length = 8 * sizeof(tx),
        .tx_buffer = tx,
        .rx_buffer = rx,
    };
    spi_device_transmit(s_spi, &t);
    return rx[1];
}

static void rfid_set_bit(uint8_t reg, uint8_t mask)
{
    rfid_write(reg, (uint8_t)(rfid_read(reg) | mask));
}

static void rfid_clear_bit(uint8_t reg, uint8_t mask)
{
    rfid_write(reg, (uint8_t)(rfid_read(reg) & ~mask));
}

static void rfid_antenna(bool on)
{
    if (on) {
        rfid_set_bit(REG_TX_CONTROL, 0x03);
    } else {
        rfid_clear_bit(REG_TX_CONTROL, 0x03);
    }
}

void rfid_cycle_field(void)
{
    if (!s_ready) return;
    rfid_antenna(false);
    vTaskDelay(pdMS_TO_TICKS(20));
    rfid_antenna(true);
    vTaskDelay(pdMS_TO_TICKS(20));
}

static void rfid_reset_chip(void)
{
    gpio_set_level(RFID_RST_GPIO, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(RFID_RST_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(50));

    rfid_write(REG_COMMAND, CMD_SOFT_RESET);
    vTaskDelay(pdMS_TO_TICKS(50));

    /* 25 ms timer, 100% ASK, CRC preset 0x6363. */
    rfid_write(REG_T_MODE, 0x8D);
    rfid_write(REG_T_PRESCALER, 0x3E);
    rfid_write(REG_T_RELOAD_H, 0x1E);
    rfid_write(REG_T_RELOAD_L, 0x00);
    rfid_write(REG_TX_ASK, 0x40);
    rfid_write(REG_MODE, 0x3D);
    rfid_antenna(true);
}

bool rfid_init(void)
{
    gpio_config_t rst = {
        .pin_bit_mask = 1ULL << RFID_RST_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&rst);
    gpio_set_level(RFID_RST_GPIO, 1);

    spi_device_interface_config_t dev = {
        .clock_speed_hz = 4 * 1000 * 1000,
        .mode = 0,
        .spics_io_num = RFID_CS_GPIO,
        .queue_size = 1,
    };
    if (spi_bus_add_device(SPI2_HOST, &dev, &s_spi) != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_add_device failed (CS=%d)", RFID_CS_GPIO);
        return false;
    }

    rfid_reset_chip();
    uint8_t version = rfid_read(REG_VERSION);
    ESP_LOGI(TAG, "MFRC522 version=0x%02x (CS=%d RST=%d)", version,
             RFID_CS_GPIO, RFID_RST_GPIO);
    if (version == 0x00 || version == 0xFF) {
        ESP_LOGW(TAG, "no MFRC522 answering — card taps disabled");
        s_ready = false;
        return false;
    }
    s_ready = true;
    return true;
}

bool rfid_ready(void)
{
    return s_ready;
}

/** Send a frame; returns false on error/timeout. `tx_last_bits` 0 = whole bytes. */
static bool pcd_transceive(const uint8_t *send, uint8_t send_len,
                           uint8_t *back, uint16_t *back_bits,
                           uint8_t tx_last_bits)
{
    rfid_write(REG_COMMAND, CMD_IDLE);
    rfid_write(REG_COM_IRQ, 0x7F); /* clear all IRQs */
    rfid_write(REG_FIFO_LEVEL, 0x80); /* flush FIFO */
    for (uint8_t i = 0; i < send_len; i++) {
        rfid_write(REG_FIFO_DATA, send[i]);
    }
    rfid_write(REG_COMMAND, CMD_TRANSCEIVE);
    if (tx_last_bits) {
        rfid_write(REG_BIT_FRAMING, tx_last_bits);
    }
    rfid_set_bit(REG_BIT_FRAMING, 0x80); /* StartSend */

    TickType_t start = xTaskGetTickCount();
    bool got_irq = false;
    while (xTaskGetTickCount() - start < pdMS_TO_TICKS(60)) {
        uint8_t irq = rfid_read(REG_COM_IRQ);
        if (irq & 0x30) { /* RxIRq or IdleIRq */
            got_irq = true;
            break;
        }
        vTaskDelay(1);
    }
    rfid_clear_bit(REG_BIT_FRAMING, 0x80);

    if (!got_irq) {
        *back_bits = 0;
        return false;
    }

    uint8_t err = rfid_read(REG_ERROR);
    if (err & 0x13) { /* BufferOvfl | ParityErr | ProtocolErr */
        *back_bits = 0;
        return false;
    }

    uint8_t n = (uint8_t)(rfid_read(REG_FIFO_LEVEL) & 0x7F);
    uint8_t last = (uint8_t)(rfid_read(REG_CONTROL) & 0x07);
    if (n == 0) {
        *back_bits = 0;
        return false;
    }
    uint16_t bits = (uint16_t)(n > 1 ? (n - 1) * 8 : 0);
    bits = (uint16_t)(bits + (last ? last : 8));
    for (uint8_t i = 0; i < n; i++) {
        back[i] = rfid_read(REG_FIFO_DATA);
    }
    *back_bits = bits;
    return true;
}

static bool picc_request(void)
{
    uint8_t cmd = PICC_REQA;
    uint8_t back[64] = {0};
    uint16_t bits = 0;
    if (!pcd_transceive(&cmd, 1, back, &bits, 7)) {
        return false;
    }
    return bits == 16;
}

static bool picc_anticoll(uint8_t uid[4])
{
    uint8_t cmd[2] = {PICC_SEL_CL1, PICC_ANTICOLL};
    uint8_t back[64] = {0};
    uint16_t bits = 0;
    rfid_write(REG_BIT_FRAMING, 0x00);
    if (!pcd_transceive(cmd, sizeof(cmd), back, &bits, 0)) {
        return false;
    }
    if (bits != 40) {
        return false;
    }
    uint8_t bcc = (uint8_t)(back[0] ^ back[1] ^ back[2] ^ back[3]);
    if (bcc != back[4]) {
        ESP_LOGW(TAG, "UID BCC mismatch");
        return false;
    }
    memcpy(uid, back, 4);
    return true;
}

static bool picc_select(const uint8_t uid[4], uint8_t *sak)
{
    uint8_t cmd[7] = {
        PICC_SEL_CL1, PICC_SELECT, uid[0], uid[1], uid[2], uid[3],
        (uint8_t)(uid[0] ^ uid[1] ^ uid[2] ^ uid[3]),
    };
    uint8_t back[64] = {0};
    uint16_t bits = 0;
    rfid_write(REG_BIT_FRAMING, 0x00);
    if (!pcd_transceive(cmd, sizeof(cmd), back, &bits, 0)) {
        return false;
    }
    if (bits != 24) return false; /* SAK */
    if (sak) *sak = back[0];
    return true;
}

/* ---------------------------------------------------- MIFARE card records */

static const uint8_t k_default_keys[][6] = {
    {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF},
    {0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5},
    {0xD3, 0xF7, 0xD3, 0xF7, 0xD3, 0xF7},
    {0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
};

static void pcd_stop_crypto(void)
{
    rfid_clear_bit(REG_STATUS2, 0x08);
}

/** MIFARE Classic key-A authentication (ISO 14443-3 Crypto1). */
static bool pcd_auth_keya(uint8_t block, const uint8_t key[6],
                          const uint8_t uid[4])
{
    uint8_t buf[12] = {0x60, block};
    memcpy(buf + 2, key, 6);
    memcpy(buf + 8, uid, 4);

    pcd_stop_crypto();
    rfid_write(REG_COMMAND, CMD_IDLE);
    rfid_write(REG_COM_IRQ, 0x7F);
    rfid_write(REG_FIFO_LEVEL, 0x80);
    for (size_t i = 0; i < sizeof(buf); i++) {
        rfid_write(REG_FIFO_DATA, buf[i]);
    }
    rfid_write(REG_COMMAND, CMD_MFAUTHENT);

    TickType_t start = xTaskGetTickCount();
    bool idle = false;
    while (xTaskGetTickCount() - start < pdMS_TO_TICKS(80)) {
        if (rfid_read(REG_COM_IRQ) & 0x10) { /* IdleIRq */
            idle = true;
            break;
        }
        vTaskDelay(1);
    }
    if (!idle) return false;
    if (rfid_read(REG_ERROR) & 0x13) return false;
    return (rfid_read(REG_STATUS2) & 0x08) != 0; /* Crypto1On */
}

/** Read one 16-byte MIFARE Classic block (caller is authenticated). */
static bool mifare_read_block(uint8_t block, uint8_t out[16])
{
    uint8_t cmd[2] = {0x30, block};
    uint8_t back[64] = {0};
    uint16_t bits = 0;
    rfid_write(REG_BIT_FRAMING, 0x00);
    if (!pcd_transceive(cmd, sizeof(cmd), back, &bits, 0)) return false;
    if (bits < 144) return false; /* 16 data + 2 CRC */
    memcpy(out, back, 16);
    return true;
}

/** First printable run containing '|', trimmed; strips a 2-char NDEF lang tag. */
static bool extract_record(const uint8_t *data, int n, char *out,
                           size_t out_sz)
{
    int i = 0;
    while (i < n) {
        while (i < n && (data[i] < 0x20 || data[i] > 0x7E)) i++;
        int start = i;
        bool has_bar = false;
        while (i < n && data[i] >= 0x20 && data[i] <= 0x7E) {
            if (data[i] == '|') has_bar = true;
            i++;
        }
        if (!has_bar || i - start < 3) continue;
        int s = start;
        int e = i;
        while (s < e && data[s] == ' ') s++;
        while (e > s && data[e - 1] == ' ') e--;
        /* NDEF text records prefix the payload with a language code ("en"). */
        if (e - s > 4 && data[s] >= 'a' && data[s] <= 'z' &&
            data[s + 1] >= 'a' && data[s + 1] <= 'z' &&
            data[s + 2] == '|') {
            s += 2;
        } else if (e - s > 5 && data[s] >= 'a' && data[s] <= 'z' &&
                   data[s + 1] >= 'a' && data[s + 1] <= 'z' &&
                   data[s + 2] >= 'A' && data[s + 2] <= 'Z') {
            s += 2;
        }
        int len = e - s;
        if (len >= 3 && (size_t)len < out_sz) {
            memcpy(out, data + s, (size_t)len);
            out[len] = '\0';
            return true;
        }
    }
    return false;
}

bool rfid_read_record(const uint8_t uid[4], uint8_t sak, char *out,
                      size_t out_sz)
{
    if (!s_ready || !uid || !out || out_sz < 4) return false;
    uint8_t data[64];
    size_t got = 0;
    bool any = false;

    if (sak & 0x08) {
        /* MIFARE Classic: try sector 1 blocks 4-6, then sector 0 blocks 1-2. */
        const uint8_t sector1[] = {4, 5, 6};
        const uint8_t sector0[] = {1, 2};
        for (size_t k = 0; k < sizeof(k_default_keys) / 6 && got == 0; k++) {
            if (!pcd_auth_keya(4, k_default_keys[k], uid)) {
                pcd_stop_crypto();
                continue;
            }
            for (size_t b = 0; b < sizeof(sector1); b++) {
                uint8_t blk[16];
                if (mifare_read_block(sector1[b], blk) &&
                    got + 16 <= sizeof(data)) {
                    memcpy(data + got, blk, 16);
                    got += 16;
                    any = true;
                }
            }
            pcd_stop_crypto();
        }
        if (!any) {
            for (size_t k = 0; k < sizeof(k_default_keys) / 6; k++) {
                if (!pcd_auth_keya(1, k_default_keys[k], uid)) {
                    pcd_stop_crypto();
                    continue;
                }
                for (size_t b = 0; b < sizeof(sector0); b++) {
                    uint8_t blk[16];
                    if (mifare_read_block(sector0[b], blk) &&
                        got + 16 <= sizeof(data)) {
                        memcpy(data + got, blk, 16);
                        got += 16;
                        any = true;
                    }
                }
                pcd_stop_crypto();
            }
        }
    } else {
        /* NTAG/Ultralight: 4 pages per read from page 4 through page 15. */
        for (uint8_t page = 4; page < 16; page += 4) {
            uint8_t cmd[2] = {0x30, page};
            uint8_t back[64] = {0};
            uint16_t bits = 0;
            rfid_write(REG_BIT_FRAMING, 0x00);
            if (pcd_transceive(cmd, sizeof(cmd), back, &bits, 0) &&
                bits >= 128 && got + 16 <= sizeof(data)) {
                memcpy(data + got, back, 16);
                got += 16;
                any = true;
            }
        }
    }

    if (!any) return false;
    return extract_record(data, (int)got, out, out_sz);
}

bool rfid_read_uid(uint8_t uid[10], uint8_t *uid_len, uint8_t *sak)
{
    if (!s_ready) return false;

    /* A card left in the field stays ACTIVE; cycling the field lets it answer
       REQA again on the next poll. */
    rfid_cycle_field();

    if (!picc_request()) return false;

    uint8_t candidate[4];
    uint8_t candidate_sak = 0;
    if (!picc_anticoll(candidate)) return false;
    if (!picc_select(candidate, &candidate_sak)) return false;

    memcpy(uid, candidate, 4);
    if (uid_len) *uid_len = 4;
    if (sak) *sak = candidate_sak;
    return true;
}
