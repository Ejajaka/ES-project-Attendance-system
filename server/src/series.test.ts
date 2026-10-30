import { test, expect } from "vitest";
import type { DeviceReport } from "shared";
import { buildSeries, strongestBle, SERIES_MAX_POINTS } from "./series";

const report = (
  deviceId: string,
  t: number,
  ble: number | null,
  wifi: number | null,
  snr: number | null,
  sessionId = "s1",
): DeviceReport => ({
  deviceId,
  mode: "jushin",
  roomId: "r1",
  sessionId,
  timestamp: t,
  ble: { readings: ble == null ? [] : [{ nodeId: "esp32", rssi: ble }] },
  wifi: { connectedToSoshin: wifi != null, soshinRssi: wifi },
  ultrasonic: { received: snr != null, valid: null, code: null, snr },
});

test("strongestBle picks the strongest beacon in a report", () => {
  const r = report("d1", 1, null, null, null);
  r.ble = {
    readings: [
      { nodeId: "a", rssi: -80 },
      { nodeId: "b", rssi: -55 },
      { nodeId: "c", rssi: -70 },
    ],
  };
  expect(strongestBle(r)).toBe(-55);
  expect(strongestBle(report("d1", 1, null, null, null))).toBeNull();
});

test("buildSeries groups per device, keeps nulls, and sorts by time", () => {
  const now = 100_000;
  const payload = buildSeries(
    "s1",
    [
      report("d2", now - 3000, null, -70, 12),
      report("d1", now - 1000, -55, -50, null),
      report("d1", now - 5000, -60, null, 44),
      report("d9", now - 1000, -90, -90, 1, "other-session"),
      report("d3", now - 20 * 60_000, -40, -40, 1), // outside window
    ],
    { now, windowMs: 60_000 },
  );

  expect(payload.devices.map((d) => d.deviceId).sort()).toEqual(["d1", "d2"]);
  const d1 = payload.devices.find((d) => d.deviceId === "d1")!;
  expect(d1.points.map((p) => p.t)).toEqual([now - 5000, now - 1000]);
  expect(d1.points[0]).toMatchObject({ ble: -60, wifi: null, snr: 44 });
  expect(d1.points[1]).toMatchObject({ ble: -55, wifi: -50, snr: null });
});

test("buildSeries caps each device to the newest points", () => {
  const now = 10_000;
  const reports = Array.from({ length: SERIES_MAX_POINTS + 30 }, (_, i) =>
    report("d1", now - (SERIES_MAX_POINTS + 30 - i) * 1000, -50, -50, 20),
  );
  const payload = buildSeries("s1", reports, { now, windowMs: 60 * 60_000 });
  expect(payload.devices[0]!.points).toHaveLength(SERIES_MAX_POINTS);
  expect(payload.devices[0]!.points.at(-1)!.t).toBe(now - 1000);
});
