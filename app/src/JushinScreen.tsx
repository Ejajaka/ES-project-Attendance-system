import React, { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  bleConfidence,
  wifiConfidence,
  ultrasonicConfidence,
  fuse,
  decide,
  type DeviceReport,
} from "shared";
import { NativeSensors } from "./lib/nativeSensors";
import type { Settings } from "./settings";
import { JushinController, type JushinConfig } from "./lib/modes/jushin";
import { HttpReporter, type ReportResult } from "./lib/reporter";
import { ensureSession, type ServerPresence } from "./lib/server";
import { useSessionPresence } from "./lib/useSessionPresence";
import { DEVICE_ID } from "./identity";
import { VERSION } from "./version";
import { colors, MONO, spacing, text } from "./theme";
import {
  ConsoleHeader,
  Divider,
  HudButton,
  Meter,
  Panel,
  RawJson,
  StatusDot,
  ValueRow,
  toneFor,
} from "./components/hud";

const TICK_MS = 5000;

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString();
}

interface LocalConfidence {
  ble: number | null;
  wifi: number | null;
  ultrasonic: number | null;
  fused: number;
  present: boolean;
}

export default function JushinScreen({
  settings,
  serverUrl,
  onExit,
}: {
  settings: Settings;
  serverUrl: string;
  onExit: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [bio, setBio] = useState("not performed");
  const [bioOk, setBioOk] = useState<boolean | null>(null);
  const [lastReport, setLastReport] = useState<DeviceReport | null>(null);
  const [lastResult, setLastResult] = useState<ReportResult | null>(null);
  const [local, setLocal] = useState<LocalConfidence | null>(null);
  const [ticks, setTicks] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const controllerRef = useRef<JushinController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);

  const { devices } = useSessionPresence(serverUrl, settings.sessionId, running);

  const start = async () => {
    setError(null);
    try {
      const ok = await ensureSession(serverUrl, {
        sessionId: settings.sessionId,
        roomId: settings.roomId,
        secret: settings.secret,
      });
      console.log(`[jushin] session ensure: ${ok}`);

      const sensors = new NativeSensors();
      const reporter = new HttpReporter(serverUrl);
      const config: JushinConfig = {
        deviceId: DEVICE_ID,
        roomId: settings.roomId,
        sessionId: settings.sessionId,
        soshinSsid: settings.soshinSsid,
        soshinPass: settings.soshinPass || undefined,
      };
      const controller = new JushinController(sensors, config, reporter);
      const b = await controller.startAttendance();
      setBio(`${b.kind} (${b.success ? "ok" : `failed: ${b.reason ?? "unknown"}`})`);
      setBioOk(b.success);
      controllerRef.current = controller;
      setRunning(true);
      setStartedAt(Date.now());

      const loop = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        try {
          const report = await controller.tick(Date.now());
          setLastReport(report);
          setLastResult(controller.lastReportResult);
          setTicks((n) => n + 1);
          setLocal(computeLocal(report));
        } catch (e) {
          console.warn("[jushin] tick failed:", e);
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          busyRef.current = false;
        }
      };
      await loop();
      intervalRef.current = setInterval(loop, TICK_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (controllerRef.current) {
      try {
        await controllerRef.current.endAttendance();
      } catch (e) {
        console.warn("[jushin] end failed:", e);
      }
    }
    controllerRef.current = null;
    setRunning(false);
    setStartedAt(null);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const uptime = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
  const sp = lastResult?.presence ?? null;
  const rtt = lastResult?.rttMs ?? null;

  return (
    <View style={styles.root}>
      <ConsoleHeader
        jp="受信"
        en="JUSHIN-LINK · PHONE RECEIVER"
        stateLabel={running ? `LINK ACTIVE · ${fmtClock(uptime)}` : "STANDBY"}
        stateTone={running ? colors.green : colors.dim}
        right={<Text style={[text.tiny, { letterSpacing: 2 }]}>{VERSION}</Text>}
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {/* 生体認証 — biometric boundary check */}
        <Panel title="BIOMETRIC / 生体認証" tone={colors.amber} accentLabel="ANTI-SPOOF">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <StatusDot tone={bioOk == null ? colors.dim : bioOk ? colors.green : colors.red} pulse={running && bioOk === true} />
            <Text style={[text.value, { color: bioOk == null ? colors.dim : bioOk ? colors.green : colors.red }]}>
              {bio}
            </Text>
          </View>
        </Panel>

        {/* 信号 — raw modalities + on-device fusion */}
        <Panel title="MODALITIES / 信号" tone={colors.purple} accentLabel="LOCAL FUSION" right={<StatusDot tone={running ? colors.green : colors.dim} pulse={running} />}>
          {!lastReport ? (
            <Text style={[text.tiny, { color: colors.faint }]}>
              No observations yet. Set Soshin SSID/pass in settings, then ENGAGE.
            </Text>
          ) : (
            <>
              <Divider label="BLE" />
              <ValueRow k="nodes" v={`${lastReport.ble?.readings.length ?? 0} seen`} />
              {lastReport.ble?.readings.map((r) => (
                <ValueRow
                  key={r.nodeId}
                  k={`  ${r.nodeId}`}
                  v={`${r.rssi} dBm${r.code ? " · code" : ""}`}
                  tone={r.rssi > -70 ? colors.green : colors.amber}
                />
              ))}
              {local?.ble != null && <Meter label="BLE confidence" value={local.ble} />}

              <Divider label="WIFI" />
              <ValueRow
                k="connected"
                v={String(lastReport.wifi?.connectedToSoshin ?? "?")}
                tone={lastReport.wifi?.connectedToSoshin ? colors.green : colors.red}
              />
              <ValueRow k="ssid" v={lastReport.wifi?.ssid ?? "—"} />
              <ValueRow k="bssid" v={lastReport.wifi?.bssid ?? "—"} />
              <ValueRow
                k="rssi"
                v={lastReport.wifi?.soshinRssi != null && !Number.isNaN(lastReport.wifi.soshinRssi) ? `${lastReport.wifi.soshinRssi} dBm` : "—"}
                tone={lastReport.wifi?.soshinRssi != null && !Number.isNaN(lastReport.wifi.soshinRssi) ? (lastReport.wifi.soshinRssi > -65 ? colors.green : colors.amber) : colors.dim}
              />
              {local?.wifi != null && <Meter label="WiFi confidence" value={local.wifi} />}

              <Divider label="ULTRASONIC" />
              <ValueRow
                k="received"
                v={String(lastReport.ultrasonic?.received ?? "?")}
                tone={lastReport.ultrasonic?.received ? colors.green : colors.red}
              />
              <ValueRow
                k="server-valid"
                v={sp?.ultrasonicServerValid == null ? "—" : String(sp.ultrasonicServerValid)}
                tone={sp?.ultrasonicServerValid ? colors.green : colors.red}
              />
              <ValueRow
                k="snr"
                v={lastReport.ultrasonic?.snr != null ? String(lastReport.ultrasonic?.snr.toFixed(1)) : "—"}
              />
              <ValueRow k="miss" v={lastReport.ultrasonic?.missReason ?? "none"} tone={lastReport.ultrasonic?.missReason ? colors.amber : colors.dim} />
              {local?.ultrasonic != null && <Meter label="Ultrasonic confidence" value={local.ultrasonic} />}

              <Divider label="FUSED (device-side)" />
              {local && (
                <>
                  <Meter label="fused confidence" value={local.fused} height={10} />
                  <ValueRow
                    k="verdict"
                    v={local.present ? "PRESENT" : "ABSENT"}
                    tone={local.present ? colors.green : colors.red}
                  />
                </>
              )}
            </>
          )}
        </Panel>

        {/* 融合サーバ — server round-trip verdict */}
        <Panel title="FUSION SERVER / 融合サーバ" tone={colors.cyan} accentLabel={`${ticks} REPORT(S)`}>
          <ValueRow k="last ingest" v={lastResult ? `sent · rtt ${rtt}ms` : "—"} tone={rtt != null && rtt > 1500 ? colors.amber : colors.green} />
          <ValueRow k="at" v={lastReport ? fmtTime(lastReport.timestamp) : "—"} />
          {sp ? (
            <>
              <Divider label="SERVER VERDICT" />
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
                <Text style={text.label}>presence</Text>
                <Text
                  style={[
                    text.big,
                    {
                      color: sp.present ? colors.green : colors.red,
                      textShadowColor: sp.present ? colors.green : colors.red,
                      textShadowRadius: 8,
                    },
                  ]}
                >
                  {sp.present ? "◆ RECOGNIZED" : "◇ ABSENT"}
                </Text>
              </View>
              <ValueRow
                k="fused"
                v={`${sp.fused.toFixed(3)}${sp.fused >= 0.5 ? " ≥" : " <"} 0.5`}
                tone={toneFor(sp.fused)}
              />
              {sp.confidences.ble != null && (
                <Meter label="  server BLE" value={sp.confidences.ble} />
              )}
              {sp.confidences.wifi != null && (
                <Meter label="  server WiFi" value={sp.confidences.wifi} />
              )}
              {sp.confidences.ultrasonic != null && (
                <Meter label="  server Ultrasonic" value={sp.confidences.ultrasonic} />
              )}
            </>
          ) : (
            <Text style={[text.tiny, { color: colors.faint }]}>
              No server verdict yet — start attendance.
            </Text>
          )}
          <RawJson data={sp} label="SERVER RESPONSE" />
          <RawJson data={lastReport} label="REPORT PAYLOAD" />
        </Panel>

        {/* 部屋監視 — every device in the room */}
        <Panel title="ROOM MONITOR / 部屋監視" tone={colors.green} accentLabel={`${devices.length} DEVICE(S)`}>
          {devices.length === 0 ? (
            <Text style={[text.tiny, { color: colors.faint }]}>
              No devices reported yet. Start attendance; the room-side Soshin will
              appear here too when it broadcasts.
            </Text>
          ) : (
            devices.map((d: ServerPresence) => (
              <ValueRow
                key={d.deviceId}
                k={`${d.present ? "●" : "○"} ${d.deviceId}${d.deviceId === DEVICE_ID ? " (ME)" : ""}`}
                v={`${d.mode} fused=${d.fused.toFixed(2)}${d.ultrasonicServerValid ? " code✓" : ""}`}
                tone={d.present ? colors.green : colors.red}
              />
            ))
          )}
        </Panel>

        {error && (
          <Panel title="FAULT / 異常" tone={colors.red} accentLabel="ERROR">
            <Text style={[text.value, { color: colors.red }]}>{error}</Text>
          </Panel>
        )}

        <View style={styles.controls}>
          {!running ? (
            <HudButton variant="primary" title="UNIT-01 ENGAGE" onPress={start} />
          ) : (
            <HudButton variant="danger" title="DISENGAGE" onPress={stop} />
          )}
          <HudButton variant="ghost" title="EXIT" onPress={onExit} />
        </View>
      </ScrollView>
    </View>
  );
}

function computeLocal(report: DeviceReport): LocalConfidence {
  const ble = report.ble ? bleConfidence({ readings: report.ble.readings }) : null;
  const wifi = report.wifi
    ? wifiConfidence({
        connectedToSoshin: report.wifi.connectedToSoshin,
        soshinRssi: report.wifi.soshinRssi,
      })
    : null;
  const ultrasonic = report.ultrasonic
    ? ultrasonicConfidence({
        received: report.ultrasonic.received,
        valid: report.ultrasonic.valid,
      })
    : null;

  const present = { ble, wifi, ultrasonic } as Record<string, number | null>;
  const confs: Partial<Record<"ble" | "wifi" | "ultrasonic", number>> = {};
  for (const k of ["ble", "wifi", "ultrasonic"] as const) {
    if (present[k] != null) confs[k] = present[k]!;
  }
  const fused = fuse(confs);
  return { ble, wifi, ultrasonic, fused, present: decide(fused) };
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.md },
  controls: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
});