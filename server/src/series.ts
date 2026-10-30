import type { DeviceReport } from "shared";
import type { TelemetryPoint } from "./store";

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
/** Cap per device so a long session stays cheap to poll (0.5 s × 1200 ≈ 10 min). */
export const SERIES_MAX_POINTS = 1200;

/** Strongest beacon seen in a report (proximity proxy), or null. */
export function strongestBle(report: DeviceReport): number | null {
  const values = (report.ble?.readings ?? [])
    .map((r) => r.rssi)
    .filter((v) => Number.isFinite(v));
  return values.length ? Math.max(...values) : null;
}

export interface SeriesOptions {
  now?: number;
  windowMs?: number;
  maxPoints?: number;
  /** 0.5 s graph samples merged with the 5 s reports. */
  telemetry?: readonly TelemetryPoint[];
}

export function buildSeries(
  sessionId: string,
  reports: readonly DeviceReport[],
  opts: SeriesOptions = {},
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
    } else {
      series.mode = report.mode;
    }
    series.points.push(point);
  }

  // Merge the fast telemetry samples (BLE/WiFi only; reports carry the SNR).
  for (const sample of opts.telemetry ?? []) {
    if (sample.t < cutoff) continue;
    let series = byDevice.get(sample.deviceId);
    if (!series) {
      series = { deviceId: sample.deviceId, mode: "jushin", points: [] };
      byDevice.set(sample.deviceId, series);
    }
    series.points.push({
      t: sample.t,
      ble: sample.ble,
      wifi: sample.wifi,
      snr: null,
    });
  }

  for (const series of byDevice.values()) {
    series.points.sort((a, b) => a.t - b.t);
    // Collapse identical timestamps, preferring whichever channel has a value.
    const merged: SeriesPoint[] = [];
    for (const point of series.points) {
      const prev = merged[merged.length - 1];
      if (prev && prev.t === point.t) {
        merged[merged.length - 1] = {
          t: point.t,
          ble: point.ble ?? prev.ble,
          wifi: point.wifi ?? prev.wifi,
          snr: point.snr ?? prev.snr,
        };
      } else {
        merged.push(point);
      }
    }
    series.points = merged.length > maxPoints ? merged.slice(-maxPoints) : merged;
  }

  return { sessionId, windowMs, generatedAt: now, devices: [...byDevice.values()] };
}
