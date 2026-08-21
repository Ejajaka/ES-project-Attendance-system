/**
 * Rolling-code (TOTP-like) generation + verification used by the Soshin to
 * broadcast an ultrasonic presence token. The Server is the final authority on
 * validity; the Soshin's local check is only a fast pre-check.
 *
 * Implemented as RFC 6238 (HMAC-SHA1). This module is intentionally free of
 * Node-specific crypto so it runs unchanged in Bun, Node, and React Native —
 * `shared` is used by the app bundle as well as the server.
 */

export const TOTP_DEFAULT_STEP = 30;
export const TOTP_DEFAULT_DIGITS = 6;

export interface TOTPOptions {
  step?: number;
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

// ---- Pure-JS HMAC-SHA1 (no Buffer / node:crypto) ---------------------------

const rotl = (n: number, b: number): number =>
  ((n << b) | (n >>> (32 - b))) >>> 0;

function sha1(bytes: Uint8Array): Uint8Array {
  const l = bytes.length;
  const bitLenHi = Math.floor((l * 8) / 0x100000000);
  const bitLenLo = (l * 8) >>> 0;
  const paddedLen = (((l + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi, false);
  dv.setUint32(paddedLen - 4, bitLenLo, false);

  const w = new Array<number>(80);
  const h = [
    0x67452301,
    0xefcdab89,
    0x98badcfe,
    0x10325476,
    0xc3d2e1f0,
  ];

  for (let block = 0; block < paddedLen; block += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(block + i * 4, false) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(
        ((w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!) >>> 0),
        1,
      );
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((rotl(a, 5) + f + e + k + w[i]!) >>> 0)) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) ov.setUint32(i * 4, h[i]!, false);
  return out;
}

function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha1(key) : key;
  const block = new Uint8Array(64);
  block.set(k.slice(0, 64));

  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = block[i]! ^ 0x36;
    opad[i] = block[i]! ^ 0x5c;
  }

  const inner = new Uint8Array(64 + msg.length);
  inner.set(ipad);
  inner.set(msg, 64);
  const innerHash = sha1(inner);

  const outer = new Uint8Array(64 + 20);
  outer.set(opad);
  outer.set(innerHash, 64);
  return sha1(outer);
}

function hotp(secret: Uint8Array, counter: number, digits: number): string {
  // 8-byte big-endian counter.
  const msg = new Uint8Array(8);
  const dv = new DataView(msg.buffer);
  dv.setUint32(0, Math.floor(counter / 0x100000000));
  dv.setUint32(4, counter >>> 0);

  const digest = hmacSha1(secret, msg);
  const offset = digest[19]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  const mod = 10 ** digits;
  return (bin % mod).toString().padStart(digits, "0");
}
