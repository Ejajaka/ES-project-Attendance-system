import type { DeviceReport, GroundTruth } from "shared";

/** Append-only storage for ingested reports + ground truth. */
export interface Store {
  addReport(report: DeviceReport): void;
  reportsForSession(sessionId: string): DeviceReport[];
  latestPerDevice(sessionId: string): Map<string, DeviceReport>;
  addGroundTruth(gt: GroundTruth): void;
  groundTruthForSession(sessionId: string): GroundTruth[];
}

export class MemoryStore implements Store {
  private reports: DeviceReport[] = [];
  private groundTruths: GroundTruth[] = [];

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
}
