import { test, expect } from "vitest";
import {
  averageRecent,
  signalPresence,
  WIFI_PRESENT_RSSI,
  BLE_PRESENT_RSSI,
} from "./signalPresence";

test("absent only when both channels are weak", () => {
  expect(WIFI_PRESENT_RSSI).toBe(-55);
  expect(BLE_PRESENT_RSSI).toBe(-65);

  // Strong WiFi keeps presence even with a weak BLE reading.
  expect(signalPresence({ avgWifi: -50, ble: -80 }).present).toBe(true);
  // Strong BLE keeps presence even with a weak WiFi average.
  expect(signalPresence({ avgWifi: -70, ble: -50 }).present).toBe(true);
  // Both weak → absent.
  expect(signalPresence({ avgWifi: -60, ble: -70 }).present).toBe(false);
});

test("missing channels count as weak", () => {
  expect(signalPresence({ avgWifi: null, ble: null }).present).toBe(false);
  expect(signalPresence({ avgWifi: -40, ble: null }).present).toBe(true);
  expect(signalPresence({ avgWifi: null, ble: -40 }).present).toBe(true);
});

test("thresholds are exclusive at the boundary", () => {
  expect(signalPresence({ avgWifi: -55, ble: -65 }).present).toBe(true);
  expect(signalPresence({ avgWifi: -55.1, ble: -65.1 }).present).toBe(false);
});

test("averageRecent smooths the newest finite samples", () => {
  expect(averageRecent([])).toBeNull();
  expect(averageRecent([Number.NaN, Number.POSITIVE_INFINITY as number])).toBeNull();
  expect(averageRecent([-40, -60])).toBe(-50);
  expect(averageRecent([-10, -20, -30, -40, -50, -60], 5)).toBe(-40);
});
