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
 * native-module-backed adapters. Lets the full Soshin/Jushin logic run in bun
 * (and on Expo web) without a device.
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

  ble: BleAdapter = {
    start: async () => {
      this.started.ble = true;
    },
    stop: async () => {},
    observe: async (): Promise<BleObservation> => ({ readings: this.bleReadings }),
  };

  wifi: WifiAdapter = {
    joinSoshin: async () => {
      this.wifiState = { ...this.wifiState, connectedToSoshin: true };
    },
    observe: async (): Promise<WifiObservation> => this.wifiState,
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
  };

  biometric: BiometricAdapter = {
    perform: async (kind): Promise<BiometricCheck> => ({
      ...this.biometricResult,
      kind,
    }),
  };
}
