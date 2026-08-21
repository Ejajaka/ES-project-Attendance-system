import { createHmac } from "node:crypto";

/**
 * Rolling-code (TOTP-like) generation + verification used by the Soshin to
 * broadcast an ultrasonic presence token. The Server is the final authority on
 * validity; the Soshin's local check is only a fast pre-check.
 *
 * Implemented as RFC 6238 (HMAC-SHA1) so codes are reproducible across Soshin,
 * Jushin, and Server without a shared crypto dependency.
 */

export const TOTP_DEFAULT_STEP = 30;
export const TOTP_DEFAULT_DIGITS = 6;

export interface TOTPOptions {
  /** Time step in seconds. */
  step?: number;
  /** Number of digits in the emitted code. */
  digits?: number;
  /** Steps allowed on each side of "now". Wider = tolerant of clock drift +
   *  ultrasonic demodulation latency, but weaker anti-replay. */
  window?: number;
}

export interface TOTPVerifyResult {
  valid: boolean;
  /** Offset in steps from the verification time, or null if invalid. */
  delta: number | null;
}

/** Generate the rolling code for `timeMs` under `secret`. */
export function generateTOTP(
  secret: Uint8Array,
  timeMs: number,
  options: TOTPOptions = {},
): string {
  const step = options.step ?? TOTP_DEFAULT_STEP;
  const digits = options.digits ?? TOTP_DEFAULT_DIGITS;
  const counter = Math.floor(timeMs / 1000 / step);
  return hotp(secret, counter, digits);
}

/** Verify a candidate code against `secret` at `timeMs` within `window`. */
export function verifyTOTP(
  secret: Uint8Array,
  code: string,
  timeMs: number,
  options: TOTPOptions = {},
): TOTPVerifyResult {
  const step = options.step ?? TOTP_DEFAULT_STEP;
  const digits = options.digits ?? TOTP_DEFAULT_DIGITS;
  const window = options.window ?? 1;
  const counter = Math.floor(timeMs / 1000 / step);
  for (let delta = -window; delta <= window; delta++) {
    if (hotp(secret, counter + delta, digits) === code) {
      return { valid: true, delta };
    }
  }
  return { valid: false, delta: null };
}

function hotp(secret: Uint8Array, counter: number, digits: number): string {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // counter fits in uint32 for our time horizon; write as 64-bit big-endian.
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const msg = new Uint8Array(buf);

  const hmac = createHmac("sha1", Buffer.from(secret));
  hmac.update(Buffer.from(msg));
  const digest = hmac.digest();

  const offset = digest[digest.length - 1]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  const mod = 10 ** digits;
  const code = bin % mod;
  return code.toString().padStart(digits, "0");
}
