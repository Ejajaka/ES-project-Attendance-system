/**
 * Server-facing types + helpers the app uses to surface "super-user"
 * diagnostics: the presence verdict the fusion server computed for a report,
 * plus the per-session monitor that lists every device in the room.
 */

import { encodeBase64Utf8, type LinkSummary } from "shared";
import { ATLAS_NODE_URL } from "../settings";

export interface ServerConfidences {
  ble?: number;
  wifi?: number;
  ultrasonic?: number;
}

/** Shape of `computeDevicePresence` echoed back by the server. */
export interface ServerPresence {
  deviceId: string;
  mode: "soshin" | "jushin";
  confidences: ServerConfidences;
  fused: number;
  /** Server re-verified the rolling code against the session secret. */
  ultrasonicServerValid: boolean | null;
  present: boolean;
  timestamp: number;
  /** Per-channel connection stats (absent when talking to an older server). */
  link?: LinkSummary;
}

/** One poll of the session roster plus how long the server took to answer. */
export interface SessionPresenceSnapshot {
  devices: ServerPresence[];
  /** HTTP round-trip of the poll (null when the server was unreachable). */
  rttMs: number | null;
}

/** `GET /api/sessions/:id/presence` — full room roster (degrades to empty). */
export async function fetchSessionPresence(
  serverUrl: string,
  sessionId: string,
): Promise<SessionPresenceSnapshot> {
  const t0 = Date.now();
  try {
    const res = await fetch(
      `${serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/presence`,
    );
    if (!res.ok) return { devices: [], rttMs: null };
    const body = (await res.json()) as { devices?: ServerPresence[] };
    return { devices: body.devices ?? [], rttMs: Date.now() - t0 };
  } catch {
    return { devices: [], rttMs: null };
  }
}

/** Hotspot announced by the room transmitter so receivers can auto-join. */
export interface HotspotAnnouncement {
  sessionId: string;
  deviceId: string;
  ssid: string;
  passphrase: string | null;
  at: number;
}

/** `GET /api/sessions/:id/hotspot` — null when unreachable/not announced. */
export async function fetchHotspot(
  serverUrl: string,
  sessionId: string,
): Promise<HotspotAnnouncement | null> {
  try {
    const res = await fetch(
      `${serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/hotspot`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { hotspot?: HotspotAnnouncement | null };
    return body.hotspot ?? null;
  } catch {
    return null;
  }
}

/** `POST /api/sessions/:id/hotspot` — publish this transmitter's live AP. */
export async function announceHotspot(
  serverUrl: string,
  sessionId: string,
  hotspot: { deviceId: string; ssid: string; passphrase?: string | null },
): Promise<boolean> {
  try {
    const res = await fetch(
      `${serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/hotspot`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: hotspot.deviceId,
          ssid: hotspot.ssid,
          passphrase: hotspot.passphrase ?? null,
        }),
      },
    );
    return res.ok || res.status === 201;
  } catch {
    return false;
  }
}

/** `POST /api/sessions` — idempotently ensure the session exists (cheap). */
export async function ensureSession(
  serverUrl: string,
  input: { sessionId: string; roomId: string; secret: string },
): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The server decodes the secret from base64; settings keep it readable.
      body: JSON.stringify({ ...input, secret: encodeBase64Utf8(input.secret) }),
    });
    return res.ok || res.status === 201;
  } catch {
    return false;
  }
}

/**
 * Pin the ESP32 room node's wall clock: `POST /api/node/time?unix=<seconds>`.
 * The node has no NTP uplink, so its rolling code is only verifiable by the
 * server once its unix time matches. Best-effort: any failure (node asleep,
 * phone not on `atlas` yet) degrades to `false`, never throws.
 */
export async function postNodeTime(nodeUrl = ATLAS_NODE_URL): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${nodeUrl}/api/node/time?unix=${Math.floor(Date.now() / 1000)}`, {
      method: "POST",
      signal: ctrl.signal,
    });
    return res.ok || res.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Push this receiver's server URL onto the node: `POST /api/node/config`. */
export async function postNodeConfig(
  serverUrl: string,
  nodeUrl = ATLAS_NODE_URL,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(
      `${nodeUrl}/api/node/config?serverUrl=${encodeURIComponent(serverUrl)}`,
      { method: "POST", signal: ctrl.signal },
    );
    return res.ok || res.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bind the phone-entered RFID UID to the student on the server at enrollment
 * time. This makes room-reader taps work even when the receiver is not running.
 * Best-effort: the offline path still has the ESP32 NVS mapping.
 */
export async function bindRfid(
  serverUrl: string,
  sessionId: string,
  input: { studentId: string; studentName: string; rfidUid: string },
): Promise<boolean> {
  try {
    const res = await fetch(
      `${serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/rfid/bind`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: input.rfidUid,
          studentId: input.studentId,
          studentName: input.studentName,
        }),
      },
    );
    return res.ok || res.status === 201;
  } catch {
    return false;
  }
}

/** `GET /api/node` — the node's self state (null when unreachable/malformed). */
export async function getSelfNode(nodeUrl = ATLAS_NODE_URL): Promise<{
  nodeId?: string;
  unix?: number;
  serverUrl?: string;
  ssid?: string;
} | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${nodeUrl}/api/node`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as {
      nodeId?: string;
      unix?: number;
      serverUrl?: string;
      ssid?: string;
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort 0.5 s graph sample (BLE/WiFi only). The presence report loop is
 * unaffected if this fails; the dashboard simply shows a gap.
 */
export async function postTelemetry(
  serverUrl: string,
  sessionId: string,
  point: { deviceId: string; t: number; ble: number | null; wifi: number | null },
): Promise<void> {
  try {
    await fetch(`${serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(point),
    });
  } catch {
    /* graph telemetry is best-effort */
  }
}
