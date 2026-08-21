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

export interface BleAdapter {
  /** Soshin advertises a room beacon; Jushin scans. */
  start(mode: "soshin" | "jushin", opts: { roomId: string; nodeId: string }): Promise<void>;
  stop(): Promise<void>;
  /** Snapshot of node readings currently visible to this device. */
  observe(): Promise<BleObservation>;
}

export interface WifiAdapter {
  /** Join the Soshin hotspot / local network. */
  joinSoshin(ssid: string): Promise<void>;
  /** Current WiFi observation of the Soshin AP. */
  observe(): Promise<WifiObservation>;
}

export interface UltrasonicAdapter {
  /** Soshin: emit the rolling-code tone. */
  transmit(code: string): Promise<void>;
  /** Jushin: listen once and return a decoded observation. */
  listen(): Promise<UltrasonicObservation>;
  startListener(): Promise<void>;
  stopListener(): Promise<void>;
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
