import React, { useEffect, useRef, useState } from "react";
import type { Modality } from "shared";
import { Pressable, ScrollView, View } from "react-native";
import { NativeSensors } from "./lib/nativeSensors";
import type { Settings } from "./settings";
import { presetById } from "./lib/presets";
import { SoshinController, type SoshinConfig } from "./lib/modes/soshin";
import { announceHotspot, ensureSession } from "./lib/server";
import { useSessionPresence } from "./lib/useSessionPresence";
import { roleLabel } from "./lib/roles";
import { DEVICE_ID } from "./identity";
import { VERSION } from "./version";
import { colors, MONO } from "./theme";
import { DeviceLinkRow } from "./components/DeviceLinkRow";
import { modalityLabel } from "./lib/linkView";
import { ScreenHeader } from "./components/tx/ScreenHeader";
import { ValueRow } from "./components/tx/ValueRow";
import { StateBadge, type StateTone } from "./components/tx/StateBadge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** One inline console alert (replaces the old full-screen overlay). */
interface ConsoleAlert {
  title: string;
  jp?: string;
  sub?: string;
  detail?: string;
  tone: string;
}

const STEP_MS = 30_000;

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString();
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

export default function SoshinScreen({
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
  const [code, setCode] = useState<string | null>(null);
  const [hotspot, setHotspot] = useState<{ ssid: string; passphrase: string } | null>(null);
  const [ensured, setEnsured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [broadcasts, setBroadcasts] = useState(0);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [bleState, setBleState] = useState<string>("idle");
  const [announced, setAnnounced] = useState<boolean | null>(null);
  const [, setNow] = useState(Date.now());
  const [alert, setAlert] = useState<ConsoleAlert | null>(null);
  const bleFailRef = useRef(false);
  const controllerRef = useRef<SoshinController | null>(null);
  const sensorsRef = useRef<NativeSensors | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { devices, rttMs } = useSessionPresence(
    serverUrl,
    settings.sessionId,
    running, // only poll while the room beacon is live
  );

  // 1s clock tick driving the "next code in …" countdown (cheap).
  useEffect(() => {
    if (!running) return;
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [running]);

  const start = async () => {
    setError(null);
    try {
      const ok = await ensureSession(serverUrl, {
        sessionId: settings.sessionId,
        roomId: settings.roomId,
        secret: settings.secret,
      });
      setEnsured(ok);

      const sensors = new NativeSensors();
      sensorsRef.current = sensors;
      const config: SoshinConfig = {
        deviceId: DEVICE_ID,
        roomId: settings.roomId,
        sessionId: settings.sessionId,
        nodeId: DEVICE_ID,
        secret: new TextEncoder().encode(settings.secret),
        step: 30,
      };
      const controller = new SoshinController(sensors, config);
      const h = await controller.start();
      controllerRef.current = controller;
      setHotspot(
        h && (h.ssid || h.passphrase)
          ? { ssid: h.ssid ?? "(no ssid)", passphrase: h.passphrase ?? "" }
          : null,
      );
      setRunning(true);

      // Publish the live AutoHotspot SSID/passphrase so receivers that picked
      // the same preset room can auto-join it.
      const announce = async () => {
        const live = controller.hotspotInfo;
        if (!live?.ssid) return;
        const okAnnounce = await announceHotspot(serverUrl, settings.sessionId, {
          deviceId: DEVICE_ID,
          ssid: live.ssid,
          passphrase: live.passphrase,
        });
        setAnnounced(okAnnounce);
      };
      await announce();

      const loop = async (now: number) => {
        const c = await controller.broadcast(now);
        setCode(c);
        setLastAt(Date.now());
        setNextAt(now + STEP_MS);
        setBroadcasts((n) => n + 1);
        void announce(); // keep the hotspot announce fresh (re-announced each step)
        const adv = sensorsRef.current?.lastAdvertise;
        setBleState(
          adv == null
            ? "unknown"
            : adv.started
              ? "OK"
              : `FAIL (errorCode=${adv.errorCode})`,
        );
        // BLE beacon fault → one console alert per failure episode.
        if (adv && !adv.started && !bleFailRef.current) {
          bleFailRef.current = true;
          setAlert({
            title: "ADVERTISE FAULT",
            jp: "通信異常",
            sub: "BLE BEACON REJECTED BY RADIO STACK",
            detail: `errorCode=${adv.errorCode} (1=DATA_TOO_LARGE 2=TOO_MANY 3=ALREADY_STARTED 4=UNSUPPORTED 5=INTERNAL)`,
            tone: colors.amber,
          });
        }
        if (adv?.started) bleFailRef.current = false;
      };
      await loop(Date.now());
      intervalRef.current = setInterval(() => void loop(Date.now()), STEP_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setAlert({
        title: "ENGAGE FAILED",
        jp: "起動失敗",
        sub: "TRANSMITTER (SOSHIN) COULD NOT BE RAISED",
        detail: msg,
        tone: colors.red,
      });
    }
  };

  const stop = async () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (controllerRef.current) {
      try {
        await controllerRef.current.stop();
      } catch (e) {
        console.warn("[transmitter] stop failed:", e);
      }
    }
    controllerRef.current = null;
    sensorsRef.current = null;
    setRunning(false);
    setCode(null);
    setHotspot(null);
    setLastAt(null);
    setNextAt(null);
    setBleState("idle");
    setAnnounced(null);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  // Headless auto-engage (deep link `shusseki://tx`) — start once on mount.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoEngage && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEngage]);

  const countdown =
    running && nextAt != null ? Math.max(0, Math.round((nextAt - Date.now()) / 1000)) : 0;
  const bleOk = bleState === "OK";
  const bleBad = bleState.startsWith("FAIL");
  const linked = devices.filter((d) => (d.link?.state ?? "lost") === "connected").length;
  const present = devices.filter((d) => d.present).length;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Transmitter · 送信 Soshin"
        onExit={onExit}
        right={
          <View className="flex-row items-center gap-2">
            <Text className="text-[10px] text-muted-foreground" style={{ fontFamily: MONO }}>
              {VERSION}
            </Text>
            <StateBadge tone={running ? "ok" : "muted"}>
              {running ? "OPERATIONAL" : "STANDBY"}
            </StateBadge>
          </View>
        }
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="p-4 gap-4"
      >
        {/* Session identity / preset */}
        <Card>
          <CardHeader>
            <CardTitle>Preset session</CardTitle>
            <CardDescription numberOfLines={2}>
              {presetById(settings.presetId).name} · rolling codes re-verified by the server
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-2">
            <ValueRow label="preset" value={presetById(settings.presetId).name} />
            <ValueRow label="nodeId" value={DEVICE_ID} />
            <ValueRow label="roomId" value={settings.roomId} />
            <ValueRow label="sessionId" value={settings.sessionId} />
            <View className="flex-row items-center justify-between gap-3">
              <Text className="shrink text-xs text-muted-foreground" numberOfLines={1}>
                session
              </Text>
              <StateBadge
                mono
                className={ensured == null ? "opacity-70" : undefined}
                tone={ensured == null ? "outline" : ensured ? "ok" : "warn"}
              >
                {ensured == null
                  ? "checking…"
                  : ensured
                    ? "ENSURED ON SERVER"
                    : "UNCERTAIN (offline?)"}
              </StateBadge>
            </View>
            <ValueRow
              label="uplink"
              value={rttMs == null ? "—" : `presence poll ${rttMs}ms`}
              tone={rttMs != null && rttMs > 1500 ? "warn" : "ok"}
            />
          </CardContent>
        </Card>

        {/* Three physical channels this unit drives */}
        <Card>
          <CardHeader>
            <CardTitle>Sensor status</CardTitle>
            <CardDescription>BLE beacon · WiFi hotspot · ultrasonic chirp</CardDescription>
          </CardHeader>
          <CardContent className="gap-3">
            <View className="flex-row items-center gap-2">
              <StateBadge mono tone={running ? "ok" : "muted"}>
                {running ? "EMITTING CHIRP" : "ULTRASONIC idle"}
              </StateBadge>
              <Text className="flex-1 text-right text-xs text-muted-foreground" numberOfLines={1}>
                30s rolling tone pattern source
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <StateBadge mono tone={!running ? "muted" : bleBad ? "bad" : bleOk ? "ok" : "warn"}>
                {!running
                  ? "BLE idle"
                  : bleBad
                    ? `BLE ${bleState}`
                    : bleOk
                      ? "BLE ADVERTISING"
                      : "BLE pending"}
              </StateBadge>
              <Text className="flex-1 text-right text-xs text-muted-foreground" numberOfLines={1}>
                {running && bleBad ? "check radio stack" : "BLE beacon listener"}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <StateBadge
                mono
                tone={!running ? "muted" : announced ? "ok" : announced === false ? "bad" : "warn"}
              >
                {!running
                  ? "WIFI idle"
                  : announced == null
                    ? "WIFI pending"
                    : announced
                      ? "HOTSPOT PUBLISHED"
                      : "ANNOUNCE FAILED"}
              </StateBadge>
              <Text className="flex-1 text-right text-xs text-muted-foreground" numberOfLines={1}>
                LocalOnlyHotspot
              </Text>
            </View>
          </CardContent>
        </Card>

        {/* Live TONE pattern */}
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 pb-0">
            <View className="shrink-0">
              <CardTitle>Live tone pattern</CardTitle>
            </View>
            <StateBadge mono tone={running && countdown <= 5 ? "warn" : running ? "ok" : "muted"}>
              {running ? `next ${fmtClock(countdown)}` : "next —"}
            </StateBadge>
          </CardHeader>
          <CardContent className="gap-3">
            <Text
              className="text-4xl tracking-widest text-foreground"
              style={{ fontFamily: MONO }}
              numberOfLines={1}
            >
              {code ?? "- - - - - -"}
            </Text>
            {/* One tone "step" per broadcast; the pattern the room hears. */}
            <View className="flex-row gap-1">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <View
                  key={i}
                  className={cn(
                    "h-2 flex-1 rounded-sm",
                    running ? (i === 0 ? "bg-emerald-500" : "bg-muted") : "bg-muted",
                  )}
                />
              ))}
            </View>
            <ValueRow label="broadcasts" value={String(broadcasts)} />
            <ValueRow label="last transmit" value={lastAt ? fmtTime(lastAt) : "—"} />
          </CardContent>
        </Card>

        {/* Hotspot card (when hosted) */}
        {hotspot && (
          <Card>
            <CardHeader>
              <CardTitle>Hotspot</CardTitle>
              <CardDescription>Local-only network receivers can join</CardDescription>
            </CardHeader>
            <CardContent className="gap-2">
              <ValueRow label="ssid" value={`"${hotspot.ssid}"`} tone="warn" />
              <ValueRow label="passphrase" value={`"${hotspot.passphrase}"`} tone="warn" />
              <View className="flex-row items-center justify-between gap-3">
                <Text className="shrink text-xs text-muted-foreground" numberOfLines={1}>
                  announce
                </Text>
                <StateBadge
                  mono
                  tone={
                    announced == null ? "outline" : announced ? "ok" : "bad"
                  }
                >
                  {announced == null
                    ? "pending…"
                    : announced
                      ? "PUBLISHED TO SERVER"
                      : "FAILED (receivers: manual CONFIG)"}
                </StateBadge>
              </View>
              <Text className="text-xs leading-5 text-muted-foreground">
                Demo fallback only: in the atlas deployment the ESP32 hosts the
                open network and receivers join that. To use this hotspot by
                hand, set RECEIVER → CONFIG to this SSID/passphrase.
              </Text>
            </CardContent>
          </Card>
        )}

        {/* Room monitor — every device the server has seen */}
        <Card>
          <CardHeader>
            <View className="flex-row items-center justify-between gap-2">
              <CardTitle>Room monitor</CardTitle>
              <StateBadge mono tone={devices.length === 0 ? "muted" : linked === devices.length && present > 0 ? "ok" : present === 0 ? "muted" : "warn"}>
                {devices.length} FOUND · {linked} LINKED
              </StateBadge>
            </View>
            <CardDescription>
              Fusion summary: {present}/{devices.length} present
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-2">
            {devices.length === 0 ? (
              <Text className="text-xs leading-5 text-muted-foreground">
                No receivers found yet. A receiver must press ENGAGE with the
                same room preset, then it reports here every few seconds.
              </Text>
            ) : (
              devices.map((d) => (
                <View key={d.deviceId} className="gap-1">
                  <DeviceLinkRow
                    device={d}
                    now={Date.now()}
                    onPress={() =>
                      setAlert({
                        title: d.present ? "UNIT LINKED" : "UNIT WEAK",
                        jp: "個機状態",
                        sub: `${roleLabel(d.mode)} · ${d.deviceId}`,
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
                  {/* Three-channel links with numeric RSSI/SNR per channel */}
                  <View className="flex-row flex-wrap items-center gap-2 pl-4">
                    {(d.link?.modalities ?? []).map((m) => {
                      const channelTone: StateTone =
                        m.state === "connected"
                          ? "ok"
                          : m.state === "degraded"
                            ? "warn"
                            : "bad";
                      const numeric =
                        m.rssi != null
                          ? `${m.rssi} dBm`
                          : m.snr != null
                            ? `snr ${m.snr.toFixed(1)}`
                            : "no reading";
                      return (
                        <View
                          key={m.modality as Modality}
                          className="flex-row items-center gap-1"
                        >
                          <StateBadge mono tone={channelTone}>
                            {modalityLabel(m.modality)}
                          </StateBadge>
                          <Text
                            className="text-[10px] text-muted-foreground"
                            style={{ fontFamily: MONO }}
                            numberOfLines={1}
                          >
                            {numeric}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </View>
              ))
            )}
          </CardContent>
        </Card>

        {error && (
          <Card className="border-red-900/60">
            <CardHeader>
              <CardTitle className="text-red-400">FAULT</CardTitle>
              <CardDescription>The transmitter could not hold its state</CardDescription>
            </CardHeader>
            <CardContent>
              <Text
                className="text-xs text-red-400"
                style={{ fontFamily: MONO }}
              >
                {error}
              </Text>
            </CardContent>
          </Card>
        )}

        {alert && (
          <Card
            className={
              alert.tone === colors.red
                ? "border-red-900/60"
                : alert.tone === colors.amber
                  ? "border-amber-900/60"
                  : "border-emerald-900/60"
            }
          >
            <CardContent>
              <Pressable onPress={() => setAlert(null)}>
                <View className="gap-1">
                  <View className="flex-row items-center justify-between gap-2">
                    <Text className="text-sm font-semibold text-foreground">{alert.title}</Text>
                    <StateBadge tone={alert.tone === colors.red ? "bad" : alert.tone === colors.amber ? "warn" : "ok"}>
                      TAP TO DISMISS
                    </StateBadge>
                  </View>
                  {alert.sub && (
                    <Text
                      className="text-xs text-muted-foreground"
                      style={{ fontFamily: MONO }}
                    >
                      {alert.sub}
                    </Text>
                  )}
                  {alert.detail && (
                    <Text
                      className="text-xs text-foreground"
                      style={{ fontFamily: MONO }}
                    >
                      {alert.detail}
                    </Text>
                  )}
                </View>
              </Pressable>
            </CardContent>
          </Card>
        )}

        {/* Bottom action bar */}
        <View className="flex-row items-center gap-2">
          {!running ? (
            <Button className="flex-1" onPress={start}>
              <Text>UNIT-01 ENGAGE</Text>
            </Button>
          ) : (
            <Button className="flex-1" variant="destructive" onPress={stop}>
              <Text>SHUTDOWN</Text>
            </Button>
          )}
          <Button className="flex-1" variant="outline" onPress={onExit}>
            <Text>EXIT</Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
