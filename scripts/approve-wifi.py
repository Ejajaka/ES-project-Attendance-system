#!/usr/bin/env python3
"""Wait for an Android WiFi NetworkRequest dialog and tap its positive button.

Usage: approve_wifi.py <serial> [button_text] [timeout_s]

The LG (Android 10) shows com.lge.wifisettings/NetworkRequestDialogActivity
when the app requests a WifiNetworkSpecifier. The positive button stays
disabled until the target AP is visible, so poll until it is enabled.
"""
import re
import subprocess
import sys
import time


def dump(serial: str) -> str:
    out = subprocess.run(
        ["adb", "-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    return out.stdout


def main() -> int:
    serial = sys.argv[1]
    button = sys.argv[2] if len(sys.argv) > 2 else "CONNECT"
    timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 90.0
    deadline = time.time() + timeout

    while time.time() < deadline:
        xml = dump(serial)
        pattern = (
            rf'text="{re.escape(button)}"[^>]*?enabled="true"[^>]*?'
            r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        )
        m = re.search(pattern, xml)
        if m:
            x1, y1, x2, y2 = (int(v) for v in m.groups())
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
            subprocess.run(
                ["adb", "-s", serial, "shell", "input", "tap", str(cx), str(cy)],
                check=True,
            )
            print(f"tapped {button} at ({cx},{cy})")
            return 0
        if f'text="{button}"' in xml:
            print(f"{button} present but disabled; waiting…")
        time.sleep(2)

    print(f"timed out waiting for enabled {button}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
