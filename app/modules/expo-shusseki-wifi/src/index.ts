import { requireNativeModule } from "expo";

export interface NativeWifiObservation {
  connectedToSoshin: boolean;
  soshinRssi: number | null;
  ssid: string | null;
  bssid: string | null;
}

export interface NativeHotspotInfo {
  ssid: string | null;
  passphrase: string | null;
}

/** Shape of the bundle resolved by expo-modules-core permission requests. */
export interface NativePermissionResponse {
  status: "granted" | "denied" | "undetermined";
  granted: boolean;
  canAskAgain: boolean;
  expires: string;
}

const NativeWifi = requireNativeModule("ShussekiWifi");

/**
 * Jushin: join the room's WiFi. The room rides the fixed open `atlas` network
 * (ESP32 softAP), so pass no passphrase — the specifier matches the bare SSID.
 * A passphrase is still accepted for WPA2 fallback networks.
 */
export async function wifiConnectSoshin(
  ssid: string,
  passphrase?: string,
): Promise<boolean> {
  return NativeWifi.connectSoshin(ssid, passphrase ?? null);
}

/** Current WiFi observation of the Soshin AP (requires location enabled). */
export async function wifiGetObservation(): Promise<NativeWifiObservation> {
  return NativeWifi.getObservation();
}

/**
 * Soshin demo fallback: raise a LocalOnlyHotspot and return its SSID +
 * passphrase. In the real deployment the ESP32 room node hosts `atlas`
 * (open); this stays for the two-phone demo, where Android < 16 cannot
 * create an open fixed-SSID AP.
 */
export async function wifiStartHotspot(): Promise<NativeHotspotInfo> {
  return NativeWifi.startHotspot();
}

export async function wifiStopHotspot(): Promise<void> {
  return NativeWifi.stopHotspot();
}

export async function wifiRequestPermissionsAsync(): Promise<NativePermissionResponse> {
  return NativeWifi.requestPermissionsAsync();
}

export async function wifiGetPermissionsAsync(): Promise<NativePermissionResponse> {
  return NativeWifi.getPermissionsAsync();
}
