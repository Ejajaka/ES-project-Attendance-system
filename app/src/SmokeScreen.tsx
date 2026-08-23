import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
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

type Log = (line: string) => void;

interface Check {
  id: string;
  label: string;
  /** Returns a short pass/fail summary line; throws to fail. */
  run: (log: Log) => Promise<string>;
  /** Requires a human/on-screen interaction; skipped by run=all. */
  manual?: boolean;
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
        const results = [
          ["ble", await sensors.ble.requestPermissions?.()],
          ["wifi", await sensors.wifi.requestPermissions?.()],
          ["ultrasonic", await sensors.ultrasonic.requestPermissions?.()],
        ] as const;
        const denied = results.filter(([, ok]) => !ok).map(([n]) => n);
        if (denied.length > 0) throw new Error(`denied: ${denied.join(", ")}`);
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
        await bleEnsureEnabled();
        const ok = await sensors.ble.requestPermissions?.();
        return ok ? "enabled + perms requested" : "enabled but perms denied";
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

  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<ScrollView | null>(null);

  // Mirror everything to console so `adb logcat -s ReactNativeJS` captures
  // results for remote/headless runs (shusseki://smoke?run=all).
  const log = (line: string) => {
    const pretty = `${new Date().toLocaleTimeString()} ${line}`;
    setLogLines((prev) => [...prev, pretty]);
    console.log(`[smoke] ${line}`);
  };

  const mark = (id: string, s: string) => {
    setStatuses((prev) => ({ ...prev, [id]: s }));
    console.log(`[smoke] ${id}=${s}`);
  };

  const runCheck = async (check: Check): Promise<boolean> => {
    mark(check.id, "…");
    try {
      const summary = await check.run(log);
      mark(check.id, `✓ ${summary}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mark(check.id, `✗ ${msg}`);
      log(`  ERROR: ${msg}`);
      return false;
    }
  };

  const runOne = async (check: Check) => {
    setBusy(true);
    const ok = await runCheck(check);
    setSummary(`${check.id}: ${ok ? "PASS" : "FAIL"} — ${check.label}`);
    setBusy(false);
  };

  const runAll = async () => {
    setBusy(true);
    console.log("[smoke] START run=all");
    let passed = 0;
    let automated = 0;
    let skipped = 0;
    for (const check of checksRef.current!) {
      if (check.manual) {
        skipped += 1;
        log(`⏭ ${check.label} (manual, skipped)`);
        continue;
      }
      automated += 1;
      log(`▶ ${check.label}`);
      if (await runCheck(check)) passed += 1;
    }
    log(`■ done: ${passed}/${automated} automated passed (${skipped} manual skipped)`);
    setSummary(`${passed}/${automated} automated passed (${skipped} manual skipped)`);
    setBusy(false);
  };

  useEffect(() => {
    if (!autoRun) return;
    if (autoRun === "all") {
      runAll();
    } else {
      const check = checksRef.current?.find((c) => c.id === autoRun);
      if (check) runOne(check);
      else log(`✗ unknown check "${autoRun}"`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  return (
    <View style={styles.card}>
      <Text style={styles.modeTitle}>Smoke tests</Text>
      <Text style={styles.body}>
        One check per modality, straight against the native modules. Grant
        permissions first; expect real hardware quirks.
      </Text>
      <Text testID="smoke-summary" style={styles.summary}>
        {summary || "not run"}
      </Text>
      {checksRef.current.map((c) => (
        <View key={c.id} style={styles.checkRow}>
          <Text style={styles.checkLabel}>{c.label}</Text>
          <Button
            title={busy ? "…" : "Run"}
            disabled={busy}
            onPress={() => runOne(c)}
          />
          {statuses[c.id] && <Text style={styles.checkStatus}>{statuses[c.id]}</Text>}
        </View>
      ))}
      <View style={styles.row}>
        <Button title={busy ? "Running…" : "Run all"} disabled={busy} onPress={runAll} />
        <Button title="Exit" onPress={onExit} />
      </View>
      <ScrollView ref={logRef} style={styles.log} onContentSizeChange={() => logRef.current?.scrollToEnd()}>
        {logLines.map((l, i) => (
          <Text key={i} style={styles.logLine}>
            {l}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  modeTitle: { fontSize: 18, fontWeight: "600" },
  body: { fontSize: 14 },
  summary: { fontSize: 15, fontWeight: "600", fontFamily: "monospace" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  checkRow: { gap: 2 },
  checkLabel: { fontSize: 14, fontWeight: "500" },
  checkStatus: { fontSize: 13, fontFamily: "monospace" },
  log: {
    maxHeight: 220,
    backgroundColor: "#f5f5f5",
    borderRadius: 8,
    padding: 8,
  },
  logLine: { fontFamily: "monospace", fontSize: 11 },
});
