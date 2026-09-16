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
  /** SSID hint; the live AutoHotspot SSID comes from the server announce. */
  soshinSsid: string;
  /** WPA passphrase of the transmitter hotspot (empty = open/discover). */
  soshinPass?: string;
  secret: string; // shared rolling-code secret (transmitter side + server session)
}

export const SERVER_URL =
  (process.env.EXPO_PUBLIC_SERVER_URL as string | undefined) ??
  "http://10.0.2.2:8787";
