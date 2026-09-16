import { test, expect } from "vitest";
import { roleLabel, roleTerms } from "./roles";

/**
 * The mode words must be unambiguous for a first-time operator: the room-side
 * unit TRANSMITS, the carried phone RECEIVES. Soshin/Jushin stay as brand.
 */

test("soshin is labelled transmitter, jushin receiver", () => {
  expect(roleTerms("soshin").en).toBe("TRANSMITTER");
  expect(roleTerms("jushin").en).toBe("RECEIVER");
  expect(roleLabel("soshin")).toContain("TRANSMITTER");
  expect(roleLabel("jushin")).toContain("RECEIVER");
});

test("brand words are retained alongside the plain term", () => {
  expect(roleLabel("soshin")).toContain("SOSHIN");
  expect(roleLabel("jushin")).toContain("JUSHIN");
});

test("each role explains where it runs", () => {
  expect(roleTerms("soshin").where).toMatch(/room/i);
  expect(roleTerms("jushin").where).toMatch(/phone|user/i);
});
