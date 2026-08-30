/** Shared app settings shape — used by App.tsx, SmokeScreen, and controllers. */
export interface Settings {
  /** Fusion-server base URL. Editable on-device so a super-user can point a
   * phone at any host (adb reverse => http://localhost:8787, LAN IP for a
   * second phone) without rebuilding. */
  serverUrl: string;
  roomId: string;
  sessionId: string;
  soshinSsid: string;
  /** WPA passphrase of the Soshin hotspot (empty = open network). */
  soshinPass?: string;
  secret: string; // shared rolling-code secret (Soshin side + server session)
}

export const SERVER_URL =
  (process.env.EXPO_PUBLIC_SERVER_URL as string | undefined) ??
  "http://10.0.2.2:8787";

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: SERVER_URL,
  roomId: "room-1",
  sessionId: "sess-1",
  soshinSsid: "Shusseki-1",
  soshinPass: "",
  secret: "change-me-shared-secret",
};