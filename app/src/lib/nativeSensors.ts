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
  bleRequestPermissionsAsync,
} from "expo-shusseki-ble";
import {
  wifiConnectSoshin,
  wifiGetObservation,
  wifiStartHotspot,
  wifiStopHotspot,
  wifiRequestPermissionsAsync,
} from "expo-shusseki-wifi";
import {
  ultraTransmit,
  ultraListen,
  ultraStartListener,
  ultraStopListener,
  ultraRequestPermissionsAsync,
} from "expo-shusseki-ultrasonic";
import { bioPerform } from "expo-shusseki-biometric";

/**
 * Real sensor implementation backed by the Expo native modules. This is the
 * production adapter used on a device; MockSensors is used for tests + web.
 *
 * Observations are hardened: a single failing modality (e.g. mic permission
 * denied) degrades to a safe "nothing observed" value instead of rejecting
 * the whole attendance tick — a dead sensor must not look like an absent
 * person. Use the smoke-test screen for raw, unswallowed errors.
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
      try {
        const readings = await bleScanOnce(2000);
        return { readings };
      } catch (e) {
        console.warn("[ble] scan failed:", e);
        return { readings: [] };
      }
    },
    requestPermissions: async () => {
      return (await bleRequestPermissionsAsync()).granted;
    },
  };

  wifi: WifiAdapter = {
    joinSoshin: async (ssid: string, passphrase?: string) => {
      await wifiConnectSoshin(ssid, passphrase);
    },
    observe: async (): Promise<WifiObservation> => {
      try {
        const o = await wifiGetObservation();
        return {
          ssid: o.ssid ?? undefined,
          connectedToSoshin: o.connectedToSoshin,
          soshinRssi: o.soshinRssi,
          bssid: o.bssid ?? undefined,
        };
      } catch (e) {
        console.warn("[wifi] observation failed:", e);
        return { connectedToSoshin: false, soshinRssi: null };
      }
    },
    requestPermissions: async () => {
      return (await wifiRequestPermissionsAsync()).granted;
    },
    startHotspot: async () => {
      const h = await wifiStartHotspot();
      return { ssid: h.ssid, passphrase: h.passphrase };
    },
    stopHotspot: async () => {
      await wifiStopHotspot();
    },
  };

  ultrasonic: UltrasonicAdapter = {
    transmit: async (code: string) => {
      await ultraTransmit(code);
    },
    listen: async (): Promise<UltrasonicObservation> => {
      try {
        const o = await ultraListen(3000);
        return {
          received: o.received,
          valid: o.valid,
          code: o.code,
          snr: o.snr ?? null,
          missReason: o.missReason ?? undefined,
        };
      } catch (e) {
        console.warn("[ultrasonic] listen failed:", e);
        // Closest existing miss-reason: we could not capture audio at all.
        return { received: false, valid: null, code: null, missReason: "service_killed" };
      }
    },
    startListener: async () => {
      await ultraStartListener();
    },
    stopListener: async () => {
      await ultraStopListener();
    },
    requestPermissions: async () => {
      return (await ultraRequestPermissionsAsync()).granted;
    },
  };

  biometric: BiometricAdapter = {
    perform: async (kind): Promise<BiometricCheck> => {
      const r = await bioPerform(kind);
      return {
        performedAt: r.performedAt,
        kind: r.kind,
        success: r.success,
        reason: r.reason ?? undefined,
      };
    },
  };
}
