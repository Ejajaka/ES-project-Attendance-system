import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { NativeSensors } from "../lib/nativeSensors";
import { appendSample, type SignalSample } from "../lib/signalGraph";
import { postTelemetry } from "../lib/server";
import { SignalGraph } from "./SignalGraph";

/**
 * Live BLE/WiFi trace. Owns the 0.5 s WiFi sampler (BLE comes from the 5 s
 * presence tick via `lastBleRef`) so only this panel re-renders.
 *
 * Shared by the receiver and the calibration screen so both show the same
 * signal trace while walking the room/corridor.
 */
export function LiveSignalGraph({
  sensorsRef,
  lastBleRef,
  serverUrl,
  sessionId,
  deviceId,
  resetKey,
  onSample,
  height,
}: {
  sensorsRef: MutableRefObject<NativeSensors | null>;
  lastBleRef: MutableRefObject<number | null>;
  serverUrl: string;
  sessionId: string;
  /** Resolved report identity — null means "don't post telemetry". */
  deviceId: string | null;
  resetKey: number;
  onSample?: (wifi: number | null) => void;
  height?: number;
}) {
  const [samples, setSamples] = useState<SignalSample[]>([]);
  const busy = useRef(false);
  const onSampleRef = useRef(onSample);
  onSampleRef.current = onSample;

  useEffect(() => {
    setSamples([]);
    const id = setInterval(async () => {
      if (busy.current) return;
      const sensors = sensorsRef.current;
      if (!sensors) return;
      busy.current = true;
      try {
        const o = await sensors.wifi.observe();
        const t = Date.now();
        // Use the transmitter AP RSSI whether associated or only seen in a
        // scan (the phone stays on Shusseki-Room; `atlas` is scanned).
        const wifi =
          o.soshinRssi != null && !Number.isNaN(o.soshinRssi)
            ? o.soshinRssi
            : null;
        const ble = lastBleRef.current;
        setSamples((prev) => appendSample(prev, { t, ble, wifi }));
        onSampleRef.current?.(wifi);
        if (deviceId == null) return;
        void postTelemetry(serverUrl, sessionId, {
          deviceId,
          t,
          ble,
          wifi,
        });
      } catch {
        /* the presence loop owns failure reporting */
      } finally {
        busy.current = false;
      }
    }, 500);
    return () => clearInterval(id);
  }, [resetKey, serverUrl, sessionId, sensorsRef, lastBleRef, deviceId]);

  return <SignalGraph samples={samples} height={height} />;
}
