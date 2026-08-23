/** Shared app settings shape — used by App.tsx, SmokeScreen, and controllers. */
export interface Settings {
  roomId: string;
  sessionId: string;
  soshinSsid: string;
  /** WPA passphrase of the Soshin hotspot (empty = open network). */
  soshinPass?: string;
  secret: string; // shared rolling-code secret (Soshin side + server session)
}

export const DEFAULT_SETTINGS: Settings = {
  roomId: "room-1",
  sessionId: "sess-1",
  soshinSsid: "Shusseki-1",
  soshinPass: "",
  secret: "change-me-shared-secret",
};

export const SERVER_URL =
  (process.env.EXPO_PUBLIC_SERVER_URL as string | undefined) ??
  "http://10.0.2.2:8787";
