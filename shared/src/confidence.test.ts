import { test, expect } from "bun:test";
import {
  bleConfidence,
  wifiConfidence,
  ultrasonicConfidence,
} from "./confidence";

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

test("bleConfidence rises with RSSI (monotonic)", () => {
  const weak = bleConfidence({ readings: [{ nodeId: "n1", rssi: -85 }] });
  const strong = bleConfidence({ readings: [{ nodeId: "n1", rssi: -50 }] });
  expect(strong).toBeGreaterThan(weak);
});

test("bleConfidence is 0.5 at the threshold RSSI", () => {
  const c = bleConfidence({ readings: [{ nodeId: "n1", rssi: -70 }] });
  expect(c).toBeCloseTo(0.5, 5);
});

test("bleConfidence with 'max' rule takes the strongest node", () => {
  const readings = [
    { nodeId: "far", rssi: -88 },
    { nodeId: "near", rssi: -50 },
    { nodeId: "mid", rssi: -65 },
  ];
  const combined = bleConfidence({ readings, rule: "max" });
  const bestAlone = bleConfidence({ readings: [{ nodeId: "near", rssi: -50 }] });
  expect(combined).toBeCloseTo(bestAlone, 5);
});

test("bleConfidence 'avg' rule is dampened by weak nodes", () => {
  const readings = [
    { nodeId: "near", rssi: -50 },
    { nodeId: "far", rssi: -88 },
  ];
  const avg = bleConfidence({ readings, rule: "avg" });
  const best = bleConfidence({ readings: [{ nodeId: "near", rssi: -50 }] });
  expect(avg).toBeLessThan(best);
  expect(avg).toBeGreaterThan(0);
});

test("bleConfidence is low when no nodes are in range", () => {
  const c = bleConfidence({ readings: [{ nodeId: "n1", rssi: -95 }] });
  expect(c).toBeLessThan(0.2);
});

test("wifiConfidence is high when connected to the Soshin AP", () => {
  const c = wifiConfidence({ connectedToSoshin: true, soshinRssi: -50 });
  expect(c).toBeGreaterThan(0.9);
});

test("wifiConfidence is partial when the AP is heard but not connected", () => {
  const c = wifiConfidence({ connectedToSoshin: false, soshinRssi: -50 });
  expect(c).toBeGreaterThan(0.4);
  expect(c).toBeLessThan(0.9);
});

test("wifiConfidence is near-zero when the AP is out of range", () => {
  const c = wifiConfidence({ connectedToSoshin: false, soshinRssi: null });
  expect(c).toBeLessThan(0.1);
});

test("ultrasonicConfidence is high for a valid rolling code", () => {
  expect(
    ultrasonicConfidence({ received: true, valid: true }),
  ).toBeGreaterThan(0.9);
});

test("ultrasonicConfidence is low when nothing was received", () => {
  expect(
    ultrasonicConfidence({ received: false, valid: null }),
  ).toBeLessThan(0.1);
});

test("ultrasonicConfidence is modest when a tone was heard but undecodable", () => {
  const c = ultrasonicConfidence({ received: true, valid: null });
  expect(c).toBeGreaterThan(0.2);
  expect(c).toBeLessThan(0.6);
});

test("ultrasonicConfidence is low when a tone was heard but invalid", () => {
  const c = ultrasonicConfidence({ received: true, valid: false });
  expect(c).toBeLessThan(0.2);
});
