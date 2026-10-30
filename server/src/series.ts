import type { DeviceReport } from "shared";

/**
 * Pure time-series builder for the live dashboard. One point per ingested
 * report: strongest BLE beacon, the joined AP's WiFi RSSI, and the ultrasonic
 * SNR. Nulls are kept so the chart shows a gap instead of a fake line.
 */

export interface SeriesPoint {
  /** Report timestamp (ms epoch). */
  t: number;
  /** Strongest BLE beacon RSSI, dBm. */
  ble: number | null;
  /** Transmitter AP RSSI, dBm. */
  wifi: number | null;
  /** Ultrasonic SNR. */
  snr: number | null;
}

export interface DeviceSeries {
  deviceId: string;
  mode: string;
  points: SeriesPoint[];
}

export interface SeriesPayload {
  sessionId: string;
  windowMs: number;
  generatedAt: number;
  devices: DeviceSeries[];
}

/** Default live window for the dashboard. */
export const SERIES_WINDOW_MS = 10 * 60_000;
/** Cap per device so a long session stays cheap to poll. */
export const SERIES_MAX_POINTS = 240;

/** Strongest beacon seen in a report (proximity proxy), or null. */
export function strongestBle(report: DeviceReport): number | null {
  const values = (report.ble?.readings ?? [])
    .map((r) => r.rssi)
    .filter((v) => Number.isFinite(v));
  return values.length ? Math.max(...values) : null;
}

export function buildSeries(
  sessionId: string,
  reports: readonly DeviceReport[],
  opts: { now?: number; windowMs?: number; maxPoints?: number } = {},
): SeriesPayload {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? SERIES_WINDOW_MS;
  const maxPoints = opts.maxPoints ?? SERIES_MAX_POINTS;
  const cutoff = now - windowMs;
  const byDevice = new Map<string, DeviceSeries>();

  for (const report of reports) {
    if (report.sessionId !== sessionId || report.timestamp < cutoff) continue;
    const point: SeriesPoint = {
      t: report.timestamp,
      ble: strongestBle(report),
      wifi: report.wifi?.soshinRssi ?? null,
      snr: report.ultrasonic?.snr ?? null,
    };
    let series = byDevice.get(report.deviceId);
    if (!series) {
      series = { deviceId: report.deviceId, mode: report.mode, points: [] };
      byDevice.set(report.deviceId, series);
    }
    series.points.push(point);
  }

  for (const series of byDevice.values()) {
    series.points.sort((a, b) => a.t - b.t);
    if (series.points.length > maxPoints) {
      series.points = series.points.slice(-maxPoints);
    }
  }

  return { sessionId, windowMs, generatedAt: now, devices: [...byDevice.values()] };
}
