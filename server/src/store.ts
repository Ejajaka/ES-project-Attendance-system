import {
  ATTENDANCE_MAX_GAP_MS,
  type DeviceReport,
  type GroundTruth,
  type Student,
  type DeviceTimeline,
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
}

/** A transmitter announcing its LocalOnlyHotspot to the session. */
export interface HotspotAnnouncement {
  sessionId: string;
  deviceId: string;
  ssid: string;
  passphrase: string | null;
  at: number;
}

/** Whole-store serialization (for the JSON-file persistence in server.ts). */
export interface StoreSnapshot {
  reports: DeviceReport[];
  groundTruths: GroundTruth[];
  e2eLog: E2eEvent[];
  hotspots: HotspotAnnouncement[];
  rosters: [string, Student[]][];
  timelines: [string, DeviceTimeline[]][];
}

export class MemoryStore implements Store {
  private reports: DeviceReport[] = [];
  private groundTruths: GroundTruth[] = [];
  private e2eLog: E2eEvent[] = [];
  private hotspots = new Map<string, HotspotAnnouncement>();
  private rosters = new Map<string, Student[]>();
  private timelines = new Map<string, Map<string, DeviceTimeline>>();

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
    this.rosters.set(sessionId, students);
  }

  rosterForSession(sessionId: string): Student[] {
    return this.rosters.get(sessionId) ?? [];
  }

  ensureStudent(
    sessionId: string,
    student: { studentId: string; name?: string; deviceId?: string },
  ): void {
    const list = this.rosters.get(sessionId) ?? [];
    const i = list.findIndex((s) => s.studentId === student.studentId);
    if (i < 0) {
      list.push({
        studentId: student.studentId,
        name: student.name || student.studentId,
        deviceId: student.deviceId,
      });
      this.rosters.set(sessionId, list);
    } else if (student.name && list[i]!.name !== student.name) {
      // Only overwrite a name when the report supplies one (never the roll fallback).
      list[i] = { ...list[i]!, name: student.name };
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

  /** Serialize all state (reports, rosters, timelines, …) for persistence. */
  snapshot(): StoreSnapshot {
    return {
      reports: this.reports,
      groundTruths: this.groundTruths,
      e2eLog: this.e2eLog,
      hotspots: [...this.hotspots.values()],
      rosters: [...this.rosters.entries()],
      timelines: [...this.timelines.entries()].map(([k, m]) => [k, [...m.values()]]),
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
  }
}
