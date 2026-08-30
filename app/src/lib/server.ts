/**
 * Server-facing types + helpers the app uses to surface "super-user"
 * diagnostics: the presence verdict the fusion server computed for a report,
 * plus the per-session monitor that lists every device in the room.
 */

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
}

/** `GET /api/sessions/:id/presence` — presence of every device in the room. */
export async function fetchSessionPresence(
  serverUrl: string,
  sessionId: string,
): Promise<ServerPresence[]> {
  try {
    const res = await fetch(
      `${serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/presence`,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { devices?: ServerPresence[] };
    return body.devices ?? [];
  } catch {
    return [];
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
      body: JSON.stringify(input),
    });
    return res.ok || res.status === 201;
  } catch {
    return false;
  }
}