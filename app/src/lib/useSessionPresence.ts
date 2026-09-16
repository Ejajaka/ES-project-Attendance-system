import { useEffect, useRef, useState } from "react";
import { fetchSessionPresence, type ServerPresence } from "./server";

/**
 * Polls `GET /api/sessions/:id/presence` on an interval while `active` is
 * true — the super-user's room monitor showing every device the server has
 * seen, not just this phone. `rttMs` is the last poll's round-trip so the
 * console can show its own uplink.
 */
export function useSessionPresence(
  serverUrl: string,
  sessionId: string,
  active: boolean,
  intervalMs = 4000,
) {
  const [devices, setDevices] = useState<ServerPresence[]>([]);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;

    const poll = async () => {
      if (!active || cancelled || !mounted.current) return;
      const snap = await fetchSessionPresence(serverUrl, sessionId);
      if (!cancelled && mounted.current) {
        setDevices(snap.devices);
        setRttMs(snap.rttMs);
        setLastError(snap.rttMs == null ? "server unreachable" : null);
      }
    };

    void poll();
    const t = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      mounted.current = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, sessionId, active, intervalMs]);

  return { devices, rttMs, lastError };
}
