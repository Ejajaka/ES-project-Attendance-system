import type {
  BleObservation,
  WifiObservation,
  BiometricCheck,
  BleNodeReading,
  UltrasonicObservation,
} from "shared";
import type {
  DeviceSensors,
  BleAdapter,
  WifiAdapter,
  BiometricAdapter,
  UltrasonicAdapter,
} from "./sensors";

/**
 * In-memory sensor stand-in. Tests set the public fields; the real app swaps in
 * native-module-backed adapters. Lets the full Soshin/Jushin logic run without
 * a device (and on Expo web).
 */
export class MockSensors implements DeviceSensors {
  bleReadings: BleNodeReading[] = [];
  wifiState: WifiObservation = { connectedToSoshin: false, soshinRssi: null };
  biometricResult: BiometricCheck = {
    performedAt: 0,
    kind: "fingerprint",
    success: true,
  };
  ultrasonicResult: UltrasonicObservation = {
    received: false,
    valid: null,
    code: null,
    snr: null,
    missReason: "no_signal",
  };
  started = { ble: false };
  permissionsRequested = { ble: false, wifi: false };
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

  biometric: BiometricAdapter = {
    perform: async (kind): Promise<BiometricCheck> => ({
      ...this.biometricResult,
      kind,
    }),
  };

  ultrasonic: UltrasonicAdapter = {
    observe: async (): Promise<UltrasonicObservation> => this.ultrasonicResult,
    requestPermissions: async () => true,
  };
}
