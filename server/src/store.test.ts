import { test, expect } from "vitest";
import { ATTENDANCE_MAX_GAP_MS, type DeviceReport, type GroundTruth } from "shared";
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

test("recordSample tracks first/last seen and credits present gaps", () => {
  const s = new MemoryStore();
  s.recordSample("s1", "d1", "bl.1", 1000, true);
  s.recordSample("s1", "d1", "bl.1", 6000, true);
  s.recordSample("s1", "d1", "bl.1", 11000, false);
  const [t] = s.timelinesForSession("s1");
  expect(t!.firstSeen).toBe(1000);
  expect(t!.lastSeen).toBe(11000);
  expect(t!.presentMs).toBe(5000); // only the present→present gap
  expect(t!.samples).toBe(3);
  expect(t!.present).toBe(false);
  expect(t!.studentId).toBe("bl.1");
});

test("recordSample caps a long gap so an absence is not credited as present", () => {
  const s = new MemoryStore();
  s.recordSample("s1", "d1", undefined, 0, true);
  s.recordSample("s1", "d1", undefined, ATTENDANCE_MAX_GAP_MS + 1, true);
  expect(s.timelinesForSession("s1")[0]!.presentMs).toBe(0);
});

test("recordSample latches everPresent once the device is present", () => {
  const s = new MemoryStore();
  s.recordSample("s1", "d1", undefined, 0, true);
  s.recordSample("s1", "d1", undefined, 5_000, false);
  const t = s.timelinesForSession("s1")[0]!;
  expect(t.present).toBe(false);
  expect(t.everPresent).toBe(true);
});

test("roster is stored and retrievable per session", () => {
  const s = new MemoryStore();
  expect(s.rosterForSession("s1")).toEqual([]);
  s.setRoster("s1", [{ studentId: "bl.1", name: "Ada" }]);
  expect(s.rosterForSession("s1")).toHaveLength(1);
  expect(s.rosterForSession("other")).toHaveLength(0);
});

test("ensureStudent refreshes the device binding without duplicating", () => {
  const s = new MemoryStore();
  s.ensureStudent("s1", { studentId: "bl.1", name: "Ada", deviceId: "phone-old" });
  s.ensureStudent("s1", { studentId: "bl.1", name: "Ada", deviceId: "phone-new" });
  const roster = s.rosterForSession("s1");
  expect(roster).toHaveLength(1);
  expect(roster[0]!.deviceId).toBe("phone-new");
  expect(roster[0]!.studentId).toBe("bl.1");
});

test("ensureStudent trims the roll and ignores an empty id", () => {
  const s = new MemoryStore();
  s.ensureStudent("s1", { studentId: " bl.1 ", name: "Ada" });
  s.ensureStudent("s1", { studentId: "  ", name: "Ghost" });
  expect(s.rosterForSession("s1")).toEqual([{ studentId: "bl.1", name: "Ada" }]);
});
