import React, { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  bleConfidence,
  wifiConfidence,
  ultrasonicConfidence,
  fuse,
  decide,
  summarizeLink,
  signalPresence,
  averageRecent,
  type DeviceReport,
  type LinkSummary,
  type BiometricCheck,
  type UltrasonicObservation,
} from "shared";
import { NativeSensors } from "./lib/nativeSensors";
import { ATLAS_SSID, type Settings } from "./settings";
import { JushinController, type JushinConfig } from "./lib/modes/jushin";
import { HttpReporter, type ReportResult } from "./lib/reporter";
import {
  bindRfid,
  ensureSession,
  postNodeConfig,
  postNodeTime,
  type ServerPresence,
} from "./lib/server";
import { useSessionPresence } from "./lib/useSessionPresence";
import { modalityLabel } from "./lib/linkView";
import { loadPersistentDeviceId } from "./lib/persistentDeviceId";
import { MONO } from "./theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  loadIdentity,
  saveIdentity,
  type StudentIdentity,
} from "./lib/identityStore";
import { JsonBlock } from "./components/JsonBlock";
import { DataRow } from "./components/DataRow";
import { DeviceLinkRow } from "./components/DeviceLinkRow";
import { LiveSignalGraph } from "./components/LiveSignalGraph";
import { logPayload } from "./components/debug/log";
import { Chevron } from "./components/Chevron";

const TICK_MS = 5000;

/**
 * Fingerprint is optional for now (the single-finger restriction is not
 * enforceable on a phone). Set to true to require it again.
 */
const BIOMETRIC_REQUIRED = true;

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

/** Inline verdict event (replaces the old full-screen alert layer). */
interface ConsoleEvent {
  text: string;
  /** Badge tone semantics: confirmed / interrupted / warning. */
  kind: "ok" | "bad" | "warn";
}

export default function JushinScreen({
  settings,
  serverUrl,
  autoEngage,
  bioSkip,
  onExit,
}: {
  settings: Settings;
  serverUrl: string;
  autoEngage?: boolean;
  /** Deep-link `?bio=0`: run headless without ever raising a biometric prompt. */
  bioSkip?: boolean;
  onExit: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [bio, setBio] = useState("not performed");
  const [bioOk, setBioOk] = useState<boolean | null>(null);
  const [lastReport, setLastReport] = useState<DeviceReport | null>(null);
  const [ultraPreview, setUltraPreview] = useState<UltrasonicObservation | null>(null);
  const [lastResult, setLastResult] = useState<ReportResult | null>(null);
  const [local, setLocal] = useState<LocalConfidence | null>(null);
  const [ticks, setTicks] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [event, setEvent] = useState<ConsoleEvent | null>(null);
  const [joinSource, setJoinSource] = useState<string>("—");
  const [selectedDevice, setSelectedDevice] = useState<ServerPresence | null>(null);
  // This phone's report identity — resolved from disk at engage time, so a
  // restart keeps reporting as the same device.
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<StudentIdentity | null>(null);
  const [enrollId, setEnrollId] = useState(settings.studentId ?? "");
  const [enrollName, setEnrollName] = useState(settings.studentName ?? "");
  const [enrollRfid, setEnrollRfid] = useState("");
  const [enrollMsg, setEnrollMsg] = useState<string | null>(null);
  const [traceReset, setTraceReset] = useState(0);
  const [signalVerdict, setSignalVerdict] = useState<boolean | null>(null);
  // 1 s ticker so "last seen Xs ago" visibly counts down while engaged.
  const [now, setNow] = useState(Date.now());
  const controllerRef = useRef<JushinController | null>(null);
  const sensorsRef = useRef<NativeSensors | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastBleRef = useRef<number | null>(null);
  const bleAtRef = useRef(0);
  const wifiHistoryRef = useRef<number[]>([]);
  const wifiAtRef = useRef(0);
  const busyRef = useRef(false);
  const prevVerdictRef = useRef<boolean | null>(null);

  const { devices } = useSessionPresence(serverUrl, settings.sessionId, running);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // First-time enrolment: roll + name are saved on this phone after a
  // successful fingerprint check, and the identity is reused forever after.
  useEffect(() => {
    void loadIdentity().then((id) => {
      if (!id) return;
      setIdentity(id);
      setEnrollId(id.studentId);
      setEnrollName(id.studentName);
      setEnrollRfid(id.rfidUid ?? "");
      console.log(
        `[identity] stored on phone: ${id.studentName} · ${id.studentId} · RFID ${id.rfidUid ?? "none"}`,
      );
    });
  }, []);

  // The phone's stored identity is the source of truth: bind its UID to the
  // server as soon as the app opens, without requiring Start attendance.
  useEffect(() => {
    if (!identity?.rfidUid) return;
    const rfidUid = identity.rfidUid;
    if (!rfidUid) return;
    const sensors = sensorsRef.current ?? new NativeSensors();
    sensorsRef.current = sensors;
    void (async () => {
      // Bind over the PC hotspot (the server's own network) first — this is
      // the reliable path. `atlas`/NAPT is only needed for room attendance.
      const bindNets = [
        { ssid: "Shusseki-Room", pass: "shusseki123" },
        {
          ssid: settings.soshinSsid || ATLAS_SSID,
          pass: settings.soshinPass || undefined,
        },
      ];
      for (const net of bindNets) {
        try {
          await sensors.wifi.joinSoshin(net.ssid, net.pass);
          break;
        } catch {
          /* try the next network */
        }
      }
      const sessionOk = await ensureSession(serverUrl, {
        sessionId: settings.sessionId,
        roomId: settings.roomId,
        secret: settings.secret,
      });
      if (!sessionOk) return;
      const bindOk = await bindRfid(serverUrl, settings.sessionId, {
        studentId: identity.studentId,
        studentName: identity.studentName,
        rfidUid,
      });
      console.log(
        `[identity] bind ${bindOk ? "ok" : "FAILED"} ${rfidUid} -> ${identity.studentName} · ${identity.studentId}`,
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.rfidUid]);

  // Live signal preview: keep the BLE/WiFi trace running even before ENGAGE.
  // WiFi is sampled by LiveSignalGraph (0.5 s); BLE is scanned here while idle.
  useEffect(() => {
    if (!sensorsRef.current) {
      sensorsRef.current = new NativeSensors();
    }
    if (running) return; // the attendance tick owns BLE scanning while running

    const sensors = sensorsRef.current;
    let cancelled = false;
    let busy = false;
    const poll = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        const o = await sensors.ble.observe();
        const best = o.readings.reduce<number | null>(
          (b, r) => (b == null || r.rssi > b ? r.rssi : b),
          null,
        );
        if (best != null) {
          lastBleRef.current = best;
          bleAtRef.current = Date.now();
        }
      } catch {
        /* preview scan is best-effort */
      } finally {
        busy = false;
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running]);

  // Standby ultrasound preview: listen even before Start so the room's
  // 20 kHz stamp is visible/detectable in the Receiver UI.
  useEffect(() => {
    if (running) return;
    const sensors = sensorsRef.current ?? new NativeSensors();
    sensorsRef.current = sensors;
    void sensors.ultrasonic?.requestPermissions?.().catch(() => {});
    let cancelled = false;
    let busy = false;
    const poll = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        const u = await sensors.ultrasonic?.observe(1200);
        if (!cancelled && u) {
          setUltraPreview(u);
          console.log(
            `[ultra] received=${u.received} valid=${u.valid} snr=${u.snr ?? "-"} miss=${u.missReason ?? "-"}`,
          );
        }
      } catch {
        /* best effort */
      } finally {
        busy = false;
      }
    };
    void poll();
    const id = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running]);

  const enroll = async () => {
    const studentId = enrollId.trim();
    const studentName = enrollName.trim();
    if (!studentId || !studentName) {
      setEnrollMsg("Enter both roll number and name.");
      return;
    }
    setEnrollMsg("Waiting for your fingerprint…");
    const sensors = new NativeSensors();
    let bio: BiometricCheck;
    try {
      bio = await Promise.race([
        sensors.biometric.perform("fingerprint"),
        new Promise<BiometricCheck>((resolve) =>
          setTimeout(
            () =>
              resolve({
                performedAt: Date.now(),
                kind: "fingerprint",
                success: false,
                reason: "timeout",
              }),
            35000,
          ),
        ),
      ]);
    } catch (e) {
      setEnrollMsg(
        `Fingerprint failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    if (!bio.success) {
      setEnrollMsg(`Fingerprint failed: ${bio.reason ?? "try again"}`);
      return;
    }
    const next = {
      studentId,
      studentName,
      rfidUid: enrollRfid.trim().toUpperCase() || undefined,
      enrolledAt: Date.now(),
    };
    try {
      await saveIdentity(next);
    } catch {
      setEnrollMsg("Could not save the identity on this phone.");
      return;
    }
    setIdentity(next);
    setBio(`${bio.kind} (ok)`);
    setBioOk(true);

    // Send the UID binding now so the room reader works without Start.
    let bound = true;
    if (next.rfidUid) {
      // Join the room network first, otherwise the server is unreachable.
      try {
        await sensors.wifi.joinSoshin(
          settings.soshinSsid || ATLAS_SSID,
          settings.soshinPass || undefined,
        );
      } catch {
        /* best effort */
      }
      const sessionOk = await ensureSession(serverUrl, {
        sessionId: settings.sessionId,
        roomId: settings.roomId,
        secret: settings.secret,
      });
      bound =
        sessionOk &&
        (await bindRfid(serverUrl, settings.sessionId, {
          studentId: next.studentId,
          studentName: next.studentName,
          rfidUid: next.rfidUid,
        }));
      setEnrollMsg(
        bound
          ? "Card saved to the server."
          : "Saved on phone; server unreachable — the card will sync when attendance starts.",
      );
    } else {
      setEnrollMsg(null);
    }
  };

  /**
   * Local absent/present rule: rolling-average WiFi (smooths spikes) AND the
   * latest BLE (delayed scan). Both weak → absent. Freshness caps stop a
   * paused sampler or a stale BLE beacon from holding "present".
   */
  const handleSignalSample = (wifi: number | null) => {
    if (wifi != null) {
      const history = wifiHistoryRef.current;
      history.push(wifi);
      if (history.length > 5) history.shift();
      wifiAtRef.current = Date.now();
    }
    const avgWifi = averageRecent(wifiHistoryRef.current, 5);
    const wifiFresh = Date.now() - wifiAtRef.current <= 3000 ? avgWifi : null;
    const bleFresh = Date.now() - bleAtRef.current <= 8000 ? lastBleRef.current : null;
    const next = signalPresence({ avgWifi: wifiFresh, ble: bleFresh }).present;
    setSignalVerdict((prev) => (prev === next ? prev : next));
  };

  const start = async () => {
    setError(null);
    setEvent(null);
    if (!identity && !bioSkip) {
      setError("Enroll your fingerprint first.");
      setEnrollMsg("Save your roll, name and fingerprint before starting.");
      return;
    }
    try {
      const ok = await ensureSession(serverUrl, {
        sessionId: settings.sessionId,
        roomId: settings.roomId,
        secret: settings.secret,
      });
      console.log(`[receiver] session ensure: ${ok}`);

      // Point the room node's runtime config at THIS server and start pinning
      // its clock: neither call may stall the engage path (fire-and-forget).
      void postNodeConfig(serverUrl);
      void postNodeTime();
      // Every device rides the same fixed open `atlas` network (the ESP32
      // room-node softAP). No passphrase: Android may still show its one-time
      // per-app approval dialog, but it never asks for a WiFi password.
      const ssid = settings.soshinSsid || ATLAS_SSID;
      setJoinSource(`ATLAS · OPEN · ${ssid}`);
      console.log(`[receiver] join target ${ssid} (open network, no password)`);

      // A room register must not accumulate a ghost row per app launch:
      // minting a fresh DEVICE_ID each restart left dead devices posing as
      // absent students on the server. Resolve the persisted id instead.
      const persistentDeviceId = await loadPersistentDeviceId();
      setDeviceId(persistentDeviceId);

      const sensors = sensorsRef.current ?? new NativeSensors();
      sensorsRef.current = sensors;
      const reporter = new HttpReporter(serverUrl);
      const config: JushinConfig = {
        deviceId: persistentDeviceId,
        studentId: identity?.studentId || settings.studentId || undefined,
        studentName: identity?.studentName || settings.studentName || undefined,
        rfidUid: identity?.rfidUid || undefined,
        roomId: settings.roomId,
        sessionId: settings.sessionId,
        soshinSsid: ssid,
        // Empty = open network (atlas). CONFIG can still pin a WPA2 fallback.
        soshinPass: settings.soshinPass || undefined,
        // Headless deep-link runs and the relaxed default never prompt.
        bioMode: bioSkip || !BIOMETRIC_REQUIRED ? "skip" : "required",
      };
      const controller = new JushinController(sensors, config, reporter);
      const b = await controller.startAttendance();
      const skipped = b.reason?.includes("skipped") ?? false;
      setBio(
        skipped
          ? "not required"
          : `${b.kind} (${b.success ? "ok" : `failed: ${b.reason ?? "unknown"}`})`,
      );
      setBioOk(skipped ? null : b.success);
      if (!b.success && !bioSkip) {
        setError("Fingerprint failed — attendance not started.");
        setEvent({
          text: "BIOMETRIC FAILED · attendance not marked",
          kind: "bad",
        });
        return;
      }
      controllerRef.current = controller;
      setRunning(true);
      setStartedAt(Date.now());
      sensorsRef.current = sensors;
      setTraceReset((n) => n + 1);
      lastBleRef.current = null;
      bleAtRef.current = 0;
      wifiHistoryRef.current = [];
      wifiAtRef.current = 0;
      setSignalVerdict(null);
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
          // Structured payload so the Debug screen can inspect the exact wire
          // format of the last tick (report + server verdict).
          logPayload("last-report", report);
          logPayload("last-presence-result", controller.lastReportResult);

          // A dropped server link while walking is expected; only surface real
          // sensor faults. A 404 means the in-memory session was lost — fix it.
          const reportError = controller.lastReportError;
          if (reportError?.includes("404")) {
            const ok = await ensureSession(serverUrl, {
              sessionId: settings.sessionId,
              roomId: settings.roomId,
              secret: settings.secret,
            });
            console.log(`[receiver] session re-ensure after 404: ${ok}`);
          }
          setError(
            reportError && !/Network request failed|report failed/.test(reportError)
              ? reportError
              : null,
          );

          // Feed the live trace: strongest BLE beacon + the joined AP's RSSI.
          const strongestBle = (report.ble?.readings ?? []).reduce<number | null>(
            (best, r) => (best == null || r.rssi > best ? r.rssi : best),
            null,
          );
          lastBleRef.current = strongestBle;
          bleAtRef.current = Date.now();

          // Verdict flip → compact inline status event (was a full-screen alert).
          const r = controller.lastReportResult;
          const v = r?.presence?.present ?? null;
          const prev = prevVerdictRef.current;
          prevVerdictRef.current = v;
          if (v !== null && prev !== null && v !== prev) {
            setEvent(
              v
                ? {
                    text: `RECOGNIZED · fused=${(r?.presence?.fused ?? 0).toFixed(3)}`,
                    kind: "ok",
                  }
                : {
                    text: `TARGET LOST · fused=${(r?.presence?.fused ?? 0).toFixed(3)}`,
                    kind: "bad",
                  },
            );
          }
          setNow(Date.now());
        } catch (e) {
          console.warn("[receiver] tick failed:", e);
          const msg = e instanceof Error ? e.message : String(e);
          // The fusion server keeps sessions in memory: a server restart
          // drops them. Re-ensure silently and let the next tick resume.
          if (msg.includes("report failed: 404")) {
            const ok = await ensureSession(serverUrl, {
              sessionId: settings.sessionId,
              roomId: settings.roomId,
              secret: settings.secret,
            });
            console.log(`[receiver] session re-ensure after 404: ${ok}`);
          } else {
            setError(msg);
            setEvent({ text: `SENSOR FAULT · ${msg}`, kind: "bad" });
          }
        } finally {
          busyRef.current = false;
        }
      };
      await loop();
      intervalRef.current = setInterval(loop, TICK_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEvent({ text: "ENGAGE FAILED", kind: "bad" });
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

  const uptime = startedAt ? Math.round((now - startedAt) / 1000) : 0;
  const sp = lastResult?.presence ?? null;
  const rtt = lastResult?.rttMs ?? null;
  const verdict = sp?.present ?? signalVerdict ?? null;
  // Countdown: seconds since the last completed 5 s report tick.
  const lastSeen = lastReport ? Math.max(0, Math.round((now - lastReport.timestamp) / 1000)) : null;
  // Connection stats to the transmitter, from this phone's last report. The
  // Link summary from the last report.
  const link: LinkSummary | null = lastReport ? summarizeLink(lastReport) : null;

  const verdictBadge = () => {
    if (!running) return <Badge variant="secondary"><Text>standby</Text></Badge>;
    if (verdict == null) return <Badge variant="secondary"><Text>scanning</Text></Badge>;
    return verdict
      ? <Badge variant="default"><Text>present</Text></Badge>
      : <Badge variant="destructive"><Text>absent</Text></Badge>;
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top", "left", "right", "bottom"]}>
      {/* Header: exit chevron · title · role/uptime */}
      <View className="flex-row items-center gap-2 px-4 pt-2">
        <Button variant="ghost" size="icon" onPress={onExit} accessibilityLabel="Exit receiver">
          <Chevron direction="left" />
        </Button>
        <Text className="flex-1 text-center text-lg font-semibold">Receiver · 受信</Text>
        <View className="flex-row items-center gap-2">
          <Text className="text-xs text-muted-foreground" style={{ fontFamily: MONO }}>
            {running ? fmtClock(uptime) : "standby"}
          </Text>
        </View>
      </View>
      <ScrollView className="flex-1">
        <View className="gap-4 p-4 pb-8">
          {!identity ? (
            <Card>
              <CardHeader>
                <CardTitle>Enroll this phone</CardTitle>
                <CardDescription>
                  Enter your roll and name once, then confirm with this phone's
                  fingerprint. It is saved on this device; every engagement
                  requires that fingerprint.
                </CardDescription>
              </CardHeader>
              <CardContent className="gap-3">
                <Label>Roll number</Label>
                <Input
                  value={enrollId}
                  onChangeText={setEnrollId}
                  placeholder="bl.sc.u4cse...."
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Label>Name</Label>
                <Input
                  value={enrollName}
                  onChangeText={setEnrollName}
                  placeholder="Your name"
                />
                <Label>RFID card UID (optional)</Label>
                <Input
                  value={enrollRfid}
                  onChangeText={setEnrollRfid}
                  placeholder="e.g. 16FA551F"
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
                {enrollMsg ? (
                  <Text
                    className={
                      enrollMsg.startsWith("Card saved")
                        ? "text-sm text-muted-foreground"
                        : "text-sm text-destructive"
                    }
                  >
                    {enrollMsg}
                  </Text>
                ) : null}
                <Button onPress={() => void enroll()}>
                  <Text>Save &amp; verify fingerprint</Text>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <View className="flex-row items-center justify-between rounded-lg border border-border p-3">
              <Text className="text-sm text-muted-foreground">
                {identity.studentName} · {identity.studentId}
                {identity.rfidUid ? ` · RFID ${identity.rfidUid}` : ""}
              </Text>
              <Badge variant="secondary">
                <Text>enrolled</Text>
              </Badge>
            </View>
          )}
          {/* PRESENCE — verdict + honest "last seen" countdown */}
          <Card>
            <CardHeader>
              <View className="flex-row items-center justify-between">
                <CardTitle>Presence verdict</CardTitle>
                {verdictBadge()}
              </View>
              <CardDescription>
                {lastReport
                  ? `last seen ${lastSeen}s ago · report #${ticks} · ${fmtTime(lastReport.timestamp)}`
                  : running
                    ? "waiting for the first report tick…"
                    : "engage to begin reporting"}
              </CardDescription>
            </CardHeader>
            <CardContent className="gap-2">
              {verdict != null && sp ? (
                <DataRow label="fused (server)" value={`${sp.fused.toFixed(3)}`} />
              ) : (
                <DataRow label="source" value={running ? "local signal rule only" : "no data yet"} />
              )}
              {event && (
                <View className="mt-1 flex-row items-center gap-2">
                  <Badge variant={event.kind === "ok" ? "default" : event.kind === "warn" ? "secondary" : "destructive"}>
                    <Text>{event.kind === "ok" ? "event" : "alert"}</Text>
                  </Badge>
                  <Text className="shrink text-xs text-muted-foreground" numberOfLines={2}>
                    {event.text}
                  </Text>
                </View>
              )}
            </CardContent>
          </Card>

          {/* SIGNAL TRACE — live WiFi/BLE: walk the phone away, watch it fall */}
          <Card>
            <CardHeader>
              <View className="flex-row items-center justify-between">
                <CardTitle>Live signal trace</CardTitle>
                <Badge variant={running ? "default" : "secondary"}>
                  <Text>{running ? "live · 0.5s poll" : "standby"}</Text>
                </Badge>
              </View>
              <CardDescription>BLE beacon + WiFi AP RSSI over time</CardDescription>
            </CardHeader>
            <CardContent>
              <LiveSignalGraph
                sensorsRef={sensorsRef}
                lastBleRef={lastBleRef}
                serverUrl={serverUrl}
                sessionId={settings.sessionId}
                deviceId={deviceId}
                resetKey={traceReset}
                onSample={handleSignalSample}
              />
            </CardContent>
          </Card>

          {/* FUSION — device-side confidence + per-channel observation */}
          <Card>
            <CardHeader>
              <CardTitle>Device fusion</CardTitle>
              <CardDescription>local rule + per-channel confidence</CardDescription>
            </CardHeader>
            <CardContent className="gap-2">
              {!running && (
                <DataRow
                  label="Ultrasonic (standby)"
                  value={
                    ultraPreview == null
                      ? "starting…"
                      : ultraPreview.received
                        ? `heard${ultraPreview.snr != null ? ` · snr ${ultraPreview.snr.toFixed(1)}` : ""}`
                        : `not heard · ${ultraPreview.missReason ?? "no_signal"}`
                  }
                />
              )}
              {local ? (
                <>
                  <View className="gap-1">
                    <DataRow label="fused (device)" value={local.fused.toFixed(3)} />
                    <Progress value={local.fused * 100} />
                  </View>
                  {(
                    [
                      ["ble", local.ble, "BLE"],
                      ["wifi", local.wifi, "WiFi"],
                      ["ultrasonic", local.ultrasonic, "ULTRASONIC"],
                    ] as const
                  ).map(([key, value, label]) => (
                    <View key={key} className="gap-1">
                      <DataRow label={label} value={value == null ? "—" : value.toFixed(3)} />
                      {value != null && <Progress value={value * 100} />}
                    </View>
                  ))}
                  {lastReport && (
                    <>
                      <DataRow
                        label="BLE nodes"
                        value={lastReport.ble?.readings.map((r) => `${r.nodeId} ${r.rssi}dBm${r.code ? "·code" : ""}`).join(", ") || "none"}
                      />
                      <DataRow
                        label="WiFi"
                        value={
                          lastReport.wifi?.connectedToSoshin
                            ? `${lastReport.wifi.ssid ?? "?"}${
                                lastReport.wifi.soshinRssi != null && !Number.isNaN(lastReport.wifi.soshinRssi)
                                  ? ` ${lastReport.wifi.soshinRssi}dBm`
                                  : ""
                              }`
                            : "not joined"
                        }
                      />
                      <DataRow
                        label="Ultrasonic"
                        value={
                          lastReport.ultrasonic == null
                            ? "not sampled"
                            : lastReport.ultrasonic.received
                              ? `heard${lastReport.ultrasonic.snr != null ? ` · snr ${lastReport.ultrasonic.snr.toFixed(1)}` : ""}`
                              : `not heard · ${lastReport.ultrasonic.missReason ?? "no_signal"}`
                        }
                      />
                    </>
                  )}
                </>
              ) : (
                <Text className="text-sm text-muted-foreground">
                  No telemetry yet — engage to begin the sync cycle.
                </Text>
              )}
              {sp && (
                <View className="mt-2 gap-2 border-t border-border pt-2">
                  <JsonBlock data={sp} label="Server verdict (raw)" pretty />
                  <JsonBlock data={lastReport} label="Report payload (raw)" pretty />
                </View>
              )}
            </CardContent>
          </Card>

          {/* BIOMETRIC — the occupant check */}
          <Card>
            <CardHeader>
              <CardTitle>Biometric check</CardTitle>
              <CardDescription>anti-spoof, recorded at attendance boundaries</CardDescription>
            </CardHeader>
            <CardContent className="flex-row items-center gap-2">
              <Badge variant={bioOk == null ? "secondary" : bioOk ? "default" : "destructive"}>
                <Text>{bioOk == null ? "pending" : bioOk ? "ok" : "failed"}</Text>
              </Badge>
              <Text className="shrink text-sm text-foreground" numberOfLines={2} style={{ fontFamily: MONO }}>
                {bio}
              </Text>
            </CardContent>
          </Card>

          {/* LINK TO TRANSMITTER — this phone's connection to the room AP */}
          <Card>
            <CardHeader>
              <View className="flex-row items-center justify-between">
                <CardTitle>Link to transmitter</CardTitle>
                <Badge
                  variant={
                    !link
                      ? "secondary"
                      : link.state === "connected"
                        ? "default"
                        : link.state === "degraded"
                          ? "secondary"
                          : "destructive"
                  }
                >
                  <Text>{link ? link.state : "no data"}</Text>
                </Badge>
              </View>
              <CardDescription>per-modality connection to the room transmitter</CardDescription>
            </CardHeader>
            <CardContent className="gap-2">
              {link ? (
                <>
                  <View className="gap-1">
                    <DataRow
                      label="overall"
                      value={`${Math.round(link.quality * 100)}%`}
                    />
                    <Progress value={link.quality * 100} />
                  </View>
                  {link.modalities.map((m) => (
                    <DataRow
                      key={m.modality}
                      label={modalityLabel(m.modality)}
                      value={`${m.detail} · ${Math.round(m.quality * 100)}%`}
                    />
                  ))}
                  <DataRow label="uplink" value={rtt != null ? `server rtt ${rtt}ms` : "—"} />
                  <DataRow label="joined" value={joinSource} />
                </>
              ) : (
                <Text className="text-sm text-muted-foreground">
                  No link data yet — pick a preset and engage; the transmitter's
                  hotspot is discovered automatically.
                </Text>
              )}
            </CardContent>
          </Card>

          {/* ENGAGEMENT — start/stop attendance */}
          <Card>
            <CardHeader>
              <CardTitle>Engagement</CardTitle>
              <CardDescription>
                {running
                  ? `reporting every ${TICK_MS / 1000}s · node clock pinned`
                  : "start attendance to begin the report loop"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-row gap-2">
              {running ? (
                <Button variant="destructive" className="flex-1" onPress={stop}>
                  <Text>Stop attendance</Text>
                </Button>
              ) : (
                <Button
                  className="flex-1"
                  disabled={!identity && !bioSkip}
                  onPress={start}
                >
                  <Text>Start attendance</Text>
                </Button>
              )}
            </CardContent>
          </Card>

          {/* ROOM MONITOR — every unit on the server; tap a row for its verdict */}
          <Card>
            <CardHeader>
              <CardTitle>Room monitor</CardTitle>
              <CardDescription>
                {devices.length} device(s) on {settings.sessionId} ·{" "}
                {devices.filter((d) => (d.link?.state ?? "lost") === "connected").length} fully linked
              </CardDescription>
            </CardHeader>
            <CardContent className="gap-2">
              {devices.length === 0 ? (
                <Text className="text-sm text-muted-foreground">
                  No devices reported yet. Start attendance; every phone on the
                  same preset room appears here with its three-channel link.
                </Text>
              ) : (
                devices.map((d) => (
                  <DeviceLinkRow
                    key={d.deviceId}
                    device={d}
                    now={now}
                    onPress={() =>
                      setSelectedDevice((prev) => (prev?.deviceId === d.deviceId ? null : d))
                    }
                  />
                ))
              )}
              {selectedDevice && (
                <View className="mt-1 gap-2 border-t border-border pt-2">
                  <DataRow
                    label="selected"
                    value={`${selectedDevice.deviceId} · ${selectedDevice.present ? "present" : "absent"} · fused ${selectedDevice.fused.toFixed(3)}`}
                  />
                  <JsonBlock data={selectedDevice} label="Presence payload (raw)" pretty />
                </View>
              )}
            </CardContent>
          </Card>

          {/* ERROR — muted inline surface (was a full-screen fault alert) */}
          {error && (
            <Card className="border-destructive/50 bg-destructive/10">
              <CardHeader>
                <View className="flex-row items-center gap-2">
                  <Badge variant="destructive">
                    <Text>error</Text>
                  </Badge>
                  <CardTitle>Engagement interrupted</CardTitle>
                </View>
                <CardDescription>{error}</CardDescription>
              </CardHeader>
            </Card>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
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

  const confs: Partial<Record<"ble" | "wifi" | "ultrasonic", number>> = {};
  if (ble != null) confs.ble = ble;
  if (wifi != null) confs.wifi = wifi;
  if (ultrasonic != null) confs.ultrasonic = ultrasonic;
  const fused = fuse(confs);
  return { ble, wifi, ultrasonic, fused, present: decide(fused) };
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}
