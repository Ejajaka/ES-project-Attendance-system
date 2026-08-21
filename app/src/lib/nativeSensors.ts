import type {
  DeviceSensors,
  BleAdapter,
  WifiAdapter,
  UltrasonicAdapter,
  BiometricAdapter,
} from "./sensors";
import type {
  BleObservation,
  WifiObservation,
  UltrasonicObservation,
  BiometricCheck,
} from "shared";
import {
  bleAdvertise,
  bleStopAdvertise,
  bleScanOnce,
} from "expo-shusseki-ble";
import { wifiConnectSoshin, wifiGetObservation } from "expo-shusseki-wifi";
import {
  ultraTransmit,
  ultraListen,
  ultraStartListener,
  ultraStopListener,
} from "expo-shusseki-ultrasonic";
import { bioPerform } from "expo-shusseki-biometric";

/**
 * Real sensor implementation backed by the Expo native modules. This is the
 * production adapter used on a device; MockSensors is used for tests + web.
 */
export class NativeSensors implements DeviceSensors {
  ble: BleAdapter = {
    start: async (mode, opts) => {
      if (mode === "soshin") {
        await bleAdvertise(opts.roomId, opts.nodeId);
      }
    },
    stop: async () => {
      await bleStopAdvertise();
    },
    observe: async (): Promise<BleObservation> => {
      const readings = await bleScanOnce(2000);
      return { readings };
    },
  };

  wifi: WifiAdapter = {
    joinSoshin: async (ssid: string) => {
      await wifiConnectSoshin(ssid);
    },
    observe: async (): Promise<WifiObservation> => {
      return wifiGetObservation().then((o) => ({
        ssid: o.ssid ?? undefined,
        connectedToSoshin: o.connectedToSoshin,
        soshinRssi: o.soshinRssi,
        bssid: o.bssid ?? undefined,
      }));
    },
  };

  ultrasonic: UltrasonicAdapter = {
    transmit: async (code: string) => {
      await ultraTransmit(code);
    },
    listen: async (): Promise<UltrasonicObservation> => {
      const o = await ultraListen(3000);
      return {
        received: o.received,
        valid: o.valid,
        code: o.code,
        snr: o.snr ?? null,
        missReason: o.missReason ?? undefined,
      };
    },
    startListener: async () => {
      await ultraStartListener();
    },
    stopListener: async () => {
      await ultraStopListener();
    },
  };

  biometric: BiometricAdapter = {
    perform: async (kind): Promise<BiometricCheck> => {
      const r = await bioPerform(kind);
      return { performedAt: r.performedAt, kind: r.kind, success: r.success };
    },
  };
}
