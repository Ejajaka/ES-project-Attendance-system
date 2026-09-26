import { z } from "zod";

/** The two runtime modes of the app (see CONTEXT.md). */
export const ModeSchema = z.enum(["soshin", "jushin"]);
export type Mode = z.infer<typeof ModeSchema>;

/** A single signal type. `fused` is derived, never reported raw. */
export const ModalitySchema = z.enum(["ble", "wifi", "ultrasonic"]);
export type Modality = z.infer<typeof ModalitySchema>;

/** How multiple BLE/WiFi node readings are merged into one Confidence. */
export const CombiningRuleSchema = z.enum(["max", "avg", "best"]);
export type CombiningRule = z.infer<typeof CombiningRuleSchema>;

/** One node's BLE reading seen by a device at a moment in time. */
export const BleNodeReadingSchema = z.object({
  nodeId: z.string(),
  rssi: z.number(), // dBm, typically negative
  timestamp: z.number().int().nonnegative().optional(), // defaults to report time
  /** Optional rolling code carried by the node's BLE advertisement (code-over-BLE). */
  code: z.string().optional(),
});
export type BleNodeReading = z.infer<typeof BleNodeReadingSchema>;

/**
 * BLE observation. `readings` are the per-node RSSI values the device can see.
 * `ownInterface` is the device's own BLE identity (used for server cross-check).
 */
export const BleObservationSchema = z.object({
  readings: z.array(BleNodeReadingSchema),
  ownInterface: z
    .object({
      mac: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
});
export type BleObservation = z.infer<typeof BleObservationSchema>;

/** WiFi observation of the Soshin hotspot / local network. */
export const WifiObservationSchema = z.object({
  ssid: z.string().optional(),
  connectedToSoshin: z.boolean(),
  soshinRssi: z.number().nullable(), // dBm, or null if AP not in range
  bssid: z.string().optional(),
});
export type WifiObservation = z.infer<typeof WifiObservationSchema>;

/** Ultrasonic observation — Jushin listens only; never transmits. */
export const UltrasonicObservationSchema = z.object({
  received: z.boolean(),
  /** True only if a valid rolling code was decoded within tolerance. */
  valid: z.boolean().nullable(),
  /** Raw decoded code, if any (for server re-verification). */
  code: z.string().nullable(),
  /** Signal-to-noise ratio estimate, if the decoder provides one. */
  snr: z.number().nullable().optional(),
  /** Why a signal was missed: service killed vs no signal vs decode failure. */
  missReason: z
    .enum(["none", "service_killed", "no_signal", "decode_failed"])
    .optional(),
});
export type UltrasonicObservation = z.infer<typeof UltrasonicObservationSchema>;

/** On-device biometric check result (supporting anti-spoofing, non-core). */
export const BiometricCheckSchema = z.object({
  performedAt: z.number().int().nonnegative(),
  kind: z.enum(["fingerprint", "face"]),
  success: z.boolean(),
  /** Why it failed/was skipped (e.g. "no biometric enrolled"); absent on success. */
  reason: z.string().optional(),
});
export type BiometricCheck = z.infer<typeof BiometricCheckSchema>;

/** Envelope a Device sends to the Server. */
export const DeviceReportSchema = z.object({
  deviceId: z.string(),
  /** Optional student identity (roll number) bound to this device. */
  studentId: z.string().optional(),
  /** Optional human name reported by the phone (auto-enrolls the roster). */
  studentName: z.string().optional(),
  mode: ModeSchema,
  roomId: z.string(),
  sessionId: z.string(),
  timestamp: z.number().int().nonnegative(),
  ble: BleObservationSchema.optional(),
  wifi: WifiObservationSchema.optional(),
  ultrasonic: UltrasonicObservationSchema.optional(),
  biometric: BiometricCheckSchema.optional(),
});
export type DeviceReport = z.infer<typeof DeviceReportSchema>;

/** Manual headcount ground truth for a session (see CONTEXT.md). */
export const GroundTruthSchema = z.object({
  sessionId: z.string(),
  roomId: z.string(),
  /** Count of people present at the reference moment. */
  headcount: z.number().int().nonnegative(),
  /** Optional per-identity linkage (deferred feature, not required for v1). */
  presentDeviceIds: z.array(z.string()).optional(),
  /** When this headcount was taken (ms epoch). */
  timestamp: z.number().int().nonnegative(),
});
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

/** Validate an untrusted DeviceReport payload (e.g. from a client). */
export function parseDeviceReport(input: unknown): DeviceReport {
  return DeviceReportSchema.parse(input);
}
