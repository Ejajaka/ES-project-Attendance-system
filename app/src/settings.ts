/** Shared app settings shape — used by App.tsx, SmokeScreen, and controllers. */
export interface Settings {
  /** Fusion-server base URL. Editable on-device so a super-user can point a
   * phone at any host (adb reverse => http://localhost:8787, LAN IP for a
   * second phone) without rebuilding. */
  serverUrl: string;
  /** Which of the three preset rooms this device is bound to (see presets.ts). */
  presetId: "1" | "2" | "3";
  roomId: string;
  sessionId: string;
  /** Roll number of the student carrying this phone (attendance identity). */
  studentId: string;
  /** Full name of the student (auto-enrolls the attendance roster). */
  studentName: string;
  /** SSID to join; defaults to the fixed open `atlas` network. */
  soshinSsid: string;
  /** WPA passphrase. Empty/absent = open network (no password). */
  soshinPass?: string;
  secret: string; // shared rolling-code secret (transmitter side + server session)
}

/**
 * Fixed open WiFi network hosted by the room node (the ESP32 softAP).
 * No password: phones join it with a WifiNetworkSpecifier on the bare SSID.
 */
export const ATLAS_SSID = "atlas";

export const SERVER_URL =
  (process.env.EXPO_PUBLIC_SERVER_URL as string | undefined) ??
  "http://10.0.2.2:8787";
