import type { CombiningRule } from "./types";

/**
 * Per-modality presence confidence in [0,1]. Each function maps raw sensor
 * observations to a probability that the device is "in the room". These are
 * research-tunable heuristics, not security boundaries.
 */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const logistic = (x: number) => 1 / (1 + Math.exp(-x));

export interface BleConfidenceInput {
  readings: { nodeId: string; rssi: number }[];
  rule?: CombiningRule; // default "max"
  rssiThreshold?: number; // default -70 dBm
  rssiScale?: number; // default 10 dBm
}

/** Map one node's RSSI to [0,1]; 0.5 at threshold, rising with signal. */
function nodeConfidence(rssi: number, threshold: number, scale: number): number {
  return logistic((rssi - threshold) / scale);
}

/**
 * BLE-only confidence. With several nodes per room, the combining `rule`
 * decides what the number means (see PLAN.md open questions): `max`/`best`
 * treat any strong node as "within walkable distance"; `avg` is stricter.
 */
export function bleConfidence(input: BleConfidenceInput): number {
  const rule = input.rule ?? "max";
  const threshold = input.rssiThreshold ?? -70;
  const scale = input.rssiScale ?? 10;

  if (input.readings.length === 0) return 0;
  const perNode = input.readings.map((r) =>
    nodeConfidence(r.rssi, threshold, scale),
  );

  switch (rule) {
    case "max":
      return clamp01(Math.max(...perNode));
    case "best":
      // "best single node" == node with highest RSSI == max for a monotonic map
      return clamp01(Math.max(...perNode));
    case "avg":
      return clamp01(perNode.reduce((a, b) => a + b, 0) / perNode.length);
  }
}

export interface WifiConfidenceInput {
  connectedToSoshin: boolean;
  soshinRssi: number | null;
  rssiThreshold?: number; // default -65 dBm
  rssiScale?: number; // default 10 dBm
}

/** WiFi-only confidence from Soshin hotspot association + signal strength. */
export function wifiConfidence(input: WifiConfidenceInput): number {
  const threshold = input.rssiThreshold ?? -65;
  const scale = input.rssiScale ?? 10;

  if (input.connectedToSoshin) {
    if (input.soshinRssi == null) return 0.9;
    return clamp01(0.8 + 0.19 * logistic((input.soshinRssi - threshold) / scale));
  }
  if (input.soshinRssi != null) {
    return clamp01(0.7 * logistic((input.soshinRssi - threshold) / scale));
  }
  return 0.05;
}

export interface UltrasonicConfidenceInput {
  received: boolean;
  /** null = a tone was heard but could not be decoded. */
  valid: boolean | null;
}

/** Ultrasonic-only confidence. Jushin listens only; valid code is strong proof. */
export function ultrasonicConfidence(input: UltrasonicConfidenceInput): number {
  if (!input.received) return 0.05;
  if (input.valid === true) return 0.95;
  if (input.valid === false) return 0.15;
  return 0.4; // heard something but undecodable
}
