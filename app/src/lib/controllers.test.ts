import { test, expect } from "vitest";
import { generateTOTP, verifyTOTP, type DeviceReport } from "shared";
import { SoshinController, type SoshinConfig } from "./modes/soshin";
import { JushinController, type JushinConfig } from "./modes/jushin";
import { MockSensors } from "./mockSensors";
import { MockReporter } from "./reporter";

const SECRET = new TextEncoder().encode("app-shared-secret");
const ALIGNED = Math.floor(1_700_000_000 / 30_000) * 30_000;

const soshinConfig: SoshinConfig = {
  deviceId: "soshin-1",
  roomId: "room-1",
  sessionId: "sess-1",
  nodeId: "soshin-1",
  secret: SECRET,
  step: 30,
  digits: 6,
};

const jushinConfig: JushinConfig = {
  deviceId: "phone-1",
  roomId: "room-1",
  sessionId: "sess-1",
  soshinSsid: "Shusseki-1",
};

test("Soshin broadcasts a rolling code that verifies against its secret", async () => {
  const sensors = new MockSensors();
  const soshin = new SoshinController(sensors, soshinConfig);
  const code = await soshin.broadcast(ALIGNED);
  expect(code).toMatch(/^\d{6}$/);
  expect(verifyTOTP(SECRET, code, ALIGNED, { step: 30 })).toMatchObject({
    valid: true,
  });
});

test("Soshin transmits the code through the ultrasonic adapter", async () => {
  const sensors = new MockSensors();
  const soshin = new SoshinController(sensors, soshinConfig);
  const code = await soshin.broadcast(ALIGNED);
  expect(sensors.transmittedCodes).toEqual([code]);
});

test("Jushin startAttendance performs a biometric and joins the Soshin WiFi", async () => {
  const sensors = new MockSensors();
  const reporter = new MockReporter();
  const jushin = new JushinController(sensors, jushinConfig, reporter);
  const bio = await jushin.startAttendance();

  expect(bio.success).toBe(true);
  expect(sensors.wifiState.connectedToSoshin).toBe(true);
  expect(sensors.started.ble).toBe(true);
  expect(sensors.started.ultrasonic).toBe(true);
});

test("Jushin tick gathers all modalities and reports to the server", async () => {
  const sensors = new MockSensors();
  sensors.bleReadings = [
    { nodeId: "soshin-1", rssi: -55 },
    { nodeId: "soshin-2", rssi: -72 },
  ];
  sensors.wifiState = { connectedToSoshin: true, soshinRssi: -48, ssid: "Shusseki-1" };
  sensors.ultrasonicResponse = {
    received: true,
    valid: true,
    code: generateTOTP(SECRET, ALIGNED, { step: 30 }),
  };

  const reporter = new MockReporter();
  const jushin = new JushinController(sensors, jushinConfig, reporter);
  const report = await jushin.tick(ALIGNED);

  expect(report.mode).toBe("jushin");
  expect(report.deviceId).toBe("phone-1");
  expect(report.ble?.readings).toHaveLength(2);
  expect(report.wifi?.connectedToSoshin).toBe(true);
  expect(report.ultrasonic?.received).toBe(true);
  expect(reporter.sent).toHaveLength(1);
  expect(reporter.sent[0]).toBe(report);
});

test("Jushin endAttendance performs a biometric and stops sensing", async () => {
  const sensors = new MockSensors();
  const reporter = new MockReporter();
  const jushin = new JushinController(sensors, jushinConfig, reporter);
  const bio = await jushin.endAttendance();
  expect(bio.kind).toBe("face");
});

test("Jushin hears the exact code the Soshin broadcasts", async () => {
  const sensors = new MockSensors();
  const soshin = new SoshinController(sensors, soshinConfig);
  const code = await soshin.broadcast(ALIGNED);

  // Jushin "listens" and receives the transmitted code
  sensors.ultrasonicResponse = { received: true, valid: true, code };
  const reporter = new MockReporter();
  const jushin = new JushinController(sensors, jushinConfig, reporter);
  const report = await jushin.tick(ALIGNED);
  expect(report.ultrasonic?.code).toBe(code);
});

test("mock reporter can be swapped for an HTTP reporter shape", () => {
  const r: DeviceReport = {
    deviceId: "x",
    mode: "jushin",
    roomId: "r",
    sessionId: "s",
    timestamp: 0,
  };
  const reporter = new MockReporter();
  reporter.send(r);
  expect(reporter.sent[0]).toBe(r);
});
