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

  test("on a tie, an explicit deviceId binding wins", () => {
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
    // Both timelines belong to Ada, so neither is a stranger.
    expect(sheet.unrostered).toHaveLength(0);
  });

  test("a swapped phone (new deviceId, same studentId) follows the student", () => {
    const sheet = buildAttendance({
      sessionId: "s",
      generatedAt: 1,
      students: [{ studentId: "bl.1", name: "Ada", deviceId: "phone-old" }],
      timelines: [
        timeline({ deviceId: "phone-old", lastSeen: 1_000, present: false }),
        timeline({
          deviceId: "phone-new",
          studentId: "bl.1",
          lastSeen: 9_000,
          present: true,
        }),
      ],
    });
    expect(sheet.rows[0]!.present).toBe(true);
    expect(sheet.rows[0]!.deviceId).toBe("phone-new");
    expect(sheet.unrostered).toHaveLength(0);
  });

  test("trims studentIds when matching", () => {
    const sheet = buildAttendance({
      sessionId: "s",
      generatedAt: 1,
      students: [{ studentId: "bl.1 ", name: "Ada" }],
      timelines: [timeline({ deviceId: "p", studentId: "bl.1" })],
    });
    expect(sheet.rows[0]!.present).toBe(true);
    expect(sheet.unrostered).toHaveLength(0);
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

  test("a stale device binding cannot claim a re-enrolled student", () => {
    const sheet = buildAttendance({
      sessionId: "s",
      generatedAt: 1,
      students: [
        { studentId: "bl.old", name: "Old", deviceId: "phone-1" },
        { studentId: "bl.new", name: "New" },
      ],
      timelines: [
        timeline({
          deviceId: "phone-1",
          studentId: "bl.new",
          present: true,
        }),
      ],
    });
    const oldRow = sheet.rows.find((r) => r.studentId === "bl.old")!;
    const newRow = sheet.rows.find((r) => r.studentId === "bl.new")!;
    expect(oldRow.present).toBe(false);
    expect(newRow.present).toBe(true);
    expect(sheet.presentCount).toBe(1);
  });

  test("attendance is sticky: once present, leaving does not un-mark it", () => {
    const sheet = buildAttendance({
      sessionId: "s",
      generatedAt: 100_000,
      ttlMs: 30_000,
      students: [{ studentId: "bl.1", name: "Ada" }],
      timelines: [
        timeline({
          deviceId: "p",
          studentId: "bl.1",
          present: false,
          presentMs: 5_000,
          everPresent: true,
          lastSeen: 10_000,
        }),
      ],
    });
    expect(sheet.rows[0]!.present).toBe(true);
    expect(sheet.presentCount).toBe(1);
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

  test("hides unrostered devices that are no longer being seen", () => {
    const sheet = buildAttendance({
      sessionId: "s",
      generatedAt: 100_000,
      ttlMs: 30_000,
      students: [],
      timelines: [
        timeline({ deviceId: "recent", lastSeen: 90_000 }),
        timeline({ deviceId: "gone", lastSeen: 10_000 }),
      ],
    });
    expect(sheet.unrostered.map((u) => u.deviceId)).toEqual(["recent"]);
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
