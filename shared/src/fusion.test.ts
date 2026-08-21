import { test, expect } from "bun:test";
import { fuse, decide, type Combiner } from "./fusion";
import type { Modality } from "./types";

test("fuse of an empty input is 0", () => {
  expect(fuse({})).toBe(0);
});

test("fuse with a single modality returns that modality", () => {
  expect(fuse({ ble: 0.7 })).toBeCloseTo(0.7, 6);
});

test("average combiner is the mean of present modalities", () => {
  const c = fuse({ ble: 0.4, wifi: 0.8, ultrasonic: 0.6 }, { combiner: "average" });
  expect(c).toBeCloseTo((0.4 + 0.8 + 0.6) / 3, 6);
});

test("noisy-or is higher than any single input (probabilistic OR)", () => {
  const c = fuse({ ble: 0.5, wifi: 0.5 });
  expect(c).toBeGreaterThan(0.5);
  expect(c).toBeCloseTo(0.75, 6);
});

test("noisy-or of all-zero inputs is 0", () => {
  expect(fuse({ ble: 0, wifi: 0, ultrasonic: 0 })).toBe(0);
});

test("noisy-or of all-one inputs is 1", () => {
  expect(fuse({ ble: 1, wifi: 1, ultrasonic: 1 })).toBe(1);
});

test("weighted combiner honours explicit weights", () => {
  const c = fuse({ ble: 0.9, wifi: 0.1 }, {
    combiner: "weighted",
    weights: { ble: 0, wifi: 1 },
  });
  expect(c).toBeCloseTo(0.1, 6);
});

test("weighted combiner defaults to equal weights", () => {
  const c = fuse({ ble: 0.2, wifi: 0.8 }, { combiner: "weighted" });
  expect(c).toBeCloseTo(0.5, 6);
});

test("fuse ignores NaN and missing modalities", () => {
  const partial: Partial<Record<Modality, number>> = { ble: 0.6, wifi: NaN };
  expect(fuse(partial)).toBeCloseTo(0.6, 6);
});

test("decide respects the threshold (default 0.5)", () => {
  expect(decide(0.49)).toBe(false);
  expect(decide(0.5)).toBe(true);
  expect(decide(0.51)).toBe(true);
});

test("all combiners agree on a single modality", () => {
  const combiners: Combiner[] = ["noisy-or", "average", "weighted"];
  for (const combiner of combiners) {
    expect(fuse({ ble: 0.3 }, { combiner })).toBeCloseTo(0.3, 6);
  }
});
