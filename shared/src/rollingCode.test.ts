import { test, expect } from "bun:test";
import {
  generateTOTP,
  verifyTOTP,
  TOTP_DEFAULT_STEP,
  TOTP_DEFAULT_DIGITS,
} from "./rollingCode";

const SECRET = new TextEncoder().encode("test-room-secret-0123456789");
// Align to a step boundary so "add N steps" is exact.
const STEP_MS = TOTP_DEFAULT_STEP * 1000;
const ALIGNED = Math.floor(1_700_000_000 / STEP_MS) * STEP_MS;

test("conforms to the RFC 6238 test vector (SHA-1)", () => {
  // RFC 6238 Appendix B, T=59s, step 30, secret = ASCII "12345678901234567890".
  const secret = new TextEncoder().encode("12345678901234567890");
  // 8-digit codes for the given times.
  const cases: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, expected8] of cases) {
    const code8 = generateTOTP(secret, t * 1000, { step: 30, digits: 8 });
    expect(code8).toBe(expected8);
  }
});

test("generateTOTP is deterministic for the same secret + time", () => {
  const a = generateTOTP(SECRET, ALIGNED);
  const b = generateTOTP(SECRET, ALIGNED);
  expect(a).toBe(b);
});

test("generateTOTP returns a fixed-width numeric string", () => {
  const code = generateTOTP(SECRET, ALIGNED);
  expect(code).toMatch(/^\d{6}$/);
  expect(code.length).toBe(TOTP_DEFAULT_DIGITS);
});

test("verifyTOTP accepts the code generated at the same time step", () => {
  const code = generateTOTP(SECRET, ALIGNED);
  const result = verifyTOTP(SECRET, code, ALIGNED);
  expect(result.valid).toBe(true);
  expect(result.delta).toBe(0);
});

test("verifyTOTP rejects a wrong code", () => {
  const result = verifyTOTP(SECRET, "000000", ALIGNED);
  expect(result.valid).toBe(false);
});

test("verifyTOTP accepts codes within the default +/- 1 step window", () => {
  const codeNow = generateTOTP(SECRET, ALIGNED);

  const past = verifyTOTP(SECRET, codeNow, ALIGNED + STEP_MS);
  expect(past.valid).toBe(true);
  expect(past.delta).toBe(-1);

  const future = verifyTOTP(SECRET, codeNow, ALIGNED - STEP_MS);
  expect(future.valid).toBe(true);
  expect(future.delta).toBe(1);

  expect(verifyTOTP(SECRET, codeNow, ALIGNED).delta).toBe(0);
});

test("verifyTOTP rejects codes outside the configured window", () => {
  const codeNow = generateTOTP(SECRET, ALIGNED);
  const tooFar = verifyTOTP(SECRET, codeNow, ALIGNED + STEP_MS * 2, { window: 1 });
  expect(tooFar.valid).toBe(false);
});

test("verifyTOTP honours a wider window for acoustic latency tolerance", () => {
  const codeNow = generateTOTP(SECRET, ALIGNED);
  const rejected = verifyTOTP(SECRET, codeNow, ALIGNED + STEP_MS * 3, { window: 1 });
  expect(rejected.valid).toBe(false);

  const accepted = verifyTOTP(SECRET, codeNow, ALIGNED + STEP_MS * 3, { window: 3 });
  expect(accepted.valid).toBe(true);
  expect(accepted.delta).toBe(-3);
});
