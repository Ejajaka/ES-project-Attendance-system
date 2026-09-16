import { test, expect } from "vitest";
import { simulateReceiverReport } from "./simulator";
import { generateTOTP, verifyTOTP } from "./rollingCode";
import { DeviceReportSchema } from "./types";

/**
 * A simulated receiver is the single-phone counterpart of the real app: it
 * builds the exact report shape the app does (BLE reading of the transmitter,
 * joined WiFi, rolling code over BLE), so the server pipeline and the
 * transmitter's room monitor can be exercised without a second phone.
 */

const SECRET = new TextEncoder().encode("shusseki-preset-1-secret");
const NOW = 1_700_000_000_000;

const input = {
  deviceId: "sim-rx-1",
  roomId: "room-1",
  sessionId: "sess-1",
  now: NOW,
  secret: SECRET,
  transmitter: {
    nodeId: "phone-tx",
    ssid: "AndroidShare_1234",
    rssi: -55,
  },
};

test("simulated report matches the device report schema", () => {
  const report = simulateReceiverReport(input);
  expect(() => DeviceReportSchema.parse(report)).not.toThrow();
});

test("simulated report carries a rolling code the server will verify", () => {
  const report = simulateReceiverReport(input);
  const code = report.ultrasonic?.code ?? "";
  expect(code).toMatch(/^\d{6}$/);
  expect(verifyTOTP(SECRET, code, NOW, { step: 30 })).toMatchObject({
    valid: true,
  });
});

test("simulated report observes the transmitter over all three channels", () => {
  const report = simulateReceiverReport(input);
  expect(report.mode).toBe("jushin");
  expect(report.ble?.readings[0]).toMatchObject({ nodeId: "phone-tx", rssi: -55, code: report.ultrasonic?.code });
  expect(report.wifi).toMatchObject({
    ssid: "AndroidShare_1234",
    connectedToSoshin: true,
    soshinRssi: -55,
  });
  expect(report.ultrasonic).toMatchObject({ received: true, valid: true });
});

test("missing transmitter degrades the simulated link honestly", () => {
  const report = simulateReceiverReport({ ...input, transmitter: null });
  expect(report.ble?.readings).toEqual([]);
  expect(report.wifi).toMatchObject({ connectedToSoshin: false, soshinRssi: null });
  expect(report.ultrasonic).toMatchObject({ received: false, valid: null, code: null });
});
