import { describe, expect, test } from "vitest";
import { RssiSmoother } from "./rssiSmoother";

describe("RssiSmoother", () => {
  test("median of a single sample is that sample", () => {
    const s = new RssiSmoother(5);
    expect(s.push(-60)).toBe(-60);
  });

  test("smooths a spike; median ignores a deep fade", () => {
    const s = new RssiSmoother(5);
    [-50, -51, -90, -49, -52].forEach((v) => s.push(v));
    // sorted [-90,-52,-51,-50,-49] -> median -51
    expect(s.median()).toBe(-51);
  });

  test("uses the last N samples", () => {
    const s = new RssiSmoother(3);
    [-40, -41, -42, -43].forEach((v) => s.push(v));
    // window [-41,-42,-43] -> median -42
    expect(s.median()).toBe(-42);
  });

  test("even count averages the middle two", () => {
    const s = new RssiSmoother(4);
    [-50, -52, -54, -56].forEach((v) => s.push(v));
    expect(s.median()).toBe(-53);
  });
});
