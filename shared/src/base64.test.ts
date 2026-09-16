import { test, expect } from "vitest";
import { encodeBase64Utf8 } from "./base64";

/**
 * The fusion server's session contract takes the rolling-code secret as
 * base64; the app keeps human-readable secrets in settings and must encode
 * them at the wire boundary.
 */

test("encodes an ASCII secret to standard base64", () => {
  expect(encodeBase64Utf8("shusseki")).toBe("c2h1c3Nla2k=");
  expect(encodeBase64Utf8("shusseki-preset-1-secret")).toBe(
    "c2h1c3Nla2ktcHJlc2V0LTEtc2VjcmV0",
  );
});

test("encodes empty string", () => {
  expect(encodeBase64Utf8("")).toBe("");
});

test("encodes UTF-8 bytes, not UTF-16 code units", () => {
  // "é" is 2 UTF-8 bytes (0xC3 0xA9) → "w6k="
  expect(encodeBase64Utf8("é")).toBe("w6k=");
  // 出席 is 6 UTF-8 bytes
  expect(encodeBase64Utf8("出席")).toBe("5Ye65bit");
});
