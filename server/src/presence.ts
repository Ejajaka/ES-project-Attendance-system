import {
  bleConfidence,
  wifiConfidence,
  ultrasonicConfidence,
  fuse,
  decide,
  verifyTOTP,
  type DeviceReport,
  type Modality,
  type CombiningRule,
  type Mode,
} from "shared";

/**
 * Server-side presence computation. The Server is the final authority on
 * rolling-code validity: it re-verifies the ultrasonic code against the
 * session secret rather than trusting the device's `valid` flag.
 */

export interface SessionConfig {
  sessionId: string;
  roomId: string;
  /** Shared secret the Soshin uses to broadcast the ultrasonic rolling code. */
  rollingSecret: Uint8Array;
  step?: number;
  digits?: number;
  /** Wider window tolerates clock drift + acoustic demodulation latency. */
  window?: number;
  /** BLE node-combining rule (default "max"). */
  bleRule?: CombiningRule;
  bleRssiThreshold?: number;
  wifiRssiThreshold?: number;
  combiner?: "noisy-or" | "average" | "weighted";
  weights?: Partial<Record<Modality, number>>;
  threshold?: number;
}

export interface DevicePresence {
  deviceId: string;
  mode: Mode;
  /** Per-modality confidence; key present only if the modality was reported. */
  confidences: Partial<Record<Modality, number>>;
  fused: number;
  /** Server-verified ultrasonic rolling code (null if none reported). */
  ultrasonicServerValid: boolean | null;
  present: boolean;
  timestamp: number;
}

/**
 * Re-verify the ultrasonic rolling code on the server. Returns:
 * - null if no ultrasonic observation was reported,
 * - false if nothing was received / no code / code fails verification,
 * - true if the code matches the session secret within the tolerance window.
 */
export function verifyUltrasonic(
  report: DeviceReport,
  config: SessionConfig,
): boolean | null {
  const u = report.ultrasonic;
  if (!u) return null;
  if (!u.received || !u.code) return false;
  const res = verifyTOTP(config.rollingSecret, u.code, report.timestamp, {
    step: config.step,
    digits: config.digits,
    window: config.window,
  });
  return res.valid;
}

export function computeDevicePresence(
  report: DeviceReport,
  config: SessionConfig,
): DevicePresence {
  const confidences: Partial<Record<Modality, number>> = {};

  if (report.ble) {
    confidences.ble = bleConfidence({
      readings: report.ble.readings,
      rule: config.bleRule,
    });
  }

  if (report.wifi) {
    confidences.wifi = wifiConfidence({
      connectedToSoshin: report.wifi.connectedToSoshin,
      soshinRssi: report.wifi.soshinRssi,
      rssiThreshold: config.wifiRssiThreshold,
    });
  }

  const uValid = verifyUltrasonic(report, config);
  if (report.ultrasonic) {
    confidences.ultrasonic = ultrasonicConfidence({
      received: report.ultrasonic.received,
      valid: uValid,
    });
  }

  const fused = fuse(confidences, {
    combiner: config.combiner,
    weights: config.weights,
  });

  return {
    deviceId: report.deviceId,
    mode: report.mode,
    confidences,
    fused,
    ultrasonicServerValid: uValid,
    present: decide(fused, config.threshold ?? 0.5),
    timestamp: report.timestamp,
  };
}
