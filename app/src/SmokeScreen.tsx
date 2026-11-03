import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { generateTOTP } from "shared";
import { NativeSensors } from "./lib/nativeSensors";
import {
  bleGetPermissionsAsync,
  bleScanOnce,
  bleEnsureEnabled,
} from "expo-shusseki-ble";
import { wifiGetPermissionsAsync } from "expo-shusseki-wifi";
import { ultraGetPermissionsAsync, ultraLoopback, ultraListen } from "expo-shusseki-ultrasonic";
import type { Settings } from "./settings";
import { colors, MONO } from "./theme";
import { ScreenHeader } from "./components/tx/ScreenHeader";
import { ValueRow } from "./components/tx/ValueRow";
import { StateBadge, type StateTone } from "./components/tx/StateBadge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

type Log = (line: string) => void;

type CheckState = "pending" | "pass" | "fail" | "skipped" | "none";

interface Check {
  id: string;
  label: string;
  /** Returns a short pass/fail summary line; throws to fail. */
  run: (log: Log) => Promise<string>;
  /** Requires a human/on-screen interaction; skipped by run=all. */
  manual?: boolean;
}

/** Inline fold-out result plate (replaces the old full-screen alert overlay). */
interface ConsoleAlert {
  title: string;
  jp?: string;
  sub?: string;
  detail?: string;
  tone: string;
}

/**
 * On-hardware smoke tests. Each check exercises one modality directly against
 * the native modules (bypassing the hardened NativeSensors fallbacks) so raw
 * failures surface here instead of being swallowed.
 */
export function buildChecks(settings: Settings, serverUrl: string): Check[] {
  const sensors = new NativeSensors();

  return [
    {
      id: "perms-dump",
      label: "Permission status (no prompt)",
      run: async (log) => {
        for (const [name, get] of [
          ["ble", bleGetPermissionsAsync],
          ["wifi", wifiGetPermissionsAsync],
          ["ultrasonic", ultraGetPermissionsAsync],
        ] as const) {
          const r = await get();
          log(`  ${name}: ${r.status} (canAskAgain=${r.canAskAgain})`);
        }
        return "status printed";
      },
    },
    {
      id: "perms-request",
      label: "Request all runtime permissions",
      run: async () => {
        // Native requestPermissionsAsync intermittently hangs on real devices
        // when the permission controller isn't wired (see todo.md P5). Guard
        // each request with a timeout; if the prompt itself stalls, fall back
        // to the non-prompting check — permissions are pre-granted via
        // `adb pm grant` in the runbook anyway.
        const request = async (p: Promise<boolean> | undefined): Promise<boolean | null> => {
          if (!p) return null;
          try {
            return await withTimeout(p, 6000);
          } catch {
            return null; // prompt controller hung — treat as unverifiable
          }
        };

        const requested = await Promise.all([
          ["ble", await request(sensors.ble.requestPermissions?.())],
          ["wifi", await request(sensors.wifi.requestPermissions?.())],
        ] as const);

        const unverified = requested.filter(([, ok]) => ok === null).map(([n]) => n);
        const denied = requested.filter(([, ok]) => ok === false).map(([n]) => n);

        if (denied.length > 0) throw new Error(`denied: ${denied.join(", ")}`);

        // Some prompts never returned; confirm via the non-prompting check.
        if (unverified.length > 0) {
          const fallback = await Promise.all([
            sensors.ble.getPermissions?.() ?? Promise.resolve(true),
          ]);
          if (fallback.every(Boolean)) return "granted (prompt stalled; non-prompting check ok)";
          throw new Error(`unverified & not confirmed: ${unverified.join(", ")}`);
        }
        return "all granted";
      },
    },
    {
      id: "biometric",
      label: "Biometric prompt",
      manual: true,
      run: async () => {
        const b = await sensors.biometric.perform("fingerprint");
        if (!b.success) throw new Error(b.reason ?? "authentication failed/cancelled");
        return `${b.kind} ok`;
      },
    },
    {
      id: "ble-power",
      label: "Bluetooth power (on if possible)",
      run: async () => {
        // ensureEnabled can hang on some OEMs (deprecated adapter.enable path);
        // bound it so one stuck native call can't stall the whole suite.
        const enabled = await withTimeout(
          (async () => {
            await bleEnsureEnabled();
            const ok = await sensors.ble.requestPermissions?.();
            return ok ? "enabled + perms requested" : "enabled but perms denied";
          })(),
          12000,
        );
        return String(enabled);
      },
    },
    {
      id: "ble-adv",
      label: "BLE advertise 5s",
      run: async () => {
        await sensors.ble.start("soshin", {
          roomId: settings.roomId,
          nodeId: "smoke-soshin",
        });
        await new Promise((r) => setTimeout(r, 5000));
        await sensors.ble.stop();
        return "advertised 5s without error";
      },
    },
    {
      id: "ble-scan",
      label: "BLE scan 3s",
      run: async (log) => {
        const readings = await bleScanOnce(3000);
        const top = [...readings]
          .sort((a, b) => b.rssi - a.rssi)
          .slice(0, 5);
        for (const r of top) log(`  ${r.nodeId} ${r.rssi} dBm`);
        if (readings.length === 0)
          throw new Error("no devices visible (radio off or no perms?)");
        return `${readings.length} devices visible`;
      },
    },
    {
      id: "wifi-obs",
      label: "WiFi observation",
      run: async (log) => {
        const o = await sensors.wifi.observe();
        log(`  ssid=${o.ssid ?? "?"} bssid=${o.bssid ?? "?"}`);
        // RSSI is only meaningful while associated with the transmitter; a
        // missing AP is a valid observation (start the transmitter to join).
        if (o.connectedToSoshin && (o.soshinRssi == null || Number.isNaN(o.soshinRssi)))
          throw new Error("joined but no RSSI (location off?)");
        return o.soshinRssi != null
          ? `connected=${o.connectedToSoshin} rssi=${o.soshinRssi} dBm`
          : `connected=${o.connectedToSoshin} (no transmitter AP in range)`;
      },
    },
    {
      id: "hotspot",
      label: "Hotspot start/stop (LocalOnlyHotspot)",
      run: async (log) => {
        if (!sensors.wifi.startHotspot || !sensors.wifi.stopHotspot)
          throw new Error("adapter lacks hotspot support");
        const h = await sensors.wifi.startHotspot();
        log(`  ssid="${h.ssid}" pass="${h.passphrase}"`);
        await new Promise((r) => setTimeout(r, 3000));
        await sensors.wifi.stopHotspot();
        return `raised "${h.ssid}" for 3s`;
      },
    },
    {
      id: "ultra-presence",
      label: "Ultrasonic presence stamp (1.8kHz bursts)",
      run: async (log) => {
        // Concurrent transmit+record (speaker→mic) presence self-test.
        const o = await ultraLoopback(3000);
        log(
          `  received=${o.received} valid=${o.valid} snr=${o.snr?.toFixed(1) ?? "-"} ` +
            `miss=${o.missReason ?? "-"} ratio=${o.ratio?.toFixed(3) ?? "-"}`,
        );
        if (!o.received) throw new Error("chirp presence not detected on this hardware");
        return `presence detected, ratio ${o.ratio?.toFixed(2)}`;
      },
    },
    {
      id: "ultra-ambient",
      label: "Ultrasonic mic ambient check (no transmit)",
      run: async (log) => {
        const o = await ultraListen(2000);
        log(
          `  received=${o.received} snr=${o.snr?.toFixed(1) ?? "-"} ` +
            `miss=${o.missReason ?? "-"} ratio=${o.ratio?.toFixed(3) ?? "-"} ` +
            `energy=${o.energy != null ? o.energy.toFixed(0) : "-"}`,
        );
        if (o.energy == null || o.energy < 1e5) {
          throw new Error("mic delivered silence — RECORD_AUDIO/audio path problem");
        }
        return "mic OK (band energy present)";
      },
    },
    {
      id: "server-ping",
      label: `Server round-trip (${serverUrl})`,
      run: async (log) => {
        const secretBytes = new TextEncoder().encode(settings.secret);
        const create = await fetch(`${serverUrl}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: settings.sessionId,
            roomId: settings.roomId,
            secret: settings.secret,
          }),
        });
        log(`  sessions: ${create.status} ${await create.text()}`);

        const now = Date.now();
        const res = await fetch(`${serverUrl}/api/reports`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceId: "smoke-tester",
            mode: "jushin",
            roomId: settings.roomId,
            sessionId: settings.sessionId,
            timestamp: now,
            ultrasonic: {
              received: true,
              valid: true,
              code: generateTOTP(secretBytes, now),
              snr: null,
            },
          }),
        });
        const body = await res.text();
        log(`  reports: ${res.status} ${body}`);
        if (!res.ok) throw new Error(`report rejected (${res.status})`);
        return "ingest + verification OK";
      },
    },
  ];
}

export default function SmokeScreen({
  settings,
  serverUrl,
  autoRun,
  onExit,
}: {
  settings: Settings;
  serverUrl: string;
  autoRun?: string;
  onExit: () => void;
}) {
  const checksRef = useRef<Check[] | null>(null);
  if (checksRef.current === null) checksRef.current = buildChecks(settings, serverUrl);

  const [logLines, setLogLines] = useState<string[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<ConsoleAlert | null>(null);
  const [results, setResults] = useState<Record<string, CheckState>>({});
  const [resultsOpen, setResultsOpen] = useState(false);
  const logRef = useRef<ScrollView | null>(null);

  // Mirror everything to console so `adb logcat -s ReactNativeJS` captures
  // results for remote/headless runs (shusseki://smoke?run=all).
  const log = (line: string) => {
    const pretty = `${new Date().toLocaleTimeString()} ${line}`;
    setLogLines((prev) => [...prev, pretty]);
    console.log(`[smoke] ${line}`);
  };

  /** Cap a dump for the result plate — keep the tail (most recent evidence). */
  const trimDump = (lines: string[]): string => {
    const trimmed = lines.slice(-36);
    const head = lines.length > trimmed.length ? `… ${lines.length - trimmed.length} earlier line(s) trimmed\n` : "";
    return head + trimmed.join("\n");
  };

  /** One check, one inline result card: PASS/FAIL with the full output dump. */
  const runOne = async (check: Check) => {
    setBusy(true);
    setResults((r) => ({ ...r, [check.id]: "pending" }));
    const dump: string[] = [];
    const cap = (l: string) => {
      dump.push(l);
      log(l);
    };
    console.log(`[smoke] ▶ ${check.label}`);
    try {
      const s = await check.run(cap);
      setResults((r) => ({ ...r, [check.id]: "pass" }));
      setSummary(`${check.id}: PASS — ${check.label}`);
      setAlert({
        title: "CHECK PASSED",
        jp: "項目合格",
        sub: check.label.toUpperCase(),
        detail: `RESULT: ${s}\n\nOUTPUT:\n${trimDump(dump)}`,
        tone: colors.green,
      });
      setResultsOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setResults((r) => ({ ...r, [check.id]: "fail" }));
      setSummary(`${check.id}: FAIL — ${check.label}`);
      setAlert({
        title: "CHECK FAILED",
        jp: "項目異常",
        sub: check.label.toUpperCase(),
        detail: `ERROR: ${msg}\n\nOUTPUT:\n${trimDump(dump)}`,
        tone: colors.red,
      });
      setResultsOpen(false);
    }
    setBusy(false);
  };

  const runAll = async () => {
    setBusy(true);
    console.log("[smoke] START run=all");
    const dump: string[] = [];
    const cap = (l: string) => {
      dump.push(l);
      log(l);
    };
    let passed = 0;
    let automated = 0;
    let skipped = 0;
    const failures: string[] = [];
    for (const check of checksRef.current!) {
      if (check.manual) {
        skipped += 1;
        cap(`⏭ ${check.label} (manual, skipped)`);
        setResults((r) => ({ ...r, [check.id]: "skipped" }));
        continue;
      }
      automated += 1;
      setResults((r) => ({ ...r, [check.id]: "pending" }));
      cap(`▶ ${check.label}`);
      try {
        const s = await check.run(cap);
        passed += 1;
        setResults((r) => ({ ...r, [check.id]: "pass" }));
        cap(`  PASS ${s}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(check.label);
        setResults((r) => ({ ...r, [check.id]: "fail" }));
        cap(`  FAIL ${msg}`);
      }
    }
    const counts = `${passed}/${automated} automated passed (${skipped} manual skipped)`;
    cap(`■ done: ${counts}`);
    console.log(`[smoke] ■ done: ${counts}`);
    setSummary(counts);
    setAlert({
      title: failures.length === 0 ? "SUITE COMPLETE" : "SUITE COMPLETE · FAULTS",
      jp: failures.length === 0 ? "全走査完了" : "異常混入",
      sub: failures.length === 0 ? counts.toUpperCase() : `${counts.toUpperCase()} · FAILURES: ${failures.join(" / ")}`,
      detail: trimDump(dump),
      tone: failures.length > 0 ? colors.red : colors.green,
    });
    setResultsOpen(false);
    setBusy(false);
  };

  useEffect(() => {
    if (!autoRun) return;
    if (autoRun === "all") {
      void runAll();
    } else {
      const check = checksRef.current?.find((c) => c.id === autoRun);
      if (check) void runOne(check);
      else log(`✗ unknown check "${autoRun}"`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  const doneSomething = summary !== "";

  const checkTone = (state: CheckState | undefined): StateTone => {
    switch (state) {
      case "pass":
        return "ok";
      case "fail":
        return "bad";
      case "skipped":
        return "muted";
      case "pending":
        return "warn";
      default:
        return "outline";
    }
  };

  const checkLabel = (state: CheckState | undefined): string => {
    switch (state) {
      case "pass":
        return "PASS";
      case "fail":
        return "FAIL";
      case "skipped":
        return "SKIPPED";
      case "pending":
        return "RUNNING";
      default:
        return "NOT RUN";
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Diagnostics · 診断"
        onExit={onExit}
        right={
          <StateBadge
            tone={doneSomething && summary.includes("FAIL") ? "bad" : doneSomething ? "ok" : "muted"}
          >
            {busy ? "RUNNING…" : doneSomething ? "RUN COMPLETE" : "STANDBY"}
          </StateBadge>
        }
      />
      <ScrollView className="flex-1" contentContainerClassName="p-4 gap-4">
        {/* Suite result — carries the maestro smoke-summary contract. */}
        <Card>
          <CardHeader>
            <View className="flex-row items-center justify-between gap-2">
              <CardTitle>Smoke suite</CardTitle>
              <StateBadge
                mono
                tone={
                  doneSomething && summary.includes("FAIL")
                    ? "bad"
                    : doneSomething
                      ? "ok"
                      : "muted"
                }
              >
                DIAGNOSTICS
              </StateBadge>
            </View>
            <Text
              testID="smoke-summary"
              className="text-foreground"
              style={{ fontFamily: MONO }}
              numberOfLines={2}
            >
              {summary || "NOT RUN / 未実行"}
            </Text>
          </CardHeader>
        </Card>

        {/* Checks grouped as one card per modality row */}
        <Card>
          <CardHeader>
            <CardTitle>Checks</CardTitle>
            <CardDescription>one modality per row · run=all skips manual</CardDescription>
          </CardHeader>
          <CardContent className="gap-2">
            {checksRef.current.map((c) => {
              const state = results[c.id];
              return (
                <Card key={c.id} className="bg-transparent py-3">
                  <CardContent className="flex-row items-center gap-2 px-3">
                    <View className="shrink">
                      <Text className="text-sm text-foreground" numberOfLines={2}>
                        {c.label}
                      </Text>
                      {c.manual && (
                        <Text className="text-[10px] text-muted-foreground">manual only</Text>
                      )}
                    </View>
                    <View className="flex-1" />
                    <StateBadge mono tone={checkTone(state)}>
                      {checkLabel(state)}
                    </StateBadge>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || c.manual}
                      onPress={() => void runOne(c)}
                    >
                      <Text>{busy ? "…" : "RUN"}</Text>
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </CardContent>
        </Card>

        <View className="flex-row items-center gap-2">
          <Button
            className="flex-1"
            disabled={busy}
            onPress={() => void runAll()}
          >
            <Text>{busy ? "RUNNING…" : "RUN ALL / 全走査"}</Text>
          </Button>
          <Button className="flex-1" variant="outline" onPress={onExit}>
            <Text>EXIT</Text>
          </Button>
        </View>

        {/* Foldable JSON result (default collapsed) */}
        {alert && (
          <Card
            className={
              alert.tone === colors.red
                ? "border-red-900/60"
                : "border-emerald-900/60"
            }
          >
            <CardContent>
              <Pressable onPress={() => setResultsOpen((o) => !o)}>
                <View className="gap-1">
                  <View className="flex-row items-center justify-between gap-2">
                    <Text className="text-sm font-semibold text-foreground">
                      {alert.title}
                    </Text>
                    <StateBadge
                      mono
                      tone={alert.tone === colors.red ? "bad" : "ok"}
                    >
                      {resultsOpen ? "▼ DETAILS" : "▶ DETAILS"}
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
                  <Text className="text-[10px] text-muted-foreground">
                    tap to {resultsOpen ? "collapse" : "expand"} the JSON result
                  </Text>
                  {resultsOpen && alert.detail && (
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

        {/* Logcat mirror */}
        <Card>
          <CardHeader>
            <View className="flex-row items-center justify-between gap-2">
              <CardTitle>Output</CardTitle>
              <ValueRow label="lines" value={String(logLines.length)} tone="muted" />
            </View>
            <CardDescription>adb logcat -s ReactNativeJS mirror</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollView
              ref={logRef}
              className="h-32 rounded-md border border-border bg-transparent p-2"
              onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: true })}
            >
              {logLines.map((l, i) => (
                <Text
                  key={i}
                  className="text-xs leading-5 text-muted-foreground"
                  style={{ fontFamily: MONO }}
                >
                  {l}
                </Text>
              ))}
              {logLines.length === 0 && (
                <Text className="text-xs text-muted-foreground">no output yet…</Text>
              )}
            </ScrollView>
          </CardContent>
        </Card>
      </ScrollView>
    </View>
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}
