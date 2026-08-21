import type { DeviceReport } from "shared";

/** Sends a device report to the fusion server. */
export interface Reporter {
  send(report: DeviceReport): Promise<void>;
}

/** HTTP reporter — posts to the server's /api/reports ingest endpoint. */
export class HttpReporter implements Reporter {
  constructor(private baseUrl: string) {}

  async send(report: DeviceReport): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    if (!res.ok) {
      throw new Error(`report failed: ${res.status}`);
    }
  }
}

/** Captures reports in memory — used by tests and offline dev. */
export class MockReporter implements Reporter {
  sent: DeviceReport[] = [];
  async send(report: DeviceReport): Promise<void> {
    this.sent.push(report);
  }
}
