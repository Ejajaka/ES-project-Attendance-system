/**
 * Local presence rule for the carried phone.
 *
 * Walk tests showed two different noise profiles:
 * - WiFi updates fast but spikes; use a rolling average.
 * - BLE is delayed (5 s scan) but steadier; use the latest reading.
 *
 * The phone is marked ABSENT only when BOTH channels are weak. Either channel
 * being strong (or unknown) keeps it present, so a single bad WiFi spike does
 * not flip the verdict.
 */

/** A WiFi average weaker (more negative) than this is "weak". */
export const WIFI_PRESENT_RSSI = -55;
/** A BLE reading weaker (more negative) than this is "weak". */
export const BLE_PRESENT_RSSI = -65;

export interface SignalPresenceInput {
  /** Rolling-average WiFi RSSI (dBm); null when there are no recent samples. */
  avgWifi: number | null;
  /** Latest BLE RSSI (dBm); null when no beacon is seen. */
  ble: number | null;
  wifiThreshold?: number;
  bleThreshold?: number;
}

export interface SignalPresenceVerdict {
  present: boolean;
  /** True when WiFi is missing or weaker than the threshold. */
  wifiWeak: boolean;
  /** True when BLE is missing or weaker than the threshold. */
  bleWeak: boolean;
}

export function signalPresence(input: SignalPresenceInput): SignalPresenceVerdict {
  const wifiThreshold = input.wifiThreshold ?? WIFI_PRESENT_RSSI;
  const bleThreshold = input.bleThreshold ?? BLE_PRESENT_RSSI;
  const wifiWeak = input.avgWifi == null || input.avgWifi < wifiThreshold;
  const bleWeak = input.ble == null || input.ble < bleThreshold;
  return { present: !(wifiWeak && bleWeak), wifiWeak, bleWeak };
}

/** Mean of the newest `window` finite samples, or null when there are none. */
export function averageRecent(samples: readonly number[], window = 5): number | null {
  const finite = samples.filter((v) => Number.isFinite(v));
  if (!finite.length) return null;
  const slice = finite.slice(-Math.max(1, window));
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}
