import type {
  DeviceSensors,
  BleAdapter,
  WifiAdapter,
  BiometricAdapter,
  UltrasonicAdapter,
} from "./sensors";
import type {
  BleObservation,
  WifiObservation,
  BiometricCheck,
  UltrasonicObservation,
} from "shared";
import {
  bleAdvertise,
  bleStopAdvertise,
  bleScanOnce,
  bleRequestPermissionsAsync,
  bleGetPermissionsAsync,
  type NativeAdvertiseResult,
} from "expo-shusseki-ble";
import {
  wifiConnectSoshin,
  wifiGetObservation,
  wifiStartHotspot,
  wifiStopHotspot,
  wifiRequestPermissionsAsync,
} from "expo-shusseki-wifi";
import { bioPerform } from "expo-shusseki-biometric";
import {
  ultraListen,
  ultraRequestPermissionsAsync,
} from "expo-shusseki-ultrasonic";

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
  private _lastAdvertise: NativeAdvertiseResult | null = null;

  /** Result of the most recent Soshin BLE advertise call (diagnostics). */
  get lastAdvertise(): NativeAdvertiseResult | null {
    return this._lastAdvertise;
  }

  ble: BleAdapter = {
    start: async (mode, opts) => {
      if (mode === "soshin") {
        const r = await bleAdvertise(opts.roomId, opts.nodeId, opts.code);
        this._lastAdvertise = r;
        if (!r.started) {
          console.warn(`[ble] advertise failed errorCode=${r.errorCode}`);
        }
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
    getPermissions: async () => {
      return (await bleGetPermissionsAsync()).granted;
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
          soshinVisible: o.soshinVisible,
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

  ultrasonic: UltrasonicAdapter = {
    observe: async (timeoutMs = 1800): Promise<UltrasonicObservation> => {
      try {
        const u = await ultraListen(timeoutMs);
        return {
          received: u.received,
          valid: u.valid,
          code: u.code,
          snr: u.snr,
          missReason: u.missReason ?? undefined,
        };
      } catch (e) {
        console.warn("[ultrasonic] listen failed:", e);
        return {
          received: false,
          valid: null,
          code: null,
          snr: null,
          missReason: "service_killed",
        };
      }
    },
    requestPermissions: async () => {
      return (await ultraRequestPermissionsAsync()).granted;
    },
  };
}
