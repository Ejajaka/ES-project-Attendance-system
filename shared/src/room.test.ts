import { describe, expect, test } from "vitest";
import {
  adaptiveThreshold,
  dwellUpdate,
  roomPresence,
  suggestThresholds,
  type DwellState,
} from "./room";

describe("roomPresence", () => {
  test("BLE above threshold is in the room", () => {
    const r = roomPresence({ ble: { readings: [{ nodeId: "tx", rssi: -60 }] } });
    expect(r.ble.inRoom).toBe(true);
    expect(r.inRoom).toBe(true);
  });

  test("BLE below threshold is not in the room", () => {
    const r = roomPresence({ ble: { readings: [{ nodeId: "tx", rssi: -85 }] } });
    expect(r.ble.inRoom).toBe(false);
    expect(r.inRoom).toBe(false);
  });

  test("only readings from the configured room node count", () => {
    const r = roomPresence(
      {
        ble: {
          readings: [
            { nodeId: "other-room", rssi: -40 }, // very strong but wrong node
            { nodeId: "tx", rssi: -85 },
          ],
        },
      },
      { roomNodeId: "tx" },
    );
    expect(r.ble.rssi).toBe(-85);
    expect(r.ble.inRoom).toBe(false);
  });

  test("WiFi associated and strong is in the room", () => {
    const r = roomPresence({
      wifi: { connectedToSoshin: true, soshinRssi: -50 },
    });
    expect(r.wifi.inRoom).toBe(true);
    expect(r.inRoom).toBe(true);
  });

  test("WiFi associated but weak is not in the room", () => {
    const r = roomPresence({
      wifi: { connectedToSoshin: true, soshinRssi: -80 },
    });
    expect(r.wifi.inRoom).toBe(false);
    expect(r.inRoom).toBe(false);
  });

  test("WiFi not associated is not in the room even with an RSSI", () => {
    const r = roomPresence({
      wifi: { connectedToSoshin: false, soshinRssi: -50 },
    });
    expect(r.wifi.inRoom).toBe(false);
  });

  test("an unassociated scan of the room AP is not trusted", () => {
    const r = roomPresence({
      wifi: { connectedToSoshin: false, soshinVisible: true, soshinRssi: -50 },
    });
    expect(r.wifi.inRoom).toBe(false);
    expect(r.inRoom).toBe(false);
  });

  test("weak BLE is not rescued by strong WiFi when the node was heard", () => {
    const r = roomPresence(
      {
        ble: { readings: [{ nodeId: "tx", rssi: -90 }] },
        wifi: { connectedToSoshin: true, soshinRssi: -55 },
      },
      { roomNodeId: "tx" },
    );
    expect(r.ble.inRoom).toBe(false);
    expect(r.wifi.inRoom).toBe(true);
    // BLE is authoritative once the room node is heard at all.
    expect(r.inRoom).toBe(false);
  });

  test("WiFi covers gaps where the room node was unheard", () => {
    const r = roomPresence(
      {
        ble: { readings: [] },
        wifi: { connectedToSoshin: true, soshinRssi: -50 },
      },
      { roomNodeId: "tx" },
    );
    expect(r.inRoom).toBe(true);
  });

  test("custom thresholds are honoured", () => {
    const r = roomPresence(
      { ble: { readings: [{ nodeId: "tx", rssi: -68 }] } },
      { bleRssiThreshold: -60 },
    );
    expect(r.ble.inRoom).toBe(false);
  });
});

describe("suggestThresholds", () => {
  test("separates when inside is stronger than outside", () => {
    const s = suggestThresholds([
      { label: "inside", ble: -55, wifi: -45 },
      { label: "inside", ble: -60, wifi: -50 },
      { label: "outside", ble: -85, wifi: -75 },
      { label: "outside", ble: -80, wifi: -70 },
    ]);
    // insideMin -60 vs outsideMax -80 -> midpoint -70
    expect(s.bleRssiThreshold).toBe(-70);
    // insideMin -50 vs outsideMax -70 -> midpoint -60
    expect(s.wifiRssiThreshold).toBe(-60);
    expect(s.bleOverlap).toBe(false);
    expect(s.wifiOverlap).toBe(false);
    expect(s.insideSamples).toBe(2);
    expect(s.outsideSamples).toBe(2);
  });

  test("flags overlap when ranges cross", () => {
    const s = suggestThresholds([
      { label: "inside", ble: -80, wifi: null }, // worse than "outside"
      { label: "outside", ble: -70, wifi: null },
    ]);
    expect(s.bleOverlap).toBe(true);
    expect(s.wifiRssiThreshold).toBeNull();
  });

  test("inside-only suggests 3 dB below the weakest inside", () => {
    const s = suggestThresholds([{ label: "inside", ble: -55, wifi: -45 }]);
    expect(s.bleRssiThreshold).toBe(-58);
    expect(s.wifiRssiThreshold).toBe(-48);
  });

  test("outside-only suggests 3 dB above the strongest outside", () => {
    const s = suggestThresholds([{ label: "outside", ble: -85, wifi: null }]);
    expect(s.bleRssiThreshold).toBe(-82);
  });

  test("is only 'sufficient' with >=3 samples on each side", () => {
    const two = suggestThresholds([
      { label: "inside", ble: -50, wifi: null },
      { label: "inside", ble: -51, wifi: null },
      { label: "outside", ble: -80, wifi: null },
      { label: "outside", ble: -81, wifi: null },
    ]);
    expect(two.sufficient).toBe(false);
    const three = suggestThresholds([
      { label: "inside", ble: -50, wifi: null },
      { label: "inside", ble: -51, wifi: null },
      { label: "inside", ble: -52, wifi: null },
      { label: "outside", ble: -80, wifi: null },
      { label: "outside", ble: -81, wifi: null },
      { label: "outside", ble: -82, wifi: null },
    ]);
    expect(three.sufficient).toBe(true);
  });
});

describe("adaptiveThreshold", () => {
  test("falls back to the session threshold with no baseline", () => {
    expect(adaptiveThreshold(-55, null)).toBe(-55);
  });

  test("falls back when the phone never reached the threshold", () => {
    // -65 is weaker than -55, so it isn't a trusted in-room baseline.
    expect(adaptiveThreshold(-55, -65)).toBe(-55);
  });

  test("loosens once the phone has been seen at the threshold", () => {
    // Reached -55 → allow down to -67 (its own signal minus the margin).
    expect(adaptiveThreshold(-55, -55)).toBe(-67);
  });

  test("never makes the boundary stricter than the session value", () => {
    // A very strong baseline must not push the threshold above -55.
    expect(adaptiveThreshold(-55, -20)).toBe(-55);
  });

  test("the floor caps how far the boundary may drop", () => {
    // Baseline at -20 would allow -32, but a 5 dB floor clamps it to -25.
    expect(adaptiveThreshold(-20, -20)).toBe(-32);
    expect(adaptiveThreshold(-20, -20, { floorOffsetDb: 5 })).toBe(-25);
  });
});

describe("dwellUpdate", () => {
  const base: DwellState = {
    inRoom: false,
    since: 0,
    lastSeen: 0,
    rawInRoom: false,
  };

  test("first sample adopts the raw verdict", () => {
    expect(dwellUpdate(undefined, true, 100).inRoom).toBe(true);
    expect(dwellUpdate(undefined, false, 100).inRoom).toBe(false);
  });

  test("enters only after the hold time", () => {
    // raw flips true at t=1000
    let s = dwellUpdate(base, true, 1000, { enterMs: 10_000, exitMs: 30_000 });
    expect(s.inRoom).toBe(false);
    s = dwellUpdate(s, true, 6000, { enterMs: 10_000, exitMs: 30_000 });
    expect(s.inRoom).toBe(false);
    s = dwellUpdate(s, true, 11_000, { enterMs: 10_000, exitMs: 30_000 });
    expect(s.inRoom).toBe(true);
  });

  test("enterMs=0 flips immediately on a raw change", () => {
    const s = dwellUpdate(base, true, 1000, { enterMs: 0, exitMs: 0 });
    expect(s.inRoom).toBe(true);
    const back = dwellUpdate(s, false, 2000, { enterMs: 0, exitMs: 0 });
    expect(back.inRoom).toBe(false);
  });

  test("a brief flip resets the hold timer", () => {
    let s = dwellUpdate(base, true, 1000, { enterMs: 10_000, exitMs: 30_000 });
    s = dwellUpdate(s, false, 5000, { enterMs: 10_000, exitMs: 30_000 });
    s = dwellUpdate(s, true, 8000, { enterMs: 10_000, exitMs: 30_000 });
    s = dwellUpdate(s, true, 12_000, { enterMs: 10_000, exitMs: 30_000 });
    expect(s.inRoom).toBe(false); // only 4 s since the last flip
  });

  test("exits only after the exit hold time", () => {
    const inRoom: DwellState = { inRoom: true, since: 0, lastSeen: 0, rawInRoom: true };
    let s = dwellUpdate(inRoom, false, 1000, { enterMs: 10_000, exitMs: 30_000 });
    expect(s.inRoom).toBe(true);
    s = dwellUpdate(s, false, 31_000, { enterMs: 10_000, exitMs: 30_000 });
    expect(s.inRoom).toBe(false);
  });
});
