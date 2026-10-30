/**
 * Pure helpers for the live signal trace on the receiver console.
 *
 * Each tick polls the transmitter's WiFi AP and BLE beacons; those raw dBm
 * readings are what the graph plots. Keeping the maths here (no React Native)
 * makes the scaling and segment geometry unit-testable.
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

/** One rendered line segment between two consecutive non-null readings. */
export interface SignalSegment {
  /** Index of the segment's start point (stable React key). */
  from: number;
  /** Midpoint x (px from the left of the plot area). */
  x: number;
  /** Midpoint y (px from the top of the plot area). */
  y: number;
  /** Segment length in px. */
  length: number;
  /** Rotation in radians. */
  angle: number;
}

/** A point in the plot area (used for the "latest reading" marker). */
export interface SignalPoint {
  x: number;
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
 * Build the polyline segments for one series. Null readings break the line
 * (a gap, not a fake straight line) — a dropped BLE scan or a WiFi disconnect
 * should look like a gap on the trace.
 */
export function toSegments(
  samples: readonly SignalSample[],
  key: SignalKey,
  width: number,
  height: number,
  min = SIGNAL_Y_MIN,
  max = SIGNAL_Y_MAX,
): SignalSegment[] {
  if (samples.length < 2 || width <= 0 || height <= 0) return [];

  const points = pointFor(samples, key, width, height, min, max);
  const segments: SignalSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    segments.push({
      from: i - 1,
      x: a.x + dx / 2,
      y: a.y + dy / 2,
      length: Math.hypot(dx, dy),
      angle: Math.atan2(dy, dx),
    });
  }
  return segments;
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
