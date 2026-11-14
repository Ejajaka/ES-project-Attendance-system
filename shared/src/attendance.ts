import { z } from "zod";

/**
 * Attendance model.
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
  /** Optional RFID card UID entered by the student on the phone. */
  rfidUid: z.string().optional(),
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
  /**
   * True once this device has ever been present in the session. The register
   * latches on this: attendance is marked once and does not un-mark when the
   * student walks out (cleared only by an explicit attendance reset).
   */
  everPresent?: boolean;
}

/**
 * Cap a single inter-sample gap so a device that disappears and reappears much
 * later isn't credited with the whole absence as "present".
 */
export const ATTENDANCE_MAX_GAP_MS = 60_000;

/**
 * A point-in-time manual mark (RFID card tap, teacher override). Unlike a
 * report timeline it does not expire with the report TTL: once marked, the
 * student stays present until an explicit attendance reset.
 */
export interface AttendanceMark {
  studentId: string;
  /** When the mark happened (ms epoch). */
  at: number;
  /** RFID card UID (or other source id), for auditability. */
  uid?: string;
  /** Name supplied by the mark source (never replaces a non-empty roster name). */
  name?: string;
}

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
 * A timeline matches by its reported `studentId` (trimmed) or the roster's
 * explicit `deviceId` binding. When a student has several matching timelines
 * (e.g. a reinstalled/swapped phone), the freshest one supplies the row and
 * none of them are reported as unrostered. Timelines that match nobody are
 * returned as `unrostered`.
 */
export function buildAttendance(input: {
  sessionId: string;
  generatedAt: number;
  students: Student[];
  timelines: DeviceTimeline[];
  /** Manual/RFID marks that never expire with the report TTL. */
  marks?: AttendanceMark[];
  /** When set, a timeline older than this is treated as absent (stale). */
  ttlMs?: number;
}): AttendanceSheet {
  const { sessionId, generatedAt, students, timelines, ttlMs } = input;
  const used = new Set<string>();
  const norm = (v?: string) => (v ?? "").trim();
  const markByStudent = new Map<string, AttendanceMark>();
  for (const m of input.marks ?? []) {
    const sid = norm(m.studentId);
    if (sid) markByStudent.set(sid, m);
  }

  const rows: AttendanceRow[] = students.map((s) => {
    const sid = norm(s.studentId);
    const mark = markByStudent.get(sid);
    const candidates = timelines.filter((x) => {
      const byStudent = sid !== "" && norm(x.studentId) === sid;
      if (byStudent) return true;
      if (s.deviceId == null || x.deviceId !== s.deviceId) return false;
      // A device can stand in for a student only when it reports that student
      // (or reports no identity at all). A stale binding must not claim the
      // same phone for a different roll after a re-enrolment.
      return norm(x.studentId) === "" || norm(x.studentId) === sid;
    });
    const t = candidates.length
      ? candidates.reduce((best, x) => {
          if (x.lastSeen > best.lastSeen) return x;
          // On a tie, an explicit deviceId binding wins.
          if (x.lastSeen === best.lastSeen && s.deviceId && x.deviceId === s.deviceId) {
            return x;
          }
          return best;
        })
      : undefined;
    // Every timeline for this student is accounted for — a stale device from a
    // previous install must not show up as an unrostered intruder.
    for (const c of candidates) used.add(c.deviceId);

    // Attendance is sticky while the device is actively reporting: a phone
    // that walks out keeps its row present (it keeps sending present=false),
    // but a device that stopped reporting (attendance not started/ended) must
    // not leave a phantom "present" behind.
    const latched = t?.everPresent ?? (t?.present ?? false);
    const fresh =
      t != null && (ttlMs == null || generatedAt - t.lastSeen <= ttlMs);
    const marked = mark != null;
    return {
      studentId: s.studentId,
      name: s.name,
      deviceId: t?.deviceId ?? s.deviceId ?? null,
      // A manual/RFID mark outlives the report TTL (offline card tap): it is
      // only cleared by an explicit attendance reset.
      present: marked || (latched && fresh),
      firstSeen: t?.firstSeen ?? mark?.at ?? null,
      lastSeen: t?.lastSeen ?? mark?.at ?? null,
      presentMs: t?.presentMs ?? 0,
      coverage: t ? coverageOf(t) : marked ? 1 : 0,
    };
  });

  // Only currently-seen strangers: a device that left long ago (or a one-off
  // probe) shouldn't clutter the live register.
  const unrostered = timelines.filter(
    (t) =>
      !used.has(t.deviceId) &&
      (ttlMs == null || generatedAt - t.lastSeen <= ttlMs),
  );

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
