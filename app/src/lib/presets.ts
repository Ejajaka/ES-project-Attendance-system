import { ATLAS_SSID, SERVER_URL, type Settings } from "../settings";

/**
 * Preset rooms: three fixed room identities. The host (transmitter) and every
 * phone (receiver) pick the same preset, which pins roomId, sessionId, and
 * rolling-code secret — no manual room/session setup.
 *
 * WiFi is no longer per-session: every room rides the same fixed open
 * `atlas` network (the ESP32 room-node softAP, no password). The preset SSID
 * is kept only so CONFIG shows the right default.
 */
export type PresetId = "1" | "2" | "3";

export interface RoomPreset {
  id: PresetId;
  /** Console title, e.g. "ROOM 01". */
  name: string;
  jp: string;
  roomId: string;
  sessionId: string;
  ssid: string;
  secret: string;
}

export const ROOM_PRESETS: RoomPreset[] = [
  {
    id: "1",
    name: "ROOM 01",
    jp: "第一室",
    roomId: "room-1",
    sessionId: "sess-1",
    ssid: ATLAS_SSID,
    secret: "shusseki-preset-1-secret",
  },
  {
    id: "2",
    name: "ROOM 02",
    jp: "第二室",
    roomId: "room-2",
    sessionId: "sess-2",
    ssid: ATLAS_SSID,
    secret: "shusseki-preset-2-secret",
  },
  {
    id: "3",
    name: "ROOM 03",
    jp: "第三室",
    roomId: "room-3",
    sessionId: "sess-3",
    ssid: ATLAS_SSID,
    secret: "shusseki-preset-3-secret",
  },
];

export function presetById(id: PresetId): RoomPreset {
  const preset = ROOM_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`unknown preset: ${id}`);
  return preset;
}

/** Return a copy of `settings` bound to the chosen preset room. */
export function applyPreset(settings: Settings, id: PresetId): Settings {
  const p = presetById(id);
  return {
    ...settings,
    presetId: p.id,
    roomId: p.roomId,
    sessionId: p.sessionId,
    soshinSsid: p.ssid,
    secret: p.secret,
  };
}

export const DEFAULT_SETTINGS: Settings = applyPreset(
  {
    serverUrl: SERVER_URL,
    presetId: "1",
    roomId: "",
    sessionId: "",
    soshinSsid: "",
    soshinPass: "",
    secret: "",
    studentId: "",
    studentName: "",
  },
  "1",
);
