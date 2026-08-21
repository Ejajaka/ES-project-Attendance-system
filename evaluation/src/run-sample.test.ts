import { test, expect } from "vitest";
import { buildSampleScenario, runComparison } from "./run-sample";

test("the sample scenario shows fusion beating every single modality", () => {
  const c = runComparison(buildSampleScenario());

  // Fused catches the ultrasonic-only and fused-BLE+WiFi people
  expect(c.metrics.fused.recall).toBeGreaterThan(c.metrics.ble.recall);
  expect(c.metrics.fused.recall).toBeGreaterThan(c.metrics.wifi.recall);
  expect(c.metrics.fused.recall).toBeGreaterThan(c.metrics.ultrasonic.recall);
});

test("fusion perfect-recall scenario yields zero room-level count error", () => {
  const c = runComparison(buildSampleScenario());
  expect(c.predictedPresent).toBe(4);
  expect(c.headcount).toBe(4);
  expect(c.countError).toBe(0);
});

test("single modalities miss at least one present person", () => {
  const c = runComparison(buildSampleScenario());
  // ultrasonic-only person is missed by BLE and WiFi
  expect(c.metrics.ble.recall).toBeLessThan(1);
  expect(c.metrics.wifi.recall).toBeLessThan(1);
});
