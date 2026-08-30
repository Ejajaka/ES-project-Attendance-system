import type { DeviceReport } from "shared";
import type { ServerPresence } from "./server";

/**
 * What the ingest endpoint answered. The server computes authoritative
 * presence per report — the app surfaces it back to the super-user.
 */
export interface ReportResult {
  presence: ServerPresence | null;
  /** HTTP round-trip time of the ingest request (ms). */
  rttMs: number;
}

/** Sends a device report to the fusion server. */
export interface Reporter {
  send(report: DeviceReport): Promise<ReportResult>;
}

/** HTTP reporter — posts to the server's /api/reports ingest endpoint. */
export class HttpReporter implements Reporter {
  constructor(private baseUrl: string) {}

  async send(report: DeviceReport): Promise<ReportResult> {
    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}/api/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    const rttMs = Date.now() - t0;
    if (!res.ok) {
      throw new Error(`report failed: ${res.status}`);
    }
    let presence: ServerPresence | null = null;
    try {
      const body = (await res.json()) as { presence?: ServerPresence };
      presence = body?.presence ?? null;
    } catch {
      // Non-JSON body? Keep null; the caller still knows the report landed.
    }
    return { presence, rttMs };
  }
}

/** Captures reports in memory — used by tests and offline dev. */
export class MockReporter implements Reporter {
  sent: DeviceReport[] = [];
  async send(report: DeviceReport): Promise<ReportResult> {
    this.sent.push(report);
    return { presence: null, rttMs: 0 };
  }
}