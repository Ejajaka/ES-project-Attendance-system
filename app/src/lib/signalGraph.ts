/**
 * Pure helpers for the live signal trace on the receiver console.
 *
 * Each tick polls the transmitter's WiFi AP and BLE beacons; those raw dBm
 * readings are what the graph plots. Keeping the maths here (no React Native)
 * makes the scaling and dot geometry unit-testable.
 */

/** One poll of the two proximity signals. Null = no reading on that tick. */
export interface SignalSample {
  /** Poll timestamp (ms epoch). */
  t: number;
  /** Strongest transmitter BLE beacon seen this tick, dBm. */
  ble: number | null;
  /** Transmitter AP RSSI, dBm (null when not joined). */
  wifi: number | null;
}

export type SignalKey = "ble" | "wifi";

/** Rolling window kept for the graph (0.5 s poll × 600 ≈ 5 min). */
export const SIGNAL_WINDOW = 600;

/** dBm range drawn on the graph. */
export const SIGNAL_Y_MIN = -100;
export const SIGNAL_Y_MAX = -30;

/** Append a poll, keeping only the newest `max` samples. */
export function appendSample(
  samples: readonly SignalSample[],
  next: SignalSample,
  max = SIGNAL_WINDOW,
): SignalSample[] {
  const out = [...samples, next];
  return out.length > max ? out.slice(out.length - max) : out;
}

/** Map a dBm value onto a y coordinate (0 = top, height = bottom). */
export function scaleY(
  value: number,
  height: number,
  min = SIGNAL_Y_MIN,
  max = SIGNAL_Y_MAX,
): number {
  const clamped = Math.max(min, Math.min(max, value));
  return (1 - (clamped - min) / (max - min)) * height;
}

/** A point in the plot area (used for the "latest reading" marker). */
export interface SignalPoint {
  x: number;
  y: number;
}

/** One rendered dot: a single non-null reading, positioned in the plot area. */
export interface SignalDot {
  /** Index of the sample the dot belongs to (stable React key). */
  at: number;
  /** x (px from the left of the plot area). */
  x: number;
  /** y (px from the top of the plot area). */
  y: number;
}

function xFor(index: number, count: number, width: number): number {
  return count > 1 ? (index * width) / (count - 1) : width;
}

function pointFor(
  samples: readonly SignalSample[],
  key: SignalKey,
  width: number,
  height: number,
  min: number,
  max: number,
): (SignalPoint | null)[] {
  return samples.map((s, i) => {
    const value = s[key];
    if (value == null || Number.isNaN(value)) return null;
    return { x: xFor(i, samples.length, width), y: scaleY(value, height, min, max) };
  });
}

/**
 * Build one dot per non-null reading for a series. A null reading gets no dot
 * at all — a dropped BLE scan or a WiFi disconnect reads as a hole in the
 * trace, never as a carried-forward or interpolated value.
 */
export function toDots(
  samples: readonly SignalSample[],
  key: SignalKey,
  width: number,
  height: number,
  min = SIGNAL_Y_MIN,
  max = SIGNAL_Y_MAX,
): SignalDot[] {
  if (width <= 0 || height <= 0) return [];

  const dots: SignalDot[] = [];
  pointFor(samples, key, width, height, min, max).forEach((point, i) => {
    if (point) dots.push({ at: i, x: point.x, y: point.y });
  });
  return dots;
}

/** Latest non-null reading for a series (the live readout). */
export function latest(samples: readonly SignalSample[], key: SignalKey): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i];
    if (!sample) continue;
    const value = sample[key];
    if (value != null && !Number.isNaN(value)) return value;
  }
  return null;
}

/** Position of the newest non-null reading, for the endpoint marker. */
export function lastPoint(
  samples: readonly SignalSample[],
  key: SignalKey,
  width: number,
  height: number,
  min = SIGNAL_Y_MIN,
  max = SIGNAL_Y_MAX,
): SignalPoint | null {
  const points = pointFor(samples, key, width, height, min, max);
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point) return point;
  }
  return null;
}

/** Elapsed wall-clock span of the current window, in ms (0 when empty). */
export function windowMs(samples: readonly SignalSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return 0;
  return last.t - first.t;
}
