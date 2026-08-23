import type { DeviceReport, GroundTruth } from "shared";

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
}

export class MemoryStore implements Store {
  private reports: DeviceReport[] = [];
  private groundTruths: GroundTruth[] = [];
  private e2eLog: E2eEvent[] = [];

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
}
