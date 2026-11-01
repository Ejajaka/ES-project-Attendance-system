import React, { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import type { Settings } from "./settings";
import { NativeSensors } from "./lib/nativeSensors";
import { HttpReporter } from "./lib/reporter";
import { JushinController } from "./lib/modes/jushin";
import { ensureSession, fetchHotspot, postNodeConfig, postNodeTime } from "./lib/server";
import { DEVICE_ID } from "./identity";
import { MONO } from "./theme";
import { ScreenHeader } from "./components/tx/ScreenHeader";
import { ValueRow } from "./components/tx/ValueRow";
import { StateBadge } from "./components/tx/StateBadge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Text } from "@/components/ui/text";

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
        // Fire-and-forget: point the room node's runtime config at this server
        // and keep its clock pinned (the calibration loop refreshes it below).
        void postNodeConfig(settings.serverUrl);
        void postNodeTime();
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
            // Keep the room node's clock pinned once per calibration tick.
            void postNodeTime();
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

  /** Sample-count progress toward "enough" (server asks ≥3 per side). */
  const sampleProgress = (n: number) =>
    Math.round(Math.min(1, Math.max(0, n / 3)) * 100);

  const mine = data?.latest.find((l) => l.deviceId === calibratorId) ?? null;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Calibrate · 校正"
        onExit={onExit}
        right={
          <StateBadge mono tone={online ? "ok" : "bad"}>
            {online ? `LIVE · ${ageStr}` : "OFFLINE"}
          </StateBadge>
        }
      />
      <ScrollView className="flex-1" contentContainerClassName="p-4 gap-4">
        {message && (
          <Text
            className={
              online
                ? "text-xs text-amber-400"
                : "text-xs text-red-400"
            }
            numberOfLines={2}
          >
            {message}
          </Text>
        )}

        {/* Calibration dataset card */}
        <Card>
          <CardHeader>
            <CardTitle>Current boundary</CardTitle>
            <CardDescription numberOfLines={2}>
              live thresholds this room enforces
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-2">
            <ValueRow
              label="room node"
              value={data?.current.roomNodeId ?? "(not announced)"}
            />
            <ValueRow
              label="BLE ≥"
              value={data ? `${data.current.bleRssiThreshold} dBm` : "—"}
            />
            <ValueRow
              label="WiFi ≥"
              value={data ? `${data.current.wifiRssiThreshold} dBm` : "—"}
            />
            <ValueRow
              label="timers"
              value={`TTL ${Math.round((data?.current.ttlMs ?? 0) / 1000)}s · enter ${Math.round((data?.current.enterMs ?? 0) / 1000)}s · exit ${Math.round((data?.current.exitMs ?? 0) / 1000)}s`}
              tone="muted"
            />
          </CardContent>
        </Card>

        {/* Live sample card — this phone, right now */}
        <Card>
          <CardHeader>
            <View className="flex-row items-center justify-between gap-2">
              <CardTitle>Live sample</CardTitle>
              {mine ? (
                <StateBadge mono tone={mine.inRoom ? "ok" : "warn"}>
                  {mine.inRoom ? "IN ROOM" : "OUTSIDE"}
                </StateBadge>
              ) : (
                <StateBadge mono tone="muted">
                  NO REPORT
                </StateBadge>
              )}
            </View>
            <CardDescription numberOfLines={2}>
              {`calibrating as ${calibratorId}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-2">
            {mine ? (
              <>
                <ValueRow label="BLE" value={fmtRssi(mine.ble)} />
                <ValueRow label="WiFi" value={fmtRssi(mine.wifi)} />
              </>
            ) : (
              <Text className="text-xs leading-5 text-muted-foreground">
                no report yet — turn on Bluetooth, join Shusseki-ESP32, wait ~5s
              </Text>
            )}
          </CardContent>
        </Card>

        {/* Inside/Outside sample capture */}
        <Card>
          <CardHeader>
            <CardTitle>Mark a position</CardTitle>
            <CardDescription>
              Stand INSIDE the room (centre + near each wall) and tap MARK
              INSIDE 2–3 times. Then step into the CORRIDOR and tap MARK
              OUTSIDE.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-3">
            <View className="flex-row items-center gap-2">
              <Button
                className="flex-1"
                disabled={busy}
                onPress={() => mark("inside")}
              >
                <Text>MARK INSIDE</Text>
              </Button>
              <Button
                className="flex-1"
                variant="destructive"
                disabled={busy}
                onPress={() => mark("outside")}
              >
                <Text>MARK OUTSIDE</Text>
              </Button>
            </View>
          </CardContent>
        </Card>

        {/* Suggestion — what the server would apply */}
        <Card>
          <CardHeader>
            <CardTitle>Suggestion</CardTitle>
            <CardDescription>
              {data?.suggestion.sufficient
                ? "enough samples — APPLY"
                : "collect ≥3 INSIDE and ≥3 OUTSIDE samples"}
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-3">
            <View className="gap-1">
              <View className="flex-row items-center justify-between gap-2">
                <Text className="text-xs text-muted-foreground">inside samples</Text>
                <Text
                  className="text-xs text-foreground"
                  style={{ fontFamily: MONO }}
                  numberOfLines={1}
                >
                  {data?.suggestion.insideSamples ?? 0}
                </Text>
              </View>
              <Progress
                value={sampleProgress(data?.suggestion.insideSamples ?? 0)}
                className="h-2 bg-emerald-950/60"
                indicatorClassName="bg-emerald-600"
              />
            </View>
            <View className="gap-1">
              <View className="flex-row items-center justify-between gap-2">
                <Text className="text-xs text-muted-foreground">outside samples</Text>
                <Text
                  className="text-xs text-foreground"
                  style={{ fontFamily: MONO }}
                  numberOfLines={1}
                >
                  {data?.suggestion.outsideSamples ?? 0}
                </Text>
              </View>
              <Progress
                value={sampleProgress(data?.suggestion.outsideSamples ?? 0)}
                className="h-2 bg-red-950/60"
                indicatorClassName="bg-red-600"
              />
            </View>
            <ValueRow
              label="suggested BLE ≥"
              value={
                data?.suggestion.bleRssiThreshold != null
                  ? `${data.suggestion.bleRssiThreshold} dBm${data.suggestion.bleOverlap ? " (OVERLAP)" : ""}`
                  : "—"
              }
              tone={data?.suggestion.bleOverlap ? "warn" : "default"}
            />
            <ValueRow
              label="suggested WiFi ≥"
              value={
                data?.suggestion.wifiRssiThreshold != null
                  ? `${data.suggestion.wifiRssiThreshold} dBm${data.suggestion.wifiOverlap ? " (OVERLAP)" : ""}`
                  : "—"
              }
              tone={data?.suggestion.wifiOverlap ? "warn" : "default"}
            />
            <View className="flex-row items-center gap-2">
              <Button
                className="flex-1"
                disabled={busy}
                onPress={() => void post("/calibrate/apply", {}, "thresholds applied")}
              >
                <Text>APPLY SUGGESTED</Text>
              </Button>
              <Button
                className="flex-1"
                variant="outline"
                disabled={busy}
                onPress={() => void post("/calibrate/reset", {}, "samples cleared")}
              >
                <Text>CLEAR SAMPLES</Text>
              </Button>
            </View>
          </CardContent>
        </Card>

        {/* Recent raw samples */}
        <Card>
          <CardHeader>
            <CardTitle>Samples</CardTitle>
            <CardDescription>last 8 captures per side (B…/W… dBm)</CardDescription>
          </CardHeader>
          <CardContent className="gap-2">
            <ValueRow label="INSIDE" value={lastVals(ins)} tone="ok" />
            <ValueRow label="OUTSIDE" value={lastVals(outs)} tone="bad" />
          </CardContent>
        </Card>
      </ScrollView>
    </View>
  );
}
