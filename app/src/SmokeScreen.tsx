import React, { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
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
import { colors, MONO, spacing, text } from "./theme";
import {
  AlertOverlay,
  BloomField,
  ConsoleHeader,
  Divider,
  HudButton,
  Panel,
  Scanlines,
} from "./components/hud";

type Log = (line: string) => void;

interface Check {
  id: string;
  label: string;
  /** Returns a short pass/fail summary line; throws to fail. */
  run: (log: Log) => Promise<string>;
  /** Requires a human/on-screen interaction; skipped by run=all. */
  manual?: boolean;
}

/** One full-screen console alert. */
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
          ["ultrasonic", await request(sensors.ultrasonic.requestPermissions?.())],
        ] as const);

        const unverified = requested.filter(([, ok]) => ok === null).map(([n]) => n);
        const denied = requested.filter(([, ok]) => ok === false).map(([n]) => n);

        if (denied.length > 0) throw new Error(`denied: ${denied.join(", ")}`);

        // Some prompts never returned; confirm via the non-prompting check.
        if (unverified.length > 0) {
          const fallback = await Promise.all([
            sensors.ble.getPermissions?.() ?? Promise.resolve(true),
            sensors.ultrasonic.getPermissions?.() ?? Promise.resolve(true),
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
        if (o.soshinRssi == null) throw new Error("no RSSI (location off?)");
        return `connected=${o.connectedToSoshin} rssi=${o.soshinRssi} dBm`;
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
  const logRef = useRef<ScrollView | null>(null);

  // Mirror everything to console so `adb logcat -s ReactNativeJS` captures
  // results for remote/headless runs (shusseki://smoke?run=all).
  const log = (line: string) => {
    const pretty = `${new Date().toLocaleTimeString()} ${line}`;
    setLogLines((prev) => [...prev, pretty]);
    console.log(`[smoke] ${line}`);
  };

  /** Cap a dump for the alert plate — keep the tail (most recent evidence). */
  const trimDump = (lines: string[]): string => {
    const trimmed = lines.slice(-36);
    const head = lines.length > trimmed.length ? `… ${lines.length - trimmed.length} earlier line(s) trimmed\n` : "";
    return head + trimmed.join("\n");
  };

  /** One check, one popup: PASS/FAIL with the full output dump. */
  const runOne = async (check: Check) => {
    setBusy(true);
    const dump: string[] = [];
    const cap = (l: string) => {
      dump.push(l);
      log(l);
    };
    console.log(`[smoke] ▶ ${check.label}`);
    try {
      const s = await check.run(cap);
      setSummary(`${check.id}: PASS — ${check.label}`);
      setAlert({
        title: "CHECK PASSED",
        jp: "項目合格",
        sub: check.label.toUpperCase(),
        detail: `RESULT: ${s}\n\nOUTPUT:\n${trimDump(dump)}`,
        tone: colors.green,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSummary(`${check.id}: FAIL — ${check.label}`);
      setAlert({
        title: "CHECK FAILED",
        jp: "項目異常",
        sub: check.label.toUpperCase(),
        detail: `ERROR: ${msg}\n\nOUTPUT:\n${trimDump(dump)}`,
        tone: colors.red,
      });
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
        continue;
      }
      automated += 1;
      cap(`▶ ${check.label}`);
      try {
        const s = await check.run(cap);
        passed += 1;
        cap(`  PASS ${s}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(check.label);
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

  return (
    <View style={styles.root}>
      <BloomField a={colors.amber} b={colors.green} />
      <ConsoleHeader
        jp="診断"
        en="DIAGNOSTICS · 自己診断"
        stateLabel={summary || "STANDBY"}
        stateTone={doneSomething && summary.includes("FAIL") ? colors.red : doneSomething ? colors.green : colors.dim}
        right={
          <HudButton variant="ghost" small title="EXIT" onPress={onExit} />
        }
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {/* Suite result plate — carries the maestro smoke-summary contract. */}
        <View style={styles.summaryPlate}>
          <Scanlines />
          <Text testID="smoke-summary" style={[text.interject, { fontSize: 33, color: colors.text, textAlign: "center" }]}>
            {summary || "NOT RUN / 未実行"}
          </Text>
          <Text style={[text.interjectSub, { color: colors.dim }]}>DIAGNOSTICS SUITE</Text>
        </View>

        <Panel title="CHECKS / 項目" tone={colors.amber} accentLabel="PER-MODALITY">
          {checksRef.current.map((c) => (
            <View key={c.id} style={styles.checkRow}>
              <Text style={[text.value, { color: colors.text, fontSize: 10, flex: 1 }]} numberOfLines={1}>
                {c.manual ? "[MANUAL] " : ""}{c.label}
              </Text>
              <HudButton
                variant="ghost"
                small
                title={busy ? "…" : "RUN"}
                disabled={busy}
                onPress={() => runOne(c)}
              />
            </View>
          ))}
        </Panel>

        <View style={styles.controls}>
          <HudButton variant="primary" title={busy ? "RUNNING…" : "RUN ALL / 全走査"} disabled={busy} onPress={() => void runAll()} />
          <HudButton variant="ghost" title="EXIT" onPress={onExit} />
        </View>

        <Panel title="OUTPUT / 出力" tone={colors.cyan} accentLabel="LOGCAT+MIRROR">
          <ScrollView ref={logRef} style={styles.log} onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: true })}>
            {logLines.map((l, i) => (
              <Text key={i} style={styles.logLine}>{l}</Text>
            ))}
          </ScrollView>
        </Panel>
      </ScrollView>

      {/* Check results land here: full-screen plate with the dump, not an
       * inline green update. */}
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 0, gap: 0 },
  summaryPlate: {
    backgroundColor: colors.field,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: 4,
    alignItems: "center",
    overflow: "hidden",
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 2,
    minHeight: 26,
  },
  controls: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
  },
  log: {
    maxHeight: 120,
    backgroundColor: colors.field,
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.line,
  },
  logLine: { fontFamily: MONO, fontSize: 10, color: colors.dim, lineHeight: 15 },
});