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

/**
 * The room node's own softAP address. Every room rides the fixed open `atlas`
 * network whose gateway is the ESP32 node itself (192.168.4.1). Receivers push
 * the wall clock there: the node has no NTP uplink and its rolling code is
 * only verifiable once its unix time matches the server's.
 */
export const ATLAS_NODE_URL = "http://192.168.4.1";

export const SERVER_URL =
  (process.env.EXPO_PUBLIC_SERVER_URL as string | undefined) ??
  "http://10.0.2.2:8787";
