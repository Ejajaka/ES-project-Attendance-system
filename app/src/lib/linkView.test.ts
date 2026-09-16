import { test, expect } from "vitest";
import type { LinkSummary } from "shared";
import {
  formatAge,
  linkChips,
  linkGlyph,
  linkStateLabel,
  modalityLabel,
} from "./linkView";

test("each link state has a glyph", () => {
  expect(linkGlyph("connected")).toBe("●");
  expect(linkGlyph("degraded")).toBe("◐");
  expect(linkGlyph("lost")).toBe("○");
});

test("state labels are console-ready", () => {
  expect(linkStateLabel("connected")).toBe("CONNECTED");
  expect(linkStateLabel("lost")).toBe("LOST");
});

test("chips show all three channels in B/W/U order", () => {
  const link = {
    deviceId: "d",
    mode: "jushin",
    at: 0,
    state: "degraded",
    quality: 0.4,
    modalities: [
      { modality: "ble", state: "connected", quality: 1, rssi: -55, snr: null, received: true, missReason: null, detail: "" },
      { modality: "wifi", state: "degraded", quality: 0.4, rssi: -80, snr: null, received: true, missReason: null, detail: "" },
      { modality: "ultrasonic", state: "lost", quality: 0, rssi: null, snr: null, received: false, missReason: null, detail: "" },
    ],
  } satisfies LinkSummary;
  expect(linkChips(link)).toBe("B● W◐ U○");
});

test("chips show missing channels as dashes", () => {
  const link = {
    deviceId: "d",
    mode: "jushin",
    at: 0,
    state: "connected",
    quality: 1,
    modalities: [
      { modality: "ble", state: "connected", quality: 1, rssi: -55, snr: null, received: true, missReason: null, detail: "" },
    ],
  } satisfies LinkSummary;
  expect(linkChips(link)).toBe("B● W– U–");
});

test("chips handle a device that has not reported a link yet", () => {
  expect(linkChips(undefined)).toBe("B– W– U–");
});

test("ages are compact", () => {
  expect(formatAge(1_000, 6_000)).toBe("5s");
  expect(formatAge(0, 90_000)).toBe("1m");
  expect(formatAge(0, 3_700_000)).toBe("1h");
  expect(formatAge(10_000, 5_000)).toBe("0s");
});

test("modalities are labelled in plain words", () => {
  expect(modalityLabel("ble")).toBe("BLUETOOTH");
  expect(modalityLabel("wifi")).toBe("WIFI");
  expect(modalityLabel("ultrasonic")).toBe("ULTRASONIC");
});
