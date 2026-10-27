import { describe, expect, test } from "vitest";
import {
  appendSample,
  lastPoint,
  latest,
  SIGNAL_WINDOW,
  SIGNAL_Y_MAX,
  SIGNAL_Y_MIN,
  type SignalSample,
  scaleY,
  toSegments,
  windowMs,
} from "./signalGraph";

const s = (t: number, ble: number | null, wifi: number | null): SignalSample => ({ t, ble, wifi });

describe("appendSample", () => {
  test("keeps the newest samples within the window", () => {
    const base = Array.from({ length: SIGNAL_WINDOW }, (_, i) => s(i, -60, -60));
    const next = appendSample(base, s(999, -55, -65));
    expect(next).toHaveLength(SIGNAL_WINDOW);
    const newest = next[next.length - 1];
    const oldest = next[0];
    expect(newest?.t).toBe(999);
    expect(oldest?.t).toBe(1); // oldest dropped
  });

  test("does not mutate the input", () => {
    const base = [s(1, -50, -50)];
    appendSample(base, s(2, -60, -60));
    expect(base).toHaveLength(1);
  });
});

describe("scaleY", () => {
  test("maps the dBm range onto the plot height", () => {
    expect(scaleY(SIGNAL_Y_MIN, 100)).toBe(100); // floor → bottom
    expect(scaleY(SIGNAL_Y_MAX, 100)).toBe(0); // ceiling → top
    expect(scaleY(-65, 100)).toBe(50); // midpoint
  });

  test("clamps out-of-range readings", () => {
    expect(scaleY(-120, 100)).toBe(100);
    expect(scaleY(-10, 100)).toBe(0);
  });
});

describe("toSegments", () => {
  test("connects consecutive readings", () => {
    const segs = toSegments([s(0, -30, null), s(1, -100, null)], "ble", 100, 100);
    expect(segs).toHaveLength(1);
    const seg = segs[0];
    expect(seg).toBeDefined();
    if (!seg) return;
    expect(seg.length).toBeCloseTo(Math.hypot(100, 100), 5);
    expect(seg.x).toBeCloseTo(50, 5);
    expect(seg.y).toBeCloseTo(50, 5);
    expect(seg.angle).toBeCloseTo(Math.PI / 4, 5);
  });

  test("breaks the line on a null reading", () => {
    const segs = toSegments([s(0, -60, null), s(1, null, null), s(2, -60, null)], "ble", 100, 100);
    expect(segs).toHaveLength(0);
  });

  test("ignores series with fewer than two points or no plot area", () => {
    expect(toSegments([], "wifi", 100, 100)).toHaveLength(0);
    expect(toSegments([s(0, -60, -60)], "wifi", 100, 100)).toHaveLength(0);
    expect(toSegments([s(0, -60, -60), s(1, -70, -70)], "wifi", 0, 100)).toHaveLength(0);
  });
});

describe("latest / lastPoint / windowMs", () => {
  const samples = [s(1000, -70, -80), s(2000, -65, null), s(3000, null, -75)];

  test("latest returns the newest non-null value per series", () => {
    expect(latest(samples, "ble")).toBe(-65);
    expect(latest(samples, "wifi")).toBe(-75);
    expect(latest([], "ble")).toBeNull();
  });

  test("lastPoint maps the newest reading into plot coordinates", () => {
    // wifi's newest point is the last index (x = width), -75 dBm.
    const p = lastPoint(samples, "wifi", 100, 100);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeCloseTo(scaleY(-75, 100), 5);
  });

  test("windowMs reports the span between first and last poll", () => {
    expect(windowMs(samples)).toBe(2000);
    expect(windowMs([])).toBe(0);
  });
});
