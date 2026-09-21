Import("env")
import time

# Stamp the firmware with the build time so the rolling code has a usable clock
# even without NTP (the ESP32 has no RTC backup). Used only when STA_SSID is empty.
env.Append(BUILD_FLAGS=["-DDEV_SEED_EPOCH=%d" % int(time.time())])
