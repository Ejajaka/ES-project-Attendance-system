import type {
  BleObservation,
  WifiObservation,
  UltrasonicObservation,
  BiometricCheck,
  BleNodeReading,
} from "shared";

/**
 * Platform-agnostic sensor seams. The app logic depends only on these
 * interfaces; the real implementations are backed by Expo native modules
 * (see ../modules), and MockSensors stands in for tests + Expo web dev.
 */

/** SSID + passphrase of a Soshin-hosted local-only hotspot. */
export interface HotspotInfo {
  ssid: string | null;
  passphrase: string | null;
}

export interface BleAdapter {
  /** Soshin advertises a room beacon; Jushin scans. */
  start(
    mode: "soshin" | "jushin",
    opts: { roomId: string; nodeId: string; code?: string },
  ): Promise<void>;
  stop(): Promise<void>;
  /** Snapshot of node readings currently visible to this device. */
  observe(): Promise<BleObservation>;
  /** Prompt for runtime BLE permissions; true when all are granted. */
  requestPermissions?: () => Promise<boolean>;
}

export interface WifiAdapter {
  /** Join the Soshin hotspot / local network. */
  joinSoshin(ssid: string, passphrase?: string): Promise<void>;
  /** Current WiFi observation of the Soshin AP. */
  observe(): Promise<WifiObservation>;
  /** Prompt for runtime location/nearby-devices permissions. */
  requestPermissions?: () => Promise<boolean>;
  /** Soshin-only: raise a local-only hotspot for Jushins to join. */
  startHotspot?: () => Promise<HotspotInfo>;
  stopHotspot?: () => Promise<void>;
}

export interface UltrasonicAdapter {
  /** Soshin: emit the repeating chirp presence stamp. */
  transmit(code: string): Promise<void>;
  /** Jushin: listen and decide whether the room's chirp stamp is present. */
  listen(): Promise<UltrasonicObservation>;
  startListener(): Promise<void>;
  stopListener(): Promise<void>;
  /** Prompt for the microphone permission. */
  requestPermissions?: () => Promise<boolean>;
}

export interface BiometricAdapter {
  perform(kind: "fingerprint" | "face"): Promise<BiometricCheck>;
}

export interface DeviceSensors {
  ble: BleAdapter;
  wifi: WifiAdapter;
  ultrasonic: UltrasonicAdapter;
  biometric: BiometricAdapter;
}

export type { BleNodeReading };
