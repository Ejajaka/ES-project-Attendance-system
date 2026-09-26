import { z } from "zod";

/**
 * Attendance model (see CONTEXT.md).
 *
 * Presence is continuous: each device reports every few seconds and the server
 * keeps a per-device timeline. Attendance is the roster × timeline verdict —
 * "was person P in room R, and for how long" — not a single checkpoint.
 */

/** A student expected in the room (the class roster). */
export const StudentSchema = z.object({
  /** Roll number / unique id entered once per student. */
  studentId: z.string().min(1),
  name: z.string().min(1),
  /** Optional stable phone id; when set, the phone is matched by id, else by studentId. */
  deviceId: z.string().optional(),
});
export type Student = z.infer<typeof StudentSchema>;

/** Replace a session's roster. */
export const RosterSchema = z.object({
  students: z.array(StudentSchema),
});
export type Roster = z.infer<typeof RosterSchema>;

/** One device's observed timeline within a session. */
export interface DeviceTimeline {
  deviceId: string;
  /** Identity the device reported, if any. */
  studentId?: string;
  firstSeen: number;
  lastSeen: number;
  /** Accumulated milliseconds the device was present (capped gaps). */
  presentMs: number;
  samples: number;
  /** Present per the most recent sample. */
  present: boolean;
}

/**
 * Cap a single inter-sample gap so a device that disappears and reappears much
 * later isn't credited with the whole absence as "present".
 */
export const ATTENDANCE_MAX_GAP_MS = 60_000;

/** One row of the attendance sheet. */
export interface AttendanceRow {
  studentId: string;
  name: string;
  deviceId: string | null;
  present: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
  presentMs: number;
  /** presentMs / observed span, 0..1 (1 when a single present sample). */
  coverage: number;
}

export interface AttendanceSheet {
  sessionId: string;
  generatedAt: number;
  rows: AttendanceRow[];
  presentCount: number;
  rosterCount: number;
  /** Devices seen in the room that are not on the roster. */
  unrostered: DeviceTimeline[];
}

/** Fraction of the observed window during which the device was present. */
function coverageOf(t: DeviceTimeline): number {
  const span = t.lastSeen - t.firstSeen;
  if (span <= 0) return t.present ? 1 : 0;
  return Math.max(0, Math.min(1, t.presentMs / span));
}

/**
 * Build the attendance sheet by matching each roster entry to a device timeline.
 * Matching prefers `deviceId` (explicit binding), then the device's reported
 * `studentId`. Timelines that match nobody are returned as `unrostered`.
 */
export function buildAttendance(input: {
  sessionId: string;
  generatedAt: number;
  students: Student[];
  timelines: DeviceTimeline[];
}): AttendanceSheet {
  const { sessionId, generatedAt, students, timelines } = input;
  const used = new Set<string>();

  const rows: AttendanceRow[] = students.map((s) => {
    let t: DeviceTimeline | undefined;
    if (s.deviceId) {
      t = timelines.find((x) => x.deviceId === s.deviceId);
    }
    if (!t) {
      t = timelines.find((x) => x.studentId === s.studentId);
    }
    if (t) used.add(t.deviceId);

    return {
      studentId: s.studentId,
      name: s.name,
      deviceId: t?.deviceId ?? s.deviceId ?? null,
      present: t?.present ?? false,
      firstSeen: t?.firstSeen ?? null,
      lastSeen: t?.lastSeen ?? null,
      presentMs: t?.presentMs ?? 0,
      coverage: t ? coverageOf(t) : 0,
    };
  });

  const unrostered = timelines.filter((t) => !used.has(t.deviceId));

  return {
    sessionId,
    generatedAt,
    rows,
    presentCount: rows.filter((r) => r.present).length,
    rosterCount: students.length,
    unrostered,
  };
}

function csvCell(v: string | number | boolean | null): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC-4180 CSV of the sheet — for taking the register out of the system. */
export function attendanceToCsv(sheet: AttendanceSheet): string {
  const header = [
    "studentId",
    "name",
    "present",
    "deviceId",
    "firstSeen",
    "lastSeen",
    "presentMs",
    "coverage",
  ];
  const lines = [header.join(",")];
  for (const r of sheet.rows) {
    lines.push(
      [
        r.studentId,
        r.name,
        r.present ? "present" : "absent",
        r.deviceId ?? "",
        r.firstSeen ?? "",
        r.lastSeen ?? "",
        Math.round(r.presentMs),
        r.coverage.toFixed(2),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
