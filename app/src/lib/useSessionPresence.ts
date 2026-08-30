import { useEffect, useRef, useState } from "react";
import { fetchSessionPresence, type ServerPresence } from "./server";

/**
 * Polls `GET /api/sessions/:id/presence` on an interval while `active` is
 * true — the super-user's room monitor showing every device the server has
 * seen, not just this phone.
 */
export function useSessionPresence(serverUrl: string, sessionId: string, active: boolean, intervalMs = 4000) {
  const [devices, setDevices] = useState<ServerPresence[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;

    const poll = async () => {
      if (!active || cancelled || !mounted.current) return;
      const [d, err] = await fetchSessionPresenceSafe(serverUrl, sessionId);
      if (!cancelled && mounted.current) {
        setDevices(d);
        setLastError(err);
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

  return { devices, lastError };
}

async function fetchSessionPresenceSafe(
  serverUrl: string,
  sessionId: string,
): Promise<[ServerPresence[], string | null]> {
  try {
    const d = await fetchSessionPresence(serverUrl, sessionId);
    return [d, null];
  } catch (e) {
    return [[], e instanceof Error ? e.message : "fetch failed"];
  }
}