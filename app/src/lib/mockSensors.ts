import type {
  BleObservation,
  WifiObservation,
  UltrasonicObservation,
  BiometricCheck,
  BleNodeReading,
} from "shared";
import type { DeviceSensors, BleAdapter, WifiAdapter, UltrasonicAdapter, BiometricAdapter } from "./sensors";

/**
 * In-memory sensor stand-in. Tests set the public fields; the real app swaps in
 * native-module-backed adapters. Lets the full Soshin/Jushin logic run without
 * a device (and on Expo web).
 */
export class MockSensors implements DeviceSensors {
  bleReadings: BleNodeReading[] = [];
  wifiState: WifiObservation = { connectedToSoshin: false, soshinRssi: null };
  ultrasonicResponse: UltrasonicObservation = { received: false, valid: null, code: null };
  biometricResult: BiometricCheck = {
    performedAt: 0,
    kind: "fingerprint",
    success: true,
  };
  transmittedCodes: string[] = [];
  started = { ble: false, ultrasonic: false };
  permissionsRequested = { ble: false, wifi: false, ultrasonic: false };
  hotspot: { ssid: string; passphrase: string } | null = null;
  lastJoin: { ssid: string; passphrase?: string } | null = null;

  ble: BleAdapter = {
    start: async () => {
      this.started.ble = true;
    },
    stop: async () => {},
    observe: async (): Promise<BleObservation> => ({ readings: this.bleReadings }),
    requestPermissions: async () => {
      this.permissionsRequested.ble = true;
      return true;
    },
    getPermissions: async () => true,
  };

  wifi: WifiAdapter = {
    joinSoshin: async (ssid: string, passphrase?: string) => {
      this.lastJoin = { ssid, passphrase };
      this.wifiState = { ...this.wifiState, connectedToSoshin: true };
    },
    observe: async (): Promise<WifiObservation> => this.wifiState,
    requestPermissions: async () => {
      this.permissionsRequested.wifi = true;
      return true;
    },
    startHotspot: async () => {
      this.hotspot = { ssid: "ShussekiMock", passphrase: "mock-passphrase" };
      return this.hotspot;
    },
    stopHotspot: async () => {
      this.hotspot = null;
    },
  };

  ultrasonic: UltrasonicAdapter = {
    transmit: async (code: string) => {
      this.transmittedCodes.push(code);
    },
    listen: async (): Promise<UltrasonicObservation> => this.ultrasonicResponse,
    startListener: async () => {
      this.started.ultrasonic = true;
    },
    stopListener: async () => {},
    requestPermissions: async () => {
      this.permissionsRequested.ultrasonic = true;
      return true;
    },
    getPermissions: async () => true,
  };

  biometric: BiometricAdapter = {
    perform: async (kind): Promise<BiometricCheck> => ({
      ...this.biometricResult,
      kind,
    }),
  };
}
