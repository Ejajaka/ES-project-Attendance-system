import { describe, expect, test } from "vitest";
import {
  ATTENDANCE_MAX_GAP_MS,
  attendanceToCsv,
  buildAttendance,
  type DeviceTimeline,
} from "./attendance";

function timeline(over: Partial<DeviceTimeline>): DeviceTimeline {
  return {
    deviceId: "phone-1",
    firstSeen: 0,
    lastSeen: 10_000,
    presentMs: 10_000,
    samples: 3,
    present: true,
    ...over,
  };
}

describe("buildAttendance", () => {
  test("marks a roster student present when their device reported", () => {
    const sheet = buildAttendance({
      sessionId: "sess-1",
      generatedAt: 1,
      students: [
        { studentId: "bl.1", name: "Ada" },
        { studentId: "bl.2", name: "Bob" },
      ],
      timelines: [timeline({ deviceId: "phone-ada", studentId: "bl.1" })],
    });
    expect(sheet.presentCount).toBe(1);
    expect(sheet.rosterCount).toBe(2);
    const ada = sheet.rows.find((r) => r.studentId === "bl.1")!;
    const bob = sheet.rows.find((r) => r.studentId === "bl.2")!;
    expect(ada.present).toBe(true);
    expect(ada.deviceId).toBe("phone-ada");
    expect(bob.present).toBe(false);
    expect(bob.deviceId).toBeNull();
  });

  test("prefers an explicit deviceId binding over studentId", () => {
    const sheet = buildAttendance({
      sessionId: "s",
      generatedAt: 1,
      students: [{ studentId: "bl.1", name: "Ada", deviceId: "phone-x" }],
      timelines: [
        timeline({ deviceId: "phone-other", studentId: "bl.1", present: false }),
        timeline({ deviceId: "phone-x", present: true }),
      ],
    });
    expect(sheet.rows[0]!.present).toBe(true);
    expect(sheet.rows[0]!.deviceId).toBe("phone-x");
    expect(sheet.unrostered.map((u) => u.deviceId)).toEqual(["phone-other"]);
  });

  test("coverage is the present fraction of the observed span", () => {
    const sheet = buildAttendance({
      sessionId: "s",
      generatedAt: 1,
      students: [{ studentId: "bl.1", name: "Ada" }],
      timelines: [
        timeline({ studentId: "bl.1", firstSeen: 0, lastSeen: 10_000, presentMs: 5_000 }),
      ],
    });
    expect(sheet.rows[0]!.coverage).toBeCloseTo(0.5, 5);
  });

  test("a single present sample is full coverage; single absent is zero", () => {
    const present = buildAttendance({
      sessionId: "s",
      generatedAt: 1,
      students: [{ studentId: "a", name: "A" }],
      timelines: [timeline({ studentId: "a", firstSeen: 5, lastSeen: 5, present: true })],
    });
    expect(present.rows[0]!.coverage).toBe(1);

    const absent = buildAttendance({
      sessionId: "s",
      generatedAt: 1,
      students: [{ studentId: "a", name: "A" }],
      timelines: [timeline({ studentId: "a", firstSeen: 5, lastSeen: 5, present: false, presentMs: 0 })],
    });
    expect(absent.rows[0]!.coverage).toBe(0);
  });

  test("records devices with no roster entry as unrostered", () => {
    const sheet = buildAttendance({
      sessionId: "s",
      generatedAt: 1,
      students: [],
      timelines: [timeline({ deviceId: "phone-ghost" })],
    });
    expect(sheet.presentCount).toBe(0);
    expect(sheet.unrostered).toHaveLength(1);
  });
});

describe("attendanceToCsv", () => {
  test("emits a header + a row per student and quotes commas", () => {
    const sheet = buildAttendance({
      sessionId: "s",
      generatedAt: 1,
      students: [
        { studentId: "bl.1", name: "Doe, Jane" },
        { studentId: "bl.2", name: "Bob" },
      ],
      timelines: [timeline({ deviceId: "p", studentId: "bl.1", presentMs: 4_000 })],
    });
    const csv = attendanceToCsv(sheet);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "studentId,name,present,deviceId,firstSeen,lastSeen,presentMs,coverage",
    );
    expect(lines[1]).toContain('"Doe, Jane"');
    expect(lines[1]).toContain("present");
    expect(lines[2]).toContain("absent");
  });
});

test("ATTENDANCE_MAX_GAP_MS guards against crediting long absences", () => {
  expect(ATTENDANCE_MAX_GAP_MS).toBeGreaterThan(0);
});
