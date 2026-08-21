import { test, expect } from "vitest";
import { parseDeviceReport, DeviceReportSchema } from "./types";

const validJushinReport = {
  deviceId: "dev-abc",
  mode: "jushin",
  roomId: "room-1",
  sessionId: "sess-1",
  timestamp: 1_700_000_000,
  ble: {
    readings: [
      { nodeId: "soshin", rssi: -55 },
      { nodeId: "node-b", rssi: -72 },
    ],
  },
  wifi: { connectedToSoshin: true, soshinRssi: -48, ssid: "Shusseki-1" },
  ultrasonic: { received: true, valid: true, code: "123456" },
  biometric: { performedAt: 1_700_000_000, kind: "fingerprint", success: true },
};

test("parseDeviceReport accepts a well-formed Jushin report", () => {
  const r = parseDeviceReport(validJushinReport);
  expect(r.mode).toBe("jushin");
  expect(r.ble?.readings.length).toBe(2);
});

test("parseDeviceReport rejects an unknown mode", () => {
  expect(() =>
    parseDeviceReport({ ...validJushinReport, mode: "observer" }),
  ).toThrow();
});

test("parseDeviceReport rejects a negative RSSI-of-wrong-type", () => {
  const bad = {
    ...validJushinReport,
    wifi: { connectedToSoshin: true, soshinRssi: "strong" },
  };
  expect(() => DeviceReportSchema.parse(bad)).toThrow();
});

test("parseDeviceReport accepts a Soshin report without biometric", () => {
  const soshinReport = {
    deviceId: "dev-soshin",
    mode: "soshin",
    roomId: "room-1",
    sessionId: "sess-1",
    timestamp: 1_700_000_000,
    ble: { readings: [{ nodeId: "self", rssi: -40 }] },
  };
  const r = parseDeviceReport(soshinReport);
  expect(r.mode).toBe("soshin");
  expect(r.biometric).toBeUndefined();
});
