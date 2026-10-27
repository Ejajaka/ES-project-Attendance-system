import { requireNativeModule } from "expo";

export interface NativeWifiObservation {
  connectedToSoshin: boolean;
  /** True when the transmitter's AP is visible in a scan (may be unassociated). */
  soshinVisible?: boolean;
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
 * Jushin: connect to the Soshin hotspot / local network. The passphrase is
 * required for WPA2 local-only hotspots; omit it for open networks.
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
 * Soshin: raise a LocalOnlyHotspot and return its SSID + passphrase.
 * Fails with a native error when another hotspot is active or permissions
 * are missing (location / nearby-devices).
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
