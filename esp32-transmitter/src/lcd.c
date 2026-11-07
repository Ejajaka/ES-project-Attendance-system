#include "lcd.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "lcd";

#define LCD_SDA_GPIO 21
#define LCD_SCL_GPIO 22
#define LCD_I2C_HZ 10000

/* Standard 16x2 I2C backpack (PCF8574): P0=RS, P1=RW, P2=EN, P3=BL. */
#define LCD_RS 0x01
#define LCD_RW 0x02
#define LCD_EN 0x04
#define LCD_BL 0x08

static i2c_master_bus_handle_t s_bus = NULL;
static i2c_master_dev_handle_t s_dev = NULL;
static const uint8_t s_bl = LCD_BL;

static uint32_t s_write_errors = 0;

static void lcd_write(uint8_t value)
{
    if (!s_dev) return;
    for (int attempt = 0; attempt < 3; attempt++) {
        esp_err_t err = i2c_master_transmit(s_dev, &value, 1, 100);
        if (err == ESP_OK) {
            return;
        }
        s_write_errors++;
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    static bool logged = false;
    if (!logged) {
        logged = true;
        ESP_LOGW(TAG, "i2c write failed repeatedly");
    }
}

/** Latch one 4-bit nibble: set data/RS, pulse EN high->low. */
static void lcd_write4(uint8_t nibble, bool rs)
{
    uint8_t base = (uint8_t)((nibble << 4) | s_bl | (rs ? LCD_RS : 0));
    lcd_write(base);
    vTaskDelay(pdMS_TO_TICKS(1));
    lcd_write((uint8_t)(base | LCD_EN));
    vTaskDelay(pdMS_TO_TICKS(2));
    lcd_write((uint8_t)(base & ~LCD_EN));
    vTaskDelay(pdMS_TO_TICKS(2));
}

static void lcd_cmd(uint8_t cmd)
{
    lcd_write4((uint8_t)(cmd >> 4), false);
    lcd_write4((uint8_t)(cmd & 0x0F), false);
    if (cmd == 0x01 || cmd == 0x02) {
        vTaskDelay(pdMS_TO_TICKS(2));
    }
}

static void lcd_data(uint8_t data)
{
    lcd_write4((uint8_t)(data >> 4), true);
    lcd_write4((uint8_t)(data & 0x0F), true);
}

static void lcd_hw_init(void)
{
    vTaskDelay(pdMS_TO_TICKS(100));
    lcd_write4(0x03, false);
    vTaskDelay(pdMS_TO_TICKS(5));
    lcd_write4(0x03, false);
    vTaskDelay(pdMS_TO_TICKS(1));
    lcd_write4(0x03, false);
    vTaskDelay(pdMS_TO_TICKS(1));
    lcd_write4(0x02, false); /* 4-bit */
    vTaskDelay(pdMS_TO_TICKS(1));

    lcd_cmd(0x28); /* 4-bit, 2 lines, 5x8 */
    lcd_cmd(0x0C); /* display on, cursor off */
    lcd_cmd(0x06); /* entry mode */
    lcd_cmd(0x01); /* clear */
    lcd_cmd(0x02); /* home */
}

bool lcd_init(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = I2C_NUM_0,
        .sda_io_num = LCD_SDA_GPIO,
        .scl_io_num = LCD_SCL_GPIO,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    if (i2c_new_master_bus(&bus_cfg, &s_bus) != ESP_OK) {
        ESP_LOGE(TAG, "i2c bus init failed");
        return false;
    }

    uint8_t addr = 0;
    if (i2c_master_probe(s_bus, 0x27, 100) == ESP_OK) {
        addr = 0x27;
    } else if (i2c_master_probe(s_bus, 0x3F, 100) == ESP_OK) {
        addr = 0x3F;
    } else {
        ESP_LOGW(TAG, "no LCD backpack found at 0x27/0x3F (SDA=%d SCL=%d)",
                 LCD_SDA_GPIO, LCD_SCL_GPIO);
        return false;
    }

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = LCD_I2C_HZ,
    };
    if (i2c_master_bus_add_device(s_bus, &dev_cfg, &s_dev) != ESP_OK) {
        ESP_LOGE(TAG, "i2c add device 0x%02x failed", addr);
        return false;
    }

    lcd_hw_init();
    ESP_LOGI(TAG, "LCD ready at 0x%02x (standard mapping)", addr);

    lcd_cmd(0x01);
    lcd_cmd(0x02);
    return true;
}

void lcd_print(int row, const char *text)
{
    if (!s_dev) return;
    lcd_cmd(row == 0 ? 0x80 : 0xC0);
    const size_t n = strlen(text);
    for (size_t i = 0; i < 16; i++) {
        /* Pad the whole line so leftovers from a previous update can't show. */
        lcd_data((uint8_t)(i < n ? text[i] : ' '));
    }
}

void lcd_tick_recover(void)
{
    static uint32_t seen = 0;
    if (s_write_errors == seen) {
        return;
    }
    seen = s_write_errors;
    ESP_LOGW(TAG, "recovering LCD after %u write error(s)",
             (unsigned)s_write_errors);
    lcd_hw_init();
    lcd_cmd(0x01);
    lcd_cmd(0x02);
}
