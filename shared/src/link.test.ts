import { test, expect } from "vitest";
import { summarizeLink } from "./link";
import type { DeviceReport } from "./types";

/**
 * Link stats are the "connection health" view of one receiver↔transmitter
 * pair across the three physical channels: BLE, WiFi and ultrasound.
 */

const BASE: Omit<DeviceReport, "ble" | "wifi" | "ultrasonic"> = {
  deviceId: "phone-1",
  mode: "jushin",
  roomId: "room-1",
  sessionId: "sess-1",
  timestamp: 1_700_000_000_000,
};

function report(partial: Partial<DeviceReport>): DeviceReport {
  return { ...BASE, ...partial };
}

const HEALTHY = report({
  ble: { readings: [{ nodeId: "tx-1", rssi: -55 }] },
  wifi: { connectedToSoshin: true, soshinRssi: -50 },
  ultrasonic: { received: true, valid: true, code: "123456", snr: 9 },
});

test("all three channels healthy → link connected", () => {
  const s = summarizeLink(HEALTHY, { ultrasonicValid: true });
  expect(s.state).toBe("connected");
  expect(s.quality).toBeGreaterThan(0.5);
  expect(s.modalities.map((m) => m.modality)).toEqual([
    "ble",
    "wifi",
    "ultrasonic",
  ]);
});

test("link quality is only as strong as its weakest channel", () => {
  const s = summarizeLink(
    report({
      ble: { readings: [{ nodeId: "tx-1", rssi: -55 }] },
      wifi: { connectedToSoshin: false, soshinRssi: null },
      ultrasonic: { received: true, valid: true, code: "123456", snr: 9 },
    }),
    { ultrasonicValid: true },
  );
  const wifi = s.modalities.find((m) => m.modality === "wifi")!;
  expect(wifi.state).toBe("lost");
  // overall is flagged degraded (wifi down, others up) and floored by wifi
  expect(s.state).toBe("degraded");
  expect(s.quality).toBe(0);
});

test("all channels down → link lost", () => {
  const s = summarizeLink(
    report({
      ble: { readings: [] },
      wifi: { connectedToSoshin: false, soshinRssi: null },
      ultrasonic: { received: false, valid: null, code: null, missReason: "no_signal" },
    }),
  );
  expect(s.state).toBe("lost");
  expect(s.quality).toBe(0);
});

test("weak BLE is degraded, not lost", () => {
  const s = summarizeLink(
    report({
      ble: { readings: [{ nodeId: "tx-1", rssi: -80 }] },
      wifi: { connectedToSoshin: true, soshinRssi: -55 },
      ultrasonic: { received: true, valid: true, code: "123456", snr: 9 },
    }),
    { ultrasonicValid: true },
  );
  const ble = s.modalities.find((m) => m.modality === "ble")!;
  expect(ble.state).toBe("degraded");
  expect(ble.quality).toBeGreaterThan(0);
  expect(ble.quality).toBeLessThan(0.5);
  expect(s.state).toBe("degraded");
});

test("BLE uses the strongest node reading", () => {
  const s = summarizeLink(
    report({
      ble: {
        readings: [
          { nodeId: "far", rssi: -95 },
          { nodeId: "tx-1", rssi: -60 },
        ],
      },
    }),
  );
  const ble = s.modalities.find((m) => m.modality === "ble")!;
  expect(ble.rssi).toBe(-60);
  expect(ble.state).toBe("connected");
});

test("a missed ultrasonic window surfaces its reason", () => {
  const s = summarizeLink(
    report({
      ultrasonic: {
        received: false,
        valid: null,
        code: null,
        missReason: "service_killed",
      },
    }),
  );
  const u = s.modalities.find((m) => m.modality === "ultrasonic")!;
  expect(u.state).toBe("lost");
  expect(u.detail).toContain("service_killed");
});

test("server can overrule the client's ultrasonic validity", () => {
  const s = summarizeLink(HEALTHY, { ultrasonicValid: false });
  const u = s.modalities.find((m) => m.modality === "ultrasonic")!;
  expect(u.state).toBe("degraded");
  expect(u.detail.toLowerCase()).toContain("rejected");
});

test("a joined WiFi link never reads lost, even when very weak", () => {
  const s = summarizeLink(
    report({
      wifi: { connectedToSoshin: true, soshinRssi: -100 },
    }),
  );
  const wifi = s.modalities.find((m) => m.modality === "wifi")!;
  expect(wifi.state).toBe("degraded");
  expect(wifi.received).toBe(true);
});

test("missing channels do not count against the link", () => {
  const s = summarizeLink(
    report({ ble: { readings: [{ nodeId: "tx-1", rssi: -55 }] } }),
  );
  expect(s.modalities.map((m) => m.modality)).toEqual(["ble"]);
  expect(s.state).toBe("connected");
});

test("identity is carried through for the monitor view", () => {
  const s = summarizeLink(HEALTHY, { ultrasonicValid: true });
  expect(s.deviceId).toBe("phone-1");
  expect(s.mode).toBe("jushin");
  expect(s.at).toBe(1_700_000_000_000);
});

test("raw readings are kept for the console", () => {
  const s = summarizeLink(HEALTHY, { ultrasonicValid: true });
  expect(s.modalities.find((m) => m.modality === "ble")!.rssi).toBe(-55);
  expect(s.modalities.find((m) => m.modality === "wifi")!.rssi).toBe(-50);
  expect(s.modalities.find((m) => m.modality === "ultrasonic")!.snr).toBe(9);
});
