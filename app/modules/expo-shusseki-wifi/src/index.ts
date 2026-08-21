import { requireNativeModule } from "expo";

export interface NativeWifiObservation {
  connectedToSoshin: boolean;
  soshinRssi: number | null;
  ssid: string | null;
  bssid: string | null;
}

const NativeWifi = requireNativeModule("ShussekiWifi");

/** Jushin: connect to the Soshin hotspot / local network. */
export async function wifiConnectSoshin(ssid: string): Promise<boolean> {
  return NativeWifi.connectSoshin(ssid);
}

/** Current WiFi observation of the Soshin AP (requires location enabled). */
export async function wifiGetObservation(): Promise<NativeWifiObservation> {
  return NativeWifi.getObservation();
}
