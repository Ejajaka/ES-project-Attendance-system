import {
  ATTENDANCE_MAX_GAP_MS,
  dwellUpdate,
  type DeviceReport,
  type GroundTruth,
  type Student,
  type DeviceTimeline,
  type DwellState,
  type DwellOptions,
} from "shared";

/** One self-reported step from an automated E2E test run. */
export interface E2eEvent {
  sessionId: string;
  deviceId: string;
  role: "soshin" | "jushin";
  phase: string;
  at: number;
  detail?: Record<string, unknown>;
}

/** Append-only storage for ingested reports + ground truth. */
export interface Store {
  addReport(report: DeviceReport): void;
  reportsForSession(sessionId: string): DeviceReport[];
  latestPerDevice(sessionId: string): Map<string, DeviceReport>;
  addGroundTruth(gt: GroundTruth): void;
  groundTruthForSession(sessionId: string): GroundTruth[];
  /** Upsert the latest E2E event per (session, device, phase). */
  e2eUpsert(event: E2eEvent): void;
  e2eForSession(sessionId: string): E2eEvent[];
  /** Remember the transmitter's live hotspot so receivers can auto-join. */
  setHotspot(announcement: HotspotAnnouncement): void;
  getHotspot(sessionId: string): HotspotAnnouncement | undefined;
  /** Replace a session's class roster. */
  setRoster(sessionId: string, students: Student[]): void;
  rosterForSession(sessionId: string): Student[];
  /** Add a student to the roster if absent (auto-enroll from a report). */
  ensureStudent(
    sessionId: string,
    student: { studentId: string; name?: string; deviceId?: string },
  ): void;
  /** Fold one presence sample into the device's attendance timeline. */
  recordSample(
    sessionId: string,
    deviceId: string,
    studentId: string | undefined,
    at: number,
    present: boolean,
  ): void;
  timelinesForSession(sessionId: string): DeviceTimeline[];
  /** Fold a raw in-room verdict into the device's dwell state. */
  updateRoomPresence(
    sessionId: string,
    deviceId: string,
    rawInRoom: boolean,
    at: number,
    options?: DwellOptions,
  ): DwellState;
  getDwell(sessionId: string, deviceId: string): DwellState | undefined;
  addCalibration(sample: CalibrationSample): void;
  calibrationForSession(sessionId: string): CalibrationSample[];
  clearCalibration(sessionId: string): void;
  /** Drop this session's reports + attendance timeline (keeps roster/calibration). */
  clearAttendance(sessionId: string): void;
  /** Track the strongest room signal each device has produced this session. */
  updateBaseline(
    sessionId: string,
    deviceId: string,
    sample: { ble: number | null; wifi: number | null },
  ): SignalBaseline;
  getBaseline(sessionId: string, deviceId: string): SignalBaseline | undefined;
}

/** A transmitter announcing its LocalOnlyHotspot to the session. */
export interface HotspotAnnouncement {
  sessionId: string;
  deviceId: string;
  ssid: string;
  passphrase: string | null;
  at: number;
}

/** One labelled RSSI sample used to calibrate the room boundary. */
export interface CalibrationSample {
  sessionId: string;
  label: "inside" | "outside";
  deviceId: string;
  ble: number | null;
  wifi: number | null;
  at: number;
}

/** A device's strongest observed room signal (per channel). */
export interface SignalBaseline {
  ble: number | null;
  wifi: number | null;
}

/** Whole-store serialization (for the JSON-file persistence in server.ts). */
export interface StoreSnapshot {
  reports: DeviceReport[];
  groundTruths: GroundTruth[];
  e2eLog: E2eEvent[];
  hotspots: HotspotAnnouncement[];
  rosters: [string, Student[]][];
  timelines: [string, DeviceTimeline[]][];
  calibrations?: CalibrationSample[];
}

export class MemoryStore implements Store {
  private reports: DeviceReport[] = [];
  private groundTruths: GroundTruth[] = [];
  private e2eLog: E2eEvent[] = [];
  private hotspots = new Map<string, HotspotAnnouncement>();
  private rosters = new Map<string, Student[]>();
  private timelines = new Map<string, Map<string, DeviceTimeline>>();
  private dwells = new Map<string, Map<string, DwellState>>();
  private calibrations: CalibrationSample[] = [];
  private baselines = new Map<string, Map<string, SignalBaseline>>();

  addReport(report: DeviceReport): void {
    this.reports.push(report);
  }

  reportsForSession(sessionId: string): DeviceReport[] {
    return this.reports.filter((r) => r.sessionId === sessionId);
  }

  latestPerDevice(sessionId: string): Map<string, DeviceReport> {
    const map = new Map<string, DeviceReport>();
    for (const r of this.reports) {
      if (r.sessionId !== sessionId) continue;
      const existing = map.get(r.deviceId);
      if (!existing || r.timestamp >= existing.timestamp) {
        map.set(r.deviceId, r);
      }
    }
    return map;
  }

  addGroundTruth(gt: GroundTruth): void {
    this.groundTruths.push(gt);
  }

  groundTruthForSession(sessionId: string): GroundTruth[] {
    return this.groundTruths.filter((g) => g.sessionId === sessionId);
  }

  e2eUpsert(event: E2eEvent): void {
    const i = this.e2eLog.findIndex(
      (e) =>
        e.sessionId === event.sessionId &&
        e.deviceId === event.deviceId &&
        e.phase === event.phase,
    );
    if (i >= 0) this.e2eLog[i] = event;
    else this.e2eLog.push(event);
  }

  e2eForSession(sessionId: string): E2eEvent[] {
    return this.e2eLog.filter((e) => e.sessionId === sessionId);
  }

  setHotspot(announcement: HotspotAnnouncement): void {
    this.hotspots.set(announcement.sessionId, announcement);
  }

  getHotspot(sessionId: string): HotspotAnnouncement | undefined {
    return this.hotspots.get(sessionId);
  }

  setRoster(sessionId: string, students: Student[]): void {
    this.rosters.set(
      sessionId,
      students.map((s) => ({
        ...s,
        studentId: s.studentId.trim(),
        name: s.name.trim(),
      })),
    );
  }

  rosterForSession(sessionId: string): Student[] {
    return this.rosters.get(sessionId) ?? [];
  }

  ensureStudent(
    sessionId: string,
    student: { studentId: string; name?: string; deviceId?: string },
  ): void {
    const studentId = student.studentId.trim();
    if (!studentId) return;
    const list = this.rosters.get(sessionId) ?? [];
    const i = list.findIndex((s) => s.studentId.trim() === studentId);
    if (i < 0) {
      list.push({
        studentId,
        name: student.name?.trim() || studentId,
        deviceId: student.deviceId,
      });
      this.rosters.set(sessionId, list);
      return;
    }
    const cur = list[i]!;
    const next = { ...cur };
    // Only overwrite a name when the report supplies one (never the roll fallback).
    if (student.name?.trim() && cur.name !== student.name.trim()) {
      next.name = student.name.trim();
    }
    // Reinstalled or swapped phone: keep the roster bound to the current device.
    if (student.deviceId && cur.deviceId !== student.deviceId) {
      next.deviceId = student.deviceId;
    }
    if (next.name !== cur.name || next.deviceId !== cur.deviceId) {
      list[i] = next;
      this.rosters.set(sessionId, list);
    }
  }

  recordSample(
    sessionId: string,
    deviceId: string,
    studentId: string | undefined,
    at: number,
    present: boolean,
  ): void {
    let perSession = this.timelines.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      this.timelines.set(sessionId, perSession);
    }

    const t = perSession.get(deviceId);
    if (!t) {
      perSession.set(deviceId, {
        deviceId,
        studentId,
        firstSeen: at,
        lastSeen: at,
        presentMs: 0,
        samples: 1,
        present,
      });
      return;
    }

    // Credit the gap only when present at both ends, and cap it so a long
    // absence isn't mis-counted as presence.
    const dt = at - t.lastSeen;
    if (t.present && present && dt > 0 && dt <= ATTENDANCE_MAX_GAP_MS) {
      t.presentMs += dt;
    }
    if (at < t.firstSeen) t.firstSeen = at;
    if (at > t.lastSeen) t.lastSeen = at;
    t.samples += 1;
    t.present = present;
    if (studentId) t.studentId = studentId;
  }

  timelinesForSession(sessionId: string): DeviceTimeline[] {
    return [...(this.timelines.get(sessionId)?.values() ?? [])];
  }

  updateRoomPresence(
    sessionId: string,
    deviceId: string,
    rawInRoom: boolean,
    at: number,
    options?: DwellOptions,
  ): DwellState {
    let perSession = this.dwells.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      this.dwells.set(sessionId, perSession);
    }
    const next = dwellUpdate(perSession.get(deviceId), rawInRoom, at, options);
    perSession.set(deviceId, next);
    return next;
  }

  getDwell(sessionId: string, deviceId: string): DwellState | undefined {
    return this.dwells.get(sessionId)?.get(deviceId);
  }

  addCalibration(sample: CalibrationSample): void {
    this.calibrations.push(sample);
  }

  calibrationForSession(sessionId: string): CalibrationSample[] {
    return this.calibrations.filter((c) => c.sessionId === sessionId);
  }

  clearCalibration(sessionId: string): void {
    this.calibrations = this.calibrations.filter((c) => c.sessionId !== sessionId);
  }

  clearAttendance(sessionId: string): void {
    this.reports = this.reports.filter((r) => r.sessionId !== sessionId);
    this.timelines.delete(sessionId);
    this.dwells.delete(sessionId);
    // A fresh register should learn each phone's baseline again.
    this.baselines.delete(sessionId);
  }

  updateBaseline(
    sessionId: string,
    deviceId: string,
    sample: { ble: number | null; wifi: number | null },
  ): SignalBaseline {
    let perSession = this.baselines.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      this.baselines.set(sessionId, perSession);
    }
    const prev = perSession.get(deviceId) ?? { ble: null, wifi: null };
    const next: SignalBaseline = {
      ble:
        sample.ble == null
          ? prev.ble
          : prev.ble == null
            ? sample.ble
            : Math.max(prev.ble, sample.ble),
      wifi:
        sample.wifi == null
          ? prev.wifi
          : prev.wifi == null
            ? sample.wifi
            : Math.max(prev.wifi, sample.wifi),
    };
    perSession.set(deviceId, next);
    return next;
  }

  getBaseline(sessionId: string, deviceId: string): SignalBaseline | undefined {
    return this.baselines.get(sessionId)?.get(deviceId);
  }

  /** Serialize all state (reports, rosters, timelines, …) for persistence. */
  snapshot(): StoreSnapshot {
    return {
      reports: this.reports,
      groundTruths: this.groundTruths,
      e2eLog: this.e2eLog,
      hotspots: [...this.hotspots.values()],
      rosters: [...this.rosters.entries()],
      timelines: [...this.timelines.entries()].map(([k, m]) => [k, [...m.values()]]),
      calibrations: this.calibrations,
    };
  }

  restore(s: Partial<StoreSnapshot>): void {
    this.reports = s.reports ?? [];
    this.groundTruths = s.groundTruths ?? [];
    this.e2eLog = s.e2eLog ?? [];
    this.hotspots = new Map((s.hotspots ?? []).map((h) => [h.sessionId, h]));
    this.rosters = new Map(s.rosters ?? []);
    this.timelines = new Map(
      (s.timelines ?? []).map(([k, arr]) => [
        k,
        new Map(arr.map((t) => [t.deviceId, t])),
      ]),
    );
    this.calibrations = s.calibrations ?? [];
  }
}
