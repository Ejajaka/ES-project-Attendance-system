import { test, expect } from "vitest";
import {
  generateTOTP,
  type DeviceReport,
  type Modality,
} from "shared";
import { computeDevicePresence, type SessionConfig } from "./presence";

const SECRET = new TextEncoder().encode("session-shared-secret");
const STEP_MS = 30 * 1000;
const ALIGNED = Math.floor(1_700_000_000 / STEP_MS) * STEP_MS;

const baseConfig: SessionConfig = {
  sessionId: "s1",
  roomId: "r1",
  rollingSecret: SECRET,
  step: 30,
  digits: 6,
  window: 1,
  threshold: 0.5,
};

function jushinReport(overrides: Partial<DeviceReport> = {}): DeviceReport {
  return {
    deviceId: "d1",
    mode: "jushin",
    roomId: "r1",
    sessionId: "s1",
    timestamp: ALIGNED,
    ble: { readings: [{ nodeId: "soshin", rssi: -55 }, { nodeId: "b", rssi: -70 }] },
    wifi: { connectedToSoshin: true, soshinRssi: -50 },
    ultrasonic: {
      received: true,
      valid: true,
      code: generateTOTP(SECRET, ALIGNED, { step: 30 }),
    },
    ...overrides,
  };
}

test("computeDevicePresence marks a strong triple-signal device present", () => {
  const p = computeDevicePresence(jushinReport(), baseConfig);
  expect(p.confidences.ble!).toBeGreaterThan(0.7);
  expect(p.confidences.wifi!).toBeGreaterThan(0.9);
  expect(p.confidences.ultrasonic!).toBeGreaterThan(0.9);
  expect(p.fused).toBeGreaterThan(0.9);
  expect(p.present).toBe(true);
  expect(p.ultrasonicServerValid).toBe(true);
});

test("server re-verifies the ultrasonic code and rejects a tampered one", () => {
  const tampered = jushinReport({
    ultrasonic: { received: true, valid: true, code: "000000" },
  });
  const p = computeDevicePresence(tampered, baseConfig);
  // server is the authority: the bogus code fails verification
  expect(p.ultrasonicServerValid).toBe(false);
  expect(p.confidences.ultrasonic!).toBeLessThan(0.2);
});

test("a tampered ultrasonic code does not hide presence when BLE+WiFi agree", () => {
  const tampered = jushinReport({
    ultrasonic: { received: true, valid: true, code: "000000" },
  });
  const p = computeDevicePresence(tampered, baseConfig);
  // BLE + WiFi still indicate presence
  expect(p.present).toBe(true);
});

test("missing ultrasonic observation still yields BLE/WiFi confidence + fused", () => {
  const p = computeDevicePresence(
    jushinReport({ ultrasonic: undefined }),
    baseConfig,
  );
  expect(p.confidences.ultrasonic).toBeUndefined();
  expect(p.confidences.ble).toBeDefined();
  expect(p.confidences.wifi).toBeDefined();
  expect(p.fused).toBeGreaterThan(0.5);
});

test("weak signals across all modalities => not present", () => {
  const weak = jushinReport({
    ble: { readings: [{ nodeId: "soshin", rssi: -92 }] },
    wifi: { connectedToSoshin: false, soshinRssi: null },
    ultrasonic: { received: false, valid: null, code: null },
  });
  const p = computeDevicePresence(weak, baseConfig);
  expect(p.fused).toBeLessThan(0.5);
  expect(p.present).toBe(false);
});

test("confidences object only contains modalities that were reported", () => {
  const p = computeDevicePresence(jushinReport({ wifi: undefined }), baseConfig);
  expect(p.confidences.wifi).toBeUndefined();
  expect(p.confidences.ble).toBeDefined();
  expect(p.confidences.ultrasonic).toBeDefined();
  // fusion ignores the missing modality
  const keys = Object.keys(p.confidences) as Modality[];
  expect(keys).toEqual(expect.arrayContaining(["ble", "ultrasonic"]));
  expect(keys).not.toContain("wifi");
});
