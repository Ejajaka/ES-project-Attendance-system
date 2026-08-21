import { test, expect } from "vitest";
import type { DeviceReport, GroundTruth } from "shared";
import { MemoryStore } from "./store";

function report(deviceId: string, ts: number): DeviceReport {
  return {
    deviceId,
    mode: "jushin",
    roomId: "r1",
    sessionId: "s1",
    timestamp: ts,
  };
}

test("addReport + reportsForSession round-trips by session", () => {
  const s = new MemoryStore();
  s.addReport(report("d1", 1));
  s.addReport(report("d2", 2));
  expect(s.reportsForSession("s1")).toHaveLength(2);
  expect(s.reportsForSession("other")).toHaveLength(0);
});

test("latestPerDevice keeps the most recent report per device", () => {
  const s = new MemoryStore();
  s.addReport(report("d1", 100));
  s.addReport(report("d1", 300)); // newer
  s.addReport(report("d2", 200));
  const latest = s.latestPerDevice("s1");
  expect(latest.get("d1")?.timestamp).toBe(300);
  expect(latest.get("d2")?.timestamp).toBe(200);
  expect(latest.size).toBe(2);
});

test("ground truth is stored and retrievable per session", () => {
  const s = new MemoryStore();
  const gt: GroundTruth = {
    sessionId: "s1",
    roomId: "r1",
    headcount: 12,
    timestamp: 1_700_000_000,
  };
  s.addGroundTruth(gt);
  expect(s.groundTruthForSession("s1")).toEqual([gt]);
});
