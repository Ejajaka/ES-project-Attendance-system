import React, { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  BloomField,
  ConsoleHeader,
  Divider,
  HudButton,
  Panel,
} from "./components/hud";
import { colors, spacing, text } from "./theme";
import type { Settings } from "./settings";
import { NativeSensors } from "./lib/nativeSensors";
import { HttpReporter } from "./lib/reporter";
import { JushinController } from "./lib/modes/jushin";
import { ensureSession, fetchHotspot } from "./lib/server";
import { DEVICE_ID } from "./identity";

interface CalibrationData {
  sessionId: string;
  current: {
    roomNodeId: string | null;
    bleRssiThreshold: number;
    wifiRssiThreshold: number;
    ttlMs: number;
    enterMs: number;
    exitMs: number;
  };
  suggestion: {
    bleRssiThreshold: number | null;
    wifiRssiThreshold: number | null;
    bleOverlap: boolean;
    wifiOverlap: boolean;
    insideSamples: number;
    outsideSamples: number;
    sufficient: boolean;
  };
  samples: { label: "inside" | "outside"; ble: number | null; wifi: number | null; at: number }[];
  latest: { deviceId: string; at: number; ble: number | null; wifi: number | null; inRoom: boolean }[];
}

const fmtRssi = (v: number | null | undefined) => (v == null ? "—" : `${v} dBm`);
const REQUEST_TIMEOUT_MS = 6000;

interface ApiResult<T> {
  ok: boolean;
  status: number;
  body: T | { error?: string };
}

/**
 * In-app room-boundary calibration. Walk the phone to each spot and tap
 * MARK INSIDE / MARK OUTSIDE; the server suggests BLE/WiFi thresholds and can
 * apply them to the session. Everything happens on the phone.
 */
export default function CalibrateScreen({
  settings,
  onExit,
}: {
  settings: Settings;
  onExit: () => void;
}) {
  const [data, setData] = useState<CalibrationData | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const mounted = useRef(true);
  const ticking = useRef(false);
  const base = `${settings.serverUrl}/api/sessions/${encodeURIComponent(settings.sessionId)}`;
  const calibratorId = `calibrate-${DEVICE_ID}`;

  // Every request is bounded: a hung fetch must never freeze the buttons.
  const api = async <T,>(
    path: string,
    init?: RequestInit,
  ): Promise<ApiResult<T>> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${path}`, { ...init, signal: ctrl.signal });
      const body = (await res.json().catch(() => ({}))) as T | { error?: string };
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  };

  const refresh = async () => {
    try {
      const r = await api<CalibrationData>("/calibrate");
      if (!mounted.current) return;
      if (!r.ok) {
        setOnline(false);
        setMessage((r.body as { error?: string }).error ?? `HTTP ${r.status}`);
        return;
      }
      setData(r.body as CalibrationData);
      setOnline(true);
      setMessage(null);
      setLastSync(Date.now());
    } catch (e) {
      if (!mounted.current) return;
      setOnline(false);
      setMessage(
        e instanceof Error && e.name === "AbortError"
          ? "server timeout — check WiFi/NAT"
          : "server unreachable — check WiFi/NAT",
      );
    }
  };

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Calibration needs fresh reports from THIS phone while the screen is open,
  // so run a lightweight Jushin sensing loop (no biometric) in the background.
  useEffect(() => {
    const sensors = new NativeSensors();
    const reporter = new HttpReporter(settings.serverUrl);
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const run = async () => {
      try {
        await ensureSession(settings.serverUrl, {
          sessionId: settings.sessionId,
          roomId: settings.roomId,
          secret: settings.secret,
        });
        const announced = await fetchHotspot(settings.serverUrl, settings.sessionId);
        const ssid = announced?.ssid ?? settings.soshinSsid;
        const pass = announced?.passphrase ?? settings.soshinPass ?? undefined;
        void sensors.wifi.joinSoshin(ssid, pass).catch(() => {});
        await sensors.ble.start("jushin", { roomId: settings.roomId, nodeId: calibratorId });
        await sensors.ultrasonic.startListener();

        const controller = new JushinController(
          sensors,
          {
            deviceId: calibratorId,
            roomId: settings.roomId,
            sessionId: settings.sessionId,
            soshinSsid: ssid,
            soshinPass: pass,
          },
          reporter,
        );
        const loop = async () => {
          // Never overlap ticks (a scan can take longer than the interval).
          if (stopped || ticking.current) return;
          ticking.current = true;
          try {
            await controller.tick(Date.now());
          } catch {
            // keep sampling; the server values show the truth
          } finally {
            ticking.current = false;
          }
        };
        await loop();
        interval = setInterval(() => void loop(), 5000);
      } catch (e) {
        if (mounted.current) setMessage(e instanceof Error ? e.message : String(e));
      }
    };

    void run();
    return () => {
      stopped = true;
      if (interval) clearInterval(interval);
      void sensors.ble.stop().catch(() => {});
      void sensors.ultrasonic.stopListener().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = async (path: string, body: unknown, okLabel: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setMessage((r.body as { error?: string }).error ?? `HTTP ${r.status}`);
      } else {
        setOnline(true);
        setMessage(okLabel);
      }
    } catch (e) {
      setMessage(
        e instanceof Error && e.name === "AbortError"
          ? "server timeout — check WiFi/NAT"
          : "server unreachable — check WiFi/NAT",
      );
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const mark = (label: "inside" | "outside") =>
    void post("/calibrate", { label, deviceId: calibratorId }, `marked ${label}`);

  const ins = data?.samples.filter((s) => s.label === "inside") ?? [];
  const outs = data?.samples.filter((s) => s.label === "outside") ?? [];
  const lastVals = (arr: typeof ins) =>
    arr
      .slice(-8)
      .map((s) => `B${s.ble ?? "—"}/W${s.wifi ?? "—"}`)
      .join("  ") || "—";
  const ageStr =
    lastSync == null ? "never" : `${Math.max(0, Math.round((Date.now() - lastSync) / 1000))}s ago`;

  return (
    <View style={styles.root}>
      <BloomField a={colors.cyan} b={colors.amber} />
      <ConsoleHeader
        jp="校正"
        en="CALIBRATE · ROOM BOUNDARY"
        stateLabel={online ? `LIVE · ${ageStr}` : "OFFLINE"}
        stateTone={online ? colors.cyan : colors.red}
        right={<HudButton variant="ghost" small title="EXIT" onPress={onExit} />}
      />
      <ScrollView contentContainerStyle={styles.body}>
        {message && (
          <Text style={[text.tiny, { color: online ? colors.amber : colors.red, letterSpacing: 1 }]}>
            {message}
          </Text>
        )}

        <Panel title="CURRENT BOUNDARY" tone={colors.cyan}>
          <Text style={[text.tiny, { color: colors.dim }]}>
            ROOM NODE  {data?.current.roomNodeId ?? "(not announced)"}
          </Text>
          <Text style={[text.tiny, { color: colors.dim }]}>
            BLE ≥ {data?.current.bleRssiThreshold ?? "—"} dBm · WiFi ≥{" "}
            {data?.current.wifiRssiThreshold ?? "—"} dBm
          </Text>
          <Text style={[text.tiny, { color: colors.faint }]}>
            TTL {Math.round((data?.current.ttlMs ?? 0) / 1000)}s · enter{" "}
            {Math.round((data?.current.enterMs ?? 0) / 1000)}s · exit{" "}
            {Math.round((data?.current.exitMs ?? 0) / 1000)}s
          </Text>
        </Panel>

        <Panel title="THIS PHONE" tone={colors.green}>
          {data?.latest.find((l) => l.deviceId === calibratorId) ? (
            (() => {
              const l = data.latest.find((x) => x.deviceId === calibratorId)!;
              return (
                <Text style={[text.tiny, { color: colors.text }]}>
                  BLE {fmtRssi(l.ble)} · WiFi {fmtRssi(l.wifi)} ·{" "}
                  <Text style={{ color: l.inRoom ? colors.green : colors.red }}>
                    {l.inRoom ? "IN ROOM" : "OUTSIDE"}
                  </Text>
                </Text>
              );
            })()
          ) : (
            <Text style={[text.tiny, { color: colors.faint }]}>
              no report yet — turn on Bluetooth, join Shusseki-ESP32, wait ~5s
            </Text>
          )}
        </Panel>

        <Panel title="MARK A POSITION" tone={colors.amber}>
          <Text style={[text.tiny, { color: colors.faint, lineHeight: 15 }]}>
            Stand INSIDE the room (centre + near each wall) and tap MARK INSIDE 2–3
            times. Then step into the CORRIDOR and tap MARK OUTSIDE.
          </Text>
          <View style={styles.row}>
            <HudButton title="MARK INSIDE" disabled={busy} onPress={() => mark("inside")} />
            <HudButton
              variant="danger"
              title="MARK OUTSIDE"
              disabled={busy}
              onPress={() => mark("outside")}
            />
          </View>
          <Divider label="SUGGESTION" />
          <Text style={[text.tiny, { color: colors.text }]}>
            inside {data?.suggestion.insideSamples ?? 0} · outside{" "}
            {data?.suggestion.outsideSamples ?? 0}
          </Text>
          <Text style={[text.tiny, { color: colors.text }]}>
            BLE ≥ {data?.suggestion.bleRssiThreshold ?? "—"} dBm
            {data?.suggestion.bleOverlap ? "  (OVERLAP)" : ""}
          </Text>
          <Text style={[text.tiny, { color: colors.text }]}>
            WiFi ≥ {data?.suggestion.wifiRssiThreshold ?? "—"} dBm
            {data?.suggestion.wifiOverlap ? "  (OVERLAP)" : ""}
          </Text>
          <Text style={[text.tiny, { color: colors.faint }]}>
            {data?.suggestion.sufficient
              ? "enough samples — APPLY"
              : "collect ≥3 INSIDE and ≥3 OUTSIDE samples"}
          </Text>
          <View style={styles.row}>
            <HudButton
              title="APPLY SUGGESTED"
              disabled={busy}
              onPress={() => void post("/calibrate/apply", {}, "thresholds applied")}
            />
            <HudButton
              variant="ghost"
              title="CLEAR SAMPLES"
              disabled={busy}
              onPress={() => void post("/calibrate/reset", {}, "samples cleared")}
            />
          </View>
        </Panel>

        <Panel title="SAMPLES" tone={colors.purple}>
          <Text style={[text.tiny, { color: colors.green }]}>INSIDE  {lastVals(ins)}</Text>
          <Text style={[text.tiny, { color: colors.red }]}>OUTSIDE {lastVals(outs)}</Text>
        </Panel>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: spacing.md, gap: spacing.md },
  row: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
});
