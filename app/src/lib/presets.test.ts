import { test, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  ROOM_PRESETS,
  applyPreset,
  presetById,
  type PresetId,
} from "./presets";
import { ATLAS_SSID, type Settings } from "../settings";

/**
 * Preset rooms replace the old manual room/session typing: the host and every
 * phone pick one of three room presets, which fixes roomId, sessionId, and the
 * rolling-code secret so both sides match instantly. WiFi is shared — every
 * room rides the fixed open `atlas` network.
 */

test("three preset rooms share the fixed open atlas network", () => {
  expect(ROOM_PRESETS).toHaveLength(3);
  const ids = new Set(ROOM_PRESETS.map((p) => p.id));
  const rooms = new Set(ROOM_PRESETS.map((p) => p.roomId));
  const sessions = new Set(ROOM_PRESETS.map((p) => p.sessionId));
  const ssids = new Set(ROOM_PRESETS.map((p) => p.ssid));
  const secrets = new Set(ROOM_PRESETS.map((p) => p.secret));
  expect(ids.size).toBe(3);
  expect(rooms.size).toBe(3);
  expect(sessions.size).toBe(3);
  // One shared open network, not a per-room hotspot.
  expect(ssids).toEqual(new Set([ATLAS_SSID]));
  expect(secrets.size).toBe(3);
});

test("presetById finds each preset by id", () => {
  for (const p of ROOM_PRESETS) {
    expect(presetById(p.id)).toBe(p);
  }
});

test("presetById rejects an unknown id", () => {
  expect(() => presetById("9" as PresetId)).toThrow(/unknown preset/i);
});

test("applyPreset fills room, session, SSID and secret from the preset", () => {
  const base: Settings = { ...DEFAULT_SETTINGS, serverUrl: "http://host:8787" };
  const next = applyPreset(base, "2");
  const p2 = presetById("2");
  expect(next.presetId).toBe("2");
  expect(next.roomId).toBe(p2.roomId);
  expect(next.sessionId).toBe(p2.sessionId);
  expect(next.soshinSsid).toBe(p2.ssid);
  expect(next.secret).toBe(p2.secret);
  // server URL is deployment-specific and must be preserved
  expect(next.serverUrl).toBe("http://host:8787");
});

test("applyPreset does not mutate the settings it was given", () => {
  const base: Settings = { ...DEFAULT_SETTINGS };
  const before = JSON.stringify(base);
  applyPreset(base, "3");
  expect(JSON.stringify(base)).toBe(before);
});

test("default settings point at preset 1", () => {
  const p1 = presetById("1");
  expect(DEFAULT_SETTINGS.presetId).toBe("1");
  expect(DEFAULT_SETTINGS.roomId).toBe(p1.roomId);
  expect(DEFAULT_SETTINGS.sessionId).toBe(p1.sessionId);
  expect(DEFAULT_SETTINGS.soshinSsid).toBe(p1.ssid);
  expect(DEFAULT_SETTINGS.secret).toBe(p1.secret);
});
