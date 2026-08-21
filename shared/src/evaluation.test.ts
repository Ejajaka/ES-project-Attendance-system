import { test, expect } from "vitest";
import {
  confusion,
  classificationMetrics,
  roomCountError,
  evaluateInstances,
} from "./evaluation";

test("confusion tallies tp/fp/fn/tn", () => {
  const c = confusion(
    [true, false, true, false, true],
    [true, true, false, false, true],
  );
  expect(c).toEqual({ tp: 2, fp: 1, fn: 1, tn: 1 });
});

test("classificationMetrics computes precision/recall/f1/accuracy", () => {
  const m = classificationMetrics({ tp: 2, fp: 1, fn: 1, tn: 1 });
  expect(m.precision).toBeCloseTo(2 / 3, 6);
  expect(m.recall).toBeCloseTo(2 / 3, 6);
  expect(m.accuracy).toBeCloseTo(3 / 5, 6);
  expect(m.f1).toBeCloseTo(0.666666, 4);
});

test("classificationMetrics is 0 when there are no positives", () => {
  const m = classificationMetrics({ tp: 0, fp: 0, fn: 0, tn: 5 });
  expect(m.precision).toBe(0);
  expect(m.recall).toBe(0);
  expect(m.f1).toBe(0);
});

test("roomCountError is the absolute difference", () => {
  expect(roomCountError(11, 12)).toBe(1);
  expect(roomCountError(12, 12)).toBe(0);
});

test("evaluateInstances reports BLE/WiFi/Ultrasonic/Fused metrics", () => {
  // A: true, all strong.  B: false, all weak.
  // C: true, BLE+ultrasonic strong, WiFi weak.  D: false, BLE+ultrasonic strong.
  // E: true, all moderate (each < 0.5 alone, but fusion crosses threshold).
  const samples = [
    { confidences: { ble: 0.9, wifi: 0.9, ultrasonic: 0.9 }, actualPresent: true },
    { confidences: { ble: 0.1, wifi: 0.1, ultrasonic: 0.1 }, actualPresent: false },
    { confidences: { ble: 0.9, wifi: 0.1, ultrasonic: 0.9 }, actualPresent: true },
    { confidences: { ble: 0.9, wifi: 0.1, ultrasonic: 0.9 }, actualPresent: false },
    { confidences: { ble: 0.4, wifi: 0.4, ultrasonic: 0.4 }, actualPresent: true },
  ];

  const out = evaluateInstances(samples);

  // BLE + ultrasonic miss E (each moderate reading below threshold)
  expect(out.ble.recall).toBeCloseTo(2 / 3, 6);
  expect(out.ultrasonic.recall).toBeCloseTo(2 / 3, 6);
  expect(out.ble.precision).toBeCloseTo(2 / 3, 6);

  // WiFi only catches A
  expect(out.wifi.recall).toBeCloseTo(1 / 3, 6);
  expect(out.wifi.precision).toBe(1);

  // Fused catches A, C, and E (the one no single modality catches) => recall 1
  expect(out.fused.recall).toBe(1);
  expect(out.fused.precision).toBeCloseTo(0.75, 6);
  expect(out.fused.tp).toBe(3);
  expect(out.fused.fp).toBe(1);
});

test("evaluateInstances treats a missing modality as 'not detected'", () => {
  const samples = [
    { confidences: { wifi: 0.9 }, actualPresent: true }, // no BLE reading
  ];
  const out = evaluateInstances(samples);
  // BLE had no reading => predicted absent => false negative
  expect(out.ble.fn).toBe(1);
  expect(out.ble.recall).toBe(0);
  // WiFi present and strong => true positive
  expect(out.wifi.tp).toBe(1);
});
