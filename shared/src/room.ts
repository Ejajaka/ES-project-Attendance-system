import type { DeviceReport } from "./types";

/**
 * Room-bounded presence from BLE + WiFi (see docs/test-protocol.md).
 *
 * A device is "in the room" when it is close enough to the room's transmitter.
 * BLE is the authoritative channel: when the room node is heard at all, its
 * verdict wins, so a far-away WiFi hit can't mask a weak BLE reading. WiFi is
 * only a fallback when the phone is *associated* to the room AP and heard
 * nothing from the node (Bluetooth off, or a missed scan) — a scan alone is
 * not trusted, since a strong AP is visible through walls from far away.
 *
 * Thresholds are calibrated by walking the room vs the corridor. They are
 * heuristics, not security boundaries.
 */

export const ROOM_BLE_RSSI_THRESHOLD = -70; // dBm
export const ROOM_WIFI_RSSI_THRESHOLD = -65; // dBm

/** A stale device (no report for this long) is no longer in the room. */
export const ROOM_TTL_MS = 30_000;
/** Must hold "in room" this long before we mark present (anti-flap). */
export const ROOM_ENTER_MS = 10_000;
/** Must hold "out" this long before we mark absent. */
export const ROOM_EXIT_MS = 30_000;

/** How far below a phone's own best in-room RSSI counts as "outside". */
export const ROOM_BASELINE_MARGIN_DB = 12;
/** Calibration boundary = strongest outside reading + this little margin. */
export const CALIBRATION_OUTSIDE_MARGIN_DB = 3;

/**
 * A baseline only becomes a per-device anchor once the phone has actually
 * reached the calibrated threshold (proof it was inside at least once).
 * Phones that never get that close keep the calibrated value.
 */
export const ROOM_BASELINE_SLACK_DB = 0;

export interface AdaptiveOptions {
  marginDb?: number;
  validitySlackDb?: number;
  /** How far the adaptive threshold may drop below the session threshold. */
  floorOffsetDb?: number;
}

/**
 * Per-device adaptive threshold. Absolute RSSI varies by phone (antennas), so
 * once this device has reached the calibrated threshold, anchor to its own
 * strongest in-room signal and allow a margin of drop. A phone that never got
 * that close keeps the calibrated value, so a corridor start isn't accepted.
 * Never loosens beyond `floorOffsetDb`.
 */
export function adaptiveThreshold(
  sessionThreshold: number,
  baseline: number | null,
  options: AdaptiveOptions = {},
): number {
  const margin = options.marginDb ?? ROOM_BASELINE_MARGIN_DB;
  const slack = options.validitySlackDb ?? ROOM_BASELINE_SLACK_DB;
  const floor = sessionThreshold - (options.floorOffsetDb ?? 30);
  if (baseline == null || baseline < sessionThreshold - slack) {
    return sessionThreshold;
  }
  // Only loosen for weak devices; never make it stricter than the session value.
  return Math.max(floor, Math.min(sessionThreshold, baseline - margin));
}

export interface RoomChannel {
  inRoom: boolean;
  /** Strongest BLE RSSI from the room node, or WiFi RSSI (null if unknown). */
  rssi: number | null;
  threshold: number;
}

export interface RoomPresence {
  ble: RoomChannel;
  wifi: RoomChannel & { connected: boolean };
  /** Either channel says "in room". */
  inRoom: boolean;
}

export interface RoomOptions {
  /** Only count BLE readings from this transmitter node id (e.g. "esp32-tx1"). */
  roomNodeId?: string;
  bleRssiThreshold?: number;
  wifiRssiThreshold?: number;
}

/** Compute the per-channel and combined in-room verdict for one report. */
export function roomPresence(
  report: Pick<DeviceReport, "ble" | "wifi">,
  options: RoomOptions = {},
): RoomPresence {
  const bleThreshold = options.bleRssiThreshold ?? ROOM_BLE_RSSI_THRESHOLD;
  const wifiThreshold = options.wifiRssiThreshold ?? ROOM_WIFI_RSSI_THRESHOLD;

  const readings = report.ble?.readings ?? [];
  const roomReadings = options.roomNodeId
    ? readings.filter((r) => r.nodeId === options.roomNodeId)
    : readings;
  const bestBle = roomReadings.reduce<number | null>(
    (best, r) => (best == null || r.rssi > best ? r.rssi : best),
    null,
  );
  const bleInRoom = bestBle != null && bestBle >= bleThreshold;

  const connected = report.wifi?.connectedToSoshin ?? false;
  // Threshold-only rule: a scanned room AP counts too (the phone normally
  // stays on the PC hotspot), so use visibility OR association.
  const visible = report.wifi?.soshinVisible ?? connected;
  const wifiRssi = report.wifi?.soshinRssi ?? null;
  const wifiInRoom = visible && wifiRssi != null && wifiRssi >= wifiThreshold;

  return {
    ble: { inRoom: bleInRoom, rssi: bestBle, threshold: bleThreshold },
    wifi: {
      inRoom: wifiInRoom,
      rssi: wifiRssi,
      threshold: wifiThreshold,
      connected,
    },
    // Calibrated threshold only: above either channel's boundary = in room.
    inRoom: bleInRoom || wifiInRoom,
  };
}

/** Dwell/hysteresis state for one device. */
export interface DwellState {
  /** Debounced in-room verdict used for attendance. */
  inRoom: boolean;
  /** When the raw verdict last changed. */
  since: number;
  lastSeen: number;
  /** Latest raw verdict (before dwell). */
  rawInRoom: boolean;
}

export interface DwellOptions {
  enterMs?: number;
  exitMs?: number;
}

/** One calibration reading, labelled by where the phone was standing. */
export interface CalibrationPoint {
  label: "inside" | "outside";
  ble: number | null;
  wifi: number | null;
}

export interface ThresholdSuggestion {
  bleRssiThreshold: number | null;
  wifiRssiThreshold: number | null;
  /** True when inside/outside ranges overlap (weak calibration). */
  bleOverlap: boolean;
  wifiOverlap: boolean;
  insideSamples: number;
  outsideSamples: number;
  /** Enough samples on both sides to trust the suggestion (>=3 each). */
  sufficient: boolean;
}

/** Linear-interpolated percentile of a sorted array (p in 0..1). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function suggestOne(values: {
  inside: number[];
  outside: number[];
}): { threshold: number | null; overlap: boolean } {
  const insideMin = values.inside.length ? Math.min(...values.inside) : null;
  // Calibration rule requested for the room: put the boundary a little above
  // the strongest outside reading (the "lowest signal" that was still outside),
  // so every calibrated outside point is rejected. No midpoint guessing.
  if (values.outside.length > 0) {
    const outsideStrongest = Math.max(...values.outside);
    const threshold = Math.round(
      outsideStrongest + CALIBRATION_OUTSIDE_MARGIN_DB,
    );
    return {
      threshold,
      overlap: insideMin != null && insideMin <= threshold,
    };
  }
  if (insideMin != null) {
    return {
      threshold: Math.round(insideMin - CALIBRATION_OUTSIDE_MARGIN_DB),
      overlap: false,
    };
  }
  return { threshold: null, overlap: false };
}

/**
 * Suggest BLE/WiFi thresholds from labelled calibration points.
 * RSSI is negative (higher = closer), so "inside" should be above "outside".
 */
export function suggestThresholds(points: CalibrationPoint[]): ThresholdSuggestion {
  const inside = points.filter((p) => p.label === "inside");
  const outside = points.filter((p) => p.label === "outside");

  const ble = suggestOne({
    inside: inside.map((p) => p.ble).filter((v): v is number => v != null),
    outside: outside.map((p) => p.ble).filter((v): v is number => v != null),
  });
  const wifi = suggestOne({
    inside: inside.map((p) => p.wifi).filter((v): v is number => v != null),
    outside: outside.map((p) => p.wifi).filter((v): v is number => v != null),
  });

  return {
    bleRssiThreshold: ble.threshold,
    wifiRssiThreshold: wifi.threshold,
    bleOverlap: ble.overlap,
    wifiOverlap: wifi.overlap,
    insideSamples: inside.length,
    outsideSamples: outside.length,
    sufficient: inside.length >= 3 && outside.length >= 3,
  };
}

/** Fold a raw verdict into a dwelled one: a device must stay in-room for
 * `enterMs` before being marked present, and out for `exitMs` before absent.
 * The very first sample adopts the raw verdict immediately.
 */
export function dwellUpdate(
  prev: DwellState | undefined,
  rawInRoom: boolean,
  at: number,
  options: DwellOptions = {},
): DwellState {
  const enterMs = options.enterMs ?? ROOM_ENTER_MS;
  const exitMs = options.exitMs ?? ROOM_EXIT_MS;

  if (!prev) {
    return { inRoom: rawInRoom, since: at, lastSeen: at, rawInRoom };
  }
  if (rawInRoom !== prev.rawInRoom) {
    // Raw flipped: restart the dwell timer. If the hold is zero, adopt at once.
    const hold = rawInRoom ? enterMs : exitMs;
    return {
      inRoom: hold === 0 ? rawInRoom : prev.inRoom,
      since: at,
      lastSeen: at,
      rawInRoom,
    };
  }

  const held = at - prev.since;
  let inRoom = prev.inRoom;
  if (rawInRoom && !prev.inRoom && held >= enterMs) inRoom = true;
  if (!rawInRoom && prev.inRoom && held >= exitMs) inRoom = false;

  return { inRoom, since: prev.since, lastSeen: at, rawInRoom };
}
