import React, { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  bleConfidence,
  wifiConfidence,
  ultrasonicConfidence,
  fuse,
  decide,
  summarizeLink,
  type DeviceReport,
  type LinkSummary,
} from "shared";
import { NativeSensors } from "./lib/nativeSensors";
import type { Settings } from "./settings";
import { presetById } from "./lib/presets";
import { JushinController, type JushinConfig } from "./lib/modes/jushin";
import { HttpReporter, type ReportResult } from "./lib/reporter";
import { ensureSession, fetchHotspot, type ServerPresence } from "./lib/server";
import { useSessionPresence } from "./lib/useSessionPresence";
import { roleLabel } from "./lib/roles";
import { formatAge, linkChips, linkGlyph, linkStateLabel, modalityLabel } from "./lib/linkView";
import { DEVICE_ID } from "./identity";
import { VERSION } from "./version";
import { colors, MONO, spacing, text } from "./theme";
import { DeviceLinkRow } from "./components/DeviceLinkRow";
import {
  AlertOverlay,
  BloomField,
  ConsoleHeader,
  Divider,
  HudButton,
  Interjection,
  Lamp,
  Meter,
  Panel,
  RawJson,
  ValueRow,
} from "./components/hud";

/** One full-screen console alert. */
interface ConsoleAlert {
  title: string;
  jp?: string;
  sub?: string;
  detail?: string;
  tone: string;
}

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
  autoEngage,
  onExit,
}: {
  settings: Settings;
  serverUrl: string;
  autoEngage?: boolean;
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
  const [alert, setAlert] = useState<ConsoleAlert | null>(null);
  const [joinSource, setJoinSource] = useState<string>("—");
  const controllerRef = useRef<JushinController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const prevVerdictRef = useRef<boolean | null>(null);

  const { devices } = useSessionPresence(serverUrl, settings.sessionId, running);

  const start = async () => {
    setError(null);
    try {
      const ok = await ensureSession(serverUrl, {
        sessionId: settings.sessionId,
        roomId: settings.roomId,
        secret: settings.secret,
      });
      console.log(`[receiver] session ensure: ${ok}`);

      // Auto-join the transmitter's live hotspot: the transmitter announces
      // the Android-generated SSID/passphrase to the session. Fall back to
      // manual CONFIG values when the announce is unreachable.
      const announced = await fetchHotspot(serverUrl, settings.sessionId);
      const ssid = announced?.ssid ?? settings.soshinSsid;
      const pass = announced?.passphrase ?? settings.soshinPass ?? undefined;
      setJoinSource(
        announced
          ? `AUTO ${announced.ssid}`
          : `MANUAL ${settings.soshinSsid}`,
      );
      console.log(`[receiver] join target ${ssid} (${announced ? "announced" : "config fallback"})`);

      const sensors = new NativeSensors();
      const reporter = new HttpReporter(serverUrl);
      const config: JushinConfig = {
        deviceId: DEVICE_ID,
        studentId: settings.studentId || undefined,
        studentName: settings.studentName || undefined,
        roomId: settings.roomId,
        sessionId: settings.sessionId,
        soshinSsid: ssid,
        soshinPass: pass,
      };
      const controller = new JushinController(sensors, config, reporter);
      const b = await controller.startAttendance();
      setBio(`${b.kind} (${b.success ? "ok" : `failed: ${b.reason ?? "unknown"}`})`);
      setBioOk(b.success);
      controllerRef.current = controller;
      setRunning(true);
      setStartedAt(Date.now());
      prevVerdictRef.current = null;

      const loop = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        try {
          const report = await controller.tick(Date.now());
          setLastReport(report);
          setLastResult(controller.lastReportResult);
          setTicks((n) => n + 1);
          setLocal(computeLocal(report));

          // Verdict flip → slam the console alert (PATTERN GREEN / TARGET LOST).
          const v = controller.lastReportResult?.presence?.present ?? null;
          const prev = prevVerdictRef.current;
          prevVerdictRef.current = v;
          if (v !== null && prev !== null && v !== prev) {
            setAlert(
              v
                ? {
                    title: "RECOGNIZED",
                    jp: "認識完了",
                    sub: "PATTERN GREEN · UNIT PRESENCE CONFIRMED",
                    detail: `fused=${controller.lastReportResult?.presence?.fused.toFixed(3)} · ultrasonicServerValid=${controller.lastReportResult?.presence?.ultrasonicServerValid}`,
                    tone: colors.green,
                  }
                : {
                    title: "TARGET LOST",
                    jp: "標的喪失",
                    sub: "PATTERN RED · UNIT PRESENCE NOT CONFIRMED",
                    detail: `fused=${controller.lastReportResult?.presence?.fused.toFixed(3)}`,
                    tone: colors.red,
                  },
            );
          }
        } catch (e) {
          console.warn("[receiver] tick failed:", e);
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          setAlert({
            title: "SENSOR FAULT",
            jp: "機器異常",
            sub: "SYNC CYCLE INTERRUPTED — CHECK MAGI LINK",
            detail: msg,
            tone: colors.red,
          });
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
        console.warn("[receiver] end failed:", e);
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

  // Headless auto-engage (deep link `shusseki://rx`) — start once on mount so
  // the receiver can be driven without UI taps.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoEngage && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEngage]);

  const uptime = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
  const sp = lastResult?.presence ?? null;
  const rtt = lastResult?.rttMs ?? null;
  const verdict = sp?.present;
  // Connection stats to the transmitter, from this phone's last report. The
  // server's verdict overrules the client's ultrasonic validity when present.
  const link: LinkSummary | null = lastReport
    ? summarizeLink(lastReport, { ultrasonicValid: sp?.ultrasonicServerValid })
    : null;
  const linkTone = !link
    ? colors.dim
    : link.state === "connected"
      ? colors.green
      : link.state === "degraded"
        ? colors.amber
        : colors.red;

  return (
    <View style={styles.root}>
      <BloomField a={colors.green} b={colors.cyan} />
      <ConsoleHeader
        jp="受信"
        en="RECEIVER · JUSHIN"
        stateLabel={running ? `LINK ACTIVE · ${fmtClock(uptime)}` : "STANDBY"}
        stateTone={running ? colors.green : colors.dim}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Text style={[text.tiny, { letterSpacing: 2 }]}>{VERSION}</Text>
            <HudButton variant="ghost" small title="EXIT" onPress={onExit} />
          </View>
        }
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        <View style={styles.cols}>
          <View style={styles.colA}>
            {/* 認識 plate — the big typographic interjection */}
            <Interjection
              text={verdict == null ? (running ? "SCANNING" : "STANDBY") : verdict ? "RECOGNIZED" : "ABSENT"}
              sub={
                verdict == null
                  ? running ? "AWAITING SYNC" : "ENGAGE TO BEGIN"
                  : sp!.fused >= 0.5 ? `AT-FIELD CONFIRMED · ${sp!.fused.toFixed(2)}` : `AT-FIELD WEAK · ${sp!.fused.toFixed(2)}`
              }
              tone={verdict == null ? (running ? colors.amber : colors.dim) : verdict ? colors.green : colors.red}
              plate={verdict == null ? false : true}
            />

            {/* AT-FIELD — device-side fused confidence */}
            <Panel title="AT-FIELD / 絶対領域" tone={colors.purple} accentLabel="DEVICE FUSION" grid>
              {local ? (
                <>
                  <Meter label="AT-FIELD STRENGTH" value={local.fused} height={12} />
                  <ValueRow
                    k="verdict"
                    v={local.present ? "IN-SYNC" : "LOST"}
                    tone={local.present ? colors.green : colors.red}
                  />
                  <ValueRow k="report #" v={String(ticks)} />
                  <ValueRow k="uptime" v={fmtClock(uptime)} />
                </>
              ) : (
                <Text style={[text.tiny, { color: colors.faint }]}>
                  No telemetry yet — ENGAGE to begin sync.
                </Text>
              )}
            </Panel>

            {/* BIOMETRIC — the entry-plug occupant check */}
            <Panel title="OCCUPANT / 搭乗者検証" tone={colors.amber} accentLabel="ANTI-SPOOF">
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <Lamp tone={bioOk == null ? colors.dim : bioOk ? colors.green : colors.red} size={7} />
                <Text style={[text.value, { color: bioOk == null ? colors.dim : bioOk ? colors.green : colors.red }]}>
                  {bio}
                </Text>
              </View>
            </Panel>

            {/* LINK — this phone's connection stats to the room transmitter */}
            <Panel
              title="LINK TO TRANSMITTER / 回線"
              tone={linkTone}
              accentLabel={link ? linkStateLabel(link.state) : "NO DATA"}
              grid
            >
              {link ? (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Lamp tone={linkTone} size={8} />
                    <Text style={[text.value, { color: linkTone, fontSize: 13 }]}>
                      {linkChips(link)} · LINK {linkStateLabel(link.state)} · {Math.round(link.quality * 100)}%
                    </Text>
                  </View>
                  <Meter label="OVERALL LINK QUALITY" value={link.quality} height={10} />
                  {link.modalities.map((m) => {
                    const mTone = m.state === "connected" ? colors.green : m.state === "degraded" ? colors.amber : colors.red;
                    return (
                      <View key={m.modality} style={{ gap: 2 }}>
                        <ValueRow
                          k={modalityLabel(m.modality)}
                          v={`${linkGlyph(m.state)} ${m.detail}`}
                          tone={mTone}
                          labelWidth={92}
                        />
                        <Meter label={`${modalityLabel(m.modality)} QUALITY`} value={m.quality} height={6} />
                      </View>
                    );
                  })}
                  <ValueRow
                    k="uplink"
                    v={rtt != null ? `server ${rtt}ms` : "—"}
                    tone={rtt != null && rtt > 1500 ? colors.amber : colors.green}
                    labelWidth={92}
                  />
                  <ValueRow k="join" v={joinSource} tone={colors.cyan} labelWidth={92} />
                </>
              ) : (
                <Text style={[text.tiny, { color: colors.faint }]}>
                  No link data yet — pick a preset and ENGAGE.
                </Text>
              )}
            </Panel>

            <View style={styles.controls}>
              {!running ? (
                <HudButton variant="primary" title="UNIT-01 ENGAGE" onPress={start} />
              ) : (
                <HudButton variant="danger" title="DISENGAGE" onPress={stop} />
              )}
              <HudButton variant="ghost" title="EXIT" onPress={onExit} />
            </View>
          </View>

          <View style={styles.colB}>
            {/* 信号 — the three sync rates, raw values + device-side confidence */}
            <Panel
              title="SYNC RATES / 信号"
              tone={colors.purple}
              accentLabel="PER-MODALITY"
              right={<Lamp tone={running ? colors.green : colors.dim} size={6} />}
            >
              {!lastReport ? (
                <Text style={[text.tiny, { color: colors.faint }]}>
                  No observations yet. Pick a room preset, then ENGAGE — the
                  transmitter's hotspot is discovered automatically.
                </Text>
              ) : (
                <View style={styles.syncRow}>
                  <View style={{ flex: 1, gap: spacing.sm }}>
                    <Divider label="BLE" />
                    <ValueRow k="nodes" v={`${lastReport.ble?.readings.length ?? 0} seen`} labelWidth={64} />
                    {lastReport.ble?.readings.map((r) => (
                      <ValueRow
                        key={r.nodeId}
                        k={`  ${r.nodeId}`}
                        v={`${r.rssi} dBm${r.code ? " · code" : ""}`}
                        tone={r.rssi > -70 ? colors.green : colors.amber}
                        labelWidth={64}
                      />
                    ))}
                    {local?.ble != null && <Meter label="SYNC RATE · BLE" value={local.ble} />}
                  </View>
                  <View style={{ flex: 1, gap: spacing.sm }}>
                    <Divider label="WIFI" />
                    <ValueRow
                      k="conn"
                      v={String(lastReport.wifi?.connectedToSoshin ?? "?")}
                      tone={lastReport.wifi?.connectedToSoshin ? colors.green : colors.red}
                      labelWidth={64}
                    />
                    <ValueRow k="ssid" v={lastReport.wifi?.ssid ?? "—"} labelWidth={64} />
                    <ValueRow k="bssid" v={lastReport.wifi?.bssid ?? "—"} labelWidth={64} />
                    <ValueRow
                      k="rssi"
                      v={lastReport.wifi?.soshinRssi != null && !Number.isNaN(lastReport.wifi.soshinRssi) ? `${lastReport.wifi.soshinRssi} dBm` : "—"}
                      tone={lastReport.wifi?.soshinRssi != null && !Number.isNaN(lastReport.wifi.soshinRssi) ? (lastReport.wifi.soshinRssi > -65 ? colors.green : colors.amber) : colors.dim}
                      labelWidth={64}
                    />
                    {local?.wifi != null && <Meter label="SYNC RATE · WIFI" value={local.wifi} />}
                  </View>
                  <View style={{ flex: 1, gap: spacing.sm }}>
                    <Divider label="ULTRA" />
                    <ValueRow
                      k="rx"
                      v={String(lastReport.ultrasonic?.received ?? "?")}
                      tone={lastReport.ultrasonic?.received ? colors.green : colors.red}
                      labelWidth={64}
                    />
                    <ValueRow
                      k="sv"
                      v={sp?.ultrasonicServerValid == null ? "—" : String(sp.ultrasonicServerValid)}
                      tone={sp?.ultrasonicServerValid ? colors.green : colors.red}
                      labelWidth={64}
                    />
                    <ValueRow
                      k="snr"
                      v={lastReport.ultrasonic?.snr != null ? String(lastReport.ultrasonic?.snr.toFixed(1)) : "—"}
                      labelWidth={64}
                    />
                    <ValueRow
                      k="miss"
                      v={lastReport.ultrasonic?.missReason ?? "none"}
                      tone={lastReport.ultrasonic?.missReason ? colors.amber : colors.dim}
                      labelWidth={64}
                    />
                    {local?.ultrasonic != null && <Meter label="SYNC RATE · ULTRA" value={local.ultrasonic} />}
                  </View>
                </View>
              )}
            </Panel>

            {/* MAGI — the server verdict */}
            <Panel title="MAGI / 融合サーバ" tone={colors.cyan} accentLabel={`${ticks} REPORT(S)`}>
              <View style={styles.syncRow}>
                <View style={{ flex: 1, gap: spacing.sm }}>
                  <ValueRow
                    k="ingest"
                    v={lastResult ? `sent · rtt ${rtt}ms` : "—"}
                    tone={rtt != null && rtt > 1500 ? colors.amber : colors.green}
                    labelWidth={72}
                  />
                  <ValueRow k="at" v={lastReport ? fmtTime(lastReport.timestamp) : "—"} labelWidth={72} />
                  {!sp && (
                    <Text style={[text.tiny, { color: colors.faint }]}>
                      No server verdict yet — ENGAGE.
                    </Text>
                  )}
                </View>
                <View style={{ flex: 2, gap: spacing.sm }}>
                  {sp && (
                    <>
                      <Meter label="FUSED (SERVER)" value={sp.fused} height={10} />
                      {sp.confidences.ble != null && <Meter label="SYNC BLE" value={sp.confidences.ble} />}
                      {sp.confidences.wifi != null && <Meter label="SYNC WIFI" value={sp.confidences.wifi} />}
                      {sp.confidences.ultrasonic != null && (
                        <Meter label="SYNC ULTRA" value={sp.confidences.ultrasonic} />
                      )}
                    </>
                  )}
                </View>
              </View>
              <RawJson data={sp} label="MAGI RESPONSE" />
              <RawJson data={lastReport} label="REPORT PAYLOAD" />
            </Panel>

            {/* 部屋監視 — every unit in the room; tap a row for its full verdict */}
            <Panel
              title="ROOM MONITOR / 部屋監視"
              tone={colors.green}
              accentLabel={`${devices.length} FOUND · ${devices.filter((d) => (d.link?.state ?? "lost") === "connected").length} LINKED`}
              grid
            >
              {devices.length === 0 ? (
                <Text style={[text.tiny, { color: colors.faint }]}>
                  No devices reported yet. Start attendance; every phone on the
                  same preset room appears here with its three-channel link.
                </Text>
              ) : (
                devices.map((d: ServerPresence) => (
                  <DeviceLinkRow
                    key={d.deviceId}
                    device={d}
                    now={Date.now()}
                    onPress={() =>
                      setAlert({
                        title: d.present ? "UNIT ACTIVE" : "UNIT INACTIVE",
                        jp: "個機状態",
                        sub: `${roleLabel(d.mode)} · ${d.deviceId}${d.deviceId === DEVICE_ID ? " (ME)" : ""}`,
                        detail: JSON.stringify(d, null, 2),
                        tone:
                          d.link?.state === "connected"
                            ? colors.green
                            : d.link?.state === "degraded"
                              ? colors.amber
                              : colors.red,
                      })
                    }
                  />
                ))
              )}
            </Panel>
          </View>
        </View>

        {error && (
          <View style={styles.cols}>
            <Panel title="FAULT / 異常" tone={colors.red} accentLabel="ERROR">
              <Text style={[text.value, { color: colors.red }]}>{error}</Text>
            </Panel>
          </View>
        )}
      </ScrollView>

      {/* Full-screen NERV alert layer — verdict flips, faults, unit introspection */}
      {alert && (
        <AlertOverlay
          title={alert.title}
          jp={alert.jp}
          sub={alert.sub}
          detail={alert.detail}
          tone={alert.tone}
          onAck={() => setAlert(null)}
        />
      )}
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
  scroll: { padding: 0, gap: 0 },
  cols: { flexDirection: "row", flexWrap: "wrap", gap: 0 },
  colA: { flex: 3, gap: 0, minWidth: 300 },
  colB: { flex: 4, gap: 0, minWidth: 300 },
  syncRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.lg },
  controls: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
  },
});