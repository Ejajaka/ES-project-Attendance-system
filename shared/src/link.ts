import type { DeviceReport, Modality, Mode } from "./types";

/**
 * Link stats: a display-oriented summary of one device's connection to the
 * room transmitter across the three physical channels (BLE, WiFi, ultrasound).
 *
 * This is *not* a presence verdict — it is the "how is my signal" view shared
 * by the receiver console (its own link) and the transmitter console (every
 * reporting device's link).
 */

export type LinkState = "connected" | "degraded" | "lost";

/** One physical channel's contribution to the link. */
export interface ModalityLink {
  modality: Modality;
  state: LinkState;
  /** 0..1 signal quality — raw-channel health, not presence confidence. */
  quality: number;
  /** Raw RSSI for ble/wifi (strongest reading), else null. */
  rssi: number | null;
  /** Raw ultrasonic SNR, else null. */
  snr: number | null;
  /** Whether the channel was observed at all (null if not reported). */
  received: boolean | null;
  /** Why an ultrasonic window was missed (passthrough). */
  missReason: string | null;
  /** Console-ready reading, e.g. "-55 dBm", "heard · snr 9.0", "no signal". */
  detail: string;
}

export interface LinkSummary {
  deviceId: string;
  mode: Mode;
  at: number;
  state: LinkState;
  /** Weakest-channel quality, 0..1. */
  quality: number;
  modalities: ModalityLink[];
}

export interface LinkOptions {
  /**
   * Server-verified ultrasonic validity. When present it overrides the
   * client's self-reported `valid` — the server is the authority.
   */
  ultrasonicValid?: boolean | null;
}

/** RSSI (dBm) → 0..1 quality. -90 dBm → 0, -60 dBm → 1. */
function rssiQuality(rssi: number): number {
  return clamp01((rssi + 90) / 30);
}

/** Shared RSSI state thresholds: walkable range, weak, out of range. */
function rssiState(rssi: number): LinkState {
  if (rssi >= -75) return "connected";
  if (rssi >= -85) return "degraded";
  return "lost";
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function bleLink(report: DeviceReport): ModalityLink | null {
  if (!report.ble) return null;
  const readings = report.ble.readings;
  if (readings.length === 0) {
    return {
      modality: "ble",
      state: "lost",
      quality: 0,
      rssi: null,
      snr: null,
      received: false,
      missReason: null,
      detail: "no beacon seen",
    };
  }
  const best = readings.reduce((a, b) => (b.rssi > a.rssi ? b : a));
  return {
    modality: "ble",
    state: rssiState(best.rssi),
    quality: rssiQuality(best.rssi),
    rssi: best.rssi,
    snr: null,
    received: true,
    missReason: null,
    detail: `${best.rssi} dBm · ${best.nodeId}`,
  };
}

function wifiLink(report: DeviceReport): ModalityLink | null {
  if (!report.wifi) return null;
  const w = report.wifi;
  if (!w.connectedToSoshin) {
    return {
      modality: "wifi",
      state: "lost",
      quality: 0,
      rssi: null,
      snr: null,
      received: false,
      missReason: null,
      detail: "not joined",
    };
  }
  // Joined but RSSI unknown: the link exists, quality is unknowable.
  if (w.soshinRssi == null || Number.isNaN(w.soshinRssi)) {
    return {
      modality: "wifi",
      state: "connected",
      quality: 0.5,
      rssi: null,
      snr: null,
      received: true,
      missReason: null,
      detail: "joined · rssi unknown",
    };
  }
  return {
    modality: "wifi",
    // A joined association proves the link exists; very weak RSSI can only
    // degrade it, never mark it lost.
    state: w.soshinRssi >= -75 ? "connected" : "degraded",
    quality: rssiQuality(w.soshinRssi),
    rssi: w.soshinRssi,
    snr: null,
    received: true,
    missReason: null,
    detail: `${w.soshinRssi} dBm`,
  };
}

function ultrasonicLink(
  report: DeviceReport,
  opts: LinkOptions,
): ModalityLink | null {
  if (!report.ultrasonic) return null;
  const u = report.ultrasonic;
  if (!u.received) {
    const reason = u.missReason ?? "no_signal";
    return {
      modality: "ultrasonic",
      state: "lost",
      quality: 0,
      rssi: null,
      snr: u.snr ?? null,
      received: false,
      missReason: reason,
      detail: `not heard · ${reason}`,
    };
  }
  const valid = opts.ultrasonicValid ?? u.valid ?? null;
  if (valid === false) {
    return {
      modality: "ultrasonic",
      state: "degraded",
      quality: 0.4,
      rssi: null,
      snr: u.snr ?? null,
      received: true,
      missReason: u.missReason ?? null,
      detail: "heard · code REJECTED",
    };
  }
  const quality = u.snr != null ? clamp01(0.6 + u.snr / 25) : 0.8;
  return {
    modality: "ultrasonic",
    state: "connected",
    quality,
    rssi: null,
    snr: u.snr ?? null,
    received: true,
    missReason: u.missReason ?? null,
    detail: u.snr != null ? `heard · snr ${u.snr.toFixed(1)}` : "heard",
  };
}

function overallState(modalities: ModalityLink[]): LinkState {
  if (modalities.length === 0) return "lost";
  if (modalities.every((m) => m.state === "lost")) return "lost";
  if (modalities.some((m) => m.state !== "connected")) return "degraded";
  return "connected";
}

/**
 * Summarize a report into connection stats. Only reported modalities appear;
 * a device that chose not to report a channel is not penalized for it.
 */
export function summarizeLink(
  report: DeviceReport,
  opts: LinkOptions = {},
): LinkSummary {
  const modalities = [
    bleLink(report),
    wifiLink(report),
    ultrasonicLink(report, opts),
  ].filter((m): m is ModalityLink => m != null);

  const quality =
    modalities.length === 0
      ? 0
      : Math.min(...modalities.map((m) => m.quality));

  return {
    deviceId: report.deviceId,
    mode: report.mode,
    at: report.timestamp,
    state: overallState(modalities),
    quality,
    modalities,
  };
}
