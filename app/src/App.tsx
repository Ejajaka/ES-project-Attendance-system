import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Linking,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useColorScheme } from "react-native";
import type { DeviceReport } from "shared";
import { NativeSensors } from "./lib/nativeSensors";
import { HttpReporter } from "./lib/reporter";
import { SoshinController, type SoshinConfig } from "./lib/modes/soshin";
import { JushinController, type JushinConfig } from "./lib/modes/jushin";
import { SERVER_URL, DEFAULT_SETTINGS, type Settings } from "./settings";
import SmokeScreen from "./SmokeScreen";
import E2eScreen from "./E2eScreen";
import type { E2eRole } from "./lib/modes/e2e";

// Stable-enough device id for the prototype (resets on reinstall).
// Prefers crypto.randomUUID() when the runtime exposes it, but falls back to a
// pseudo-random id — Hermes / React Native doesn't always provide a global
// `crypto` object (it's absent on Android release builds).
function randomIdPrefix(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.();
  if (uuid) return uuid.slice(0, 8);
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  ).slice(0, 8);
}

const DEVICE_ID = `phone-${randomIdPrefix()}`;

type Mode = "none" | "soshin" | "jushin" | "smoke" | "e2e";

/** Deep-linking target parsed from `shusseki://<path>?<query>`. */
type Launch =
  | { screen: "smoke"; autoRun?: string }
  | { screen: "e2e"; role: E2eRole };

function parseLaunch(url: string | null): Launch | null {
  if (!url || !url.startsWith("shusseki://")) return null;
  const rest = url.slice("shusseki://".length);
  const [path, query] = rest.split("?");
  const params: Record<string, string> = {};
  for (const kv of (query ?? "").split("&")) {
    const [k, v] = kv.split("=");
    if (k) params[k] = decodeURIComponent(v ?? "");
  }
  if (path === "smoke") return { screen: "smoke", autoRun: params["run"] };
  if (path === "e2e") {
    const role = (params["role"] ?? "both") as E2eRole;
    return { screen: "e2e", role };
  }
  return null;
}

export default function App() {
  const scheme = useColorScheme();
  const [mode, setMode] = useState<Mode>("none");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [launch, setLaunch] = useState<Launch | null>(null);

  // Remote/hardware hook: `shusseki://smoke?run=all` or `shusseki://e2e?role=…`
  // boots straight into the automated suite; results stream to logcat.
  useEffect(() => {
    const onUrl = (url: string | null) => {
      const l = parseLaunch(url);
      if (!l) return;
      setLaunch(l);
      setMode(l.screen);
    };
    Linking.getInitialURL().then(onUrl);
    const sub = Linking.addEventListener("url", (e) => onUrl(e.url));
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Shusseki</Text>
        <Text style={styles.subtitle}>Room-level continuous attendance</Text>
        <Text style={styles.device}>device: {DEVICE_ID}</Text>

        {mode === "none" && (
          <View style={styles.row}>
            <Button title="Run as Soshin (room)" onPress={() => setMode("soshin")} />
            <Button title="Run as Jushin (phone)" onPress={() => setMode("jushin")} />
            <Button title="Smoke tests" onPress={() => setMode("smoke")} />
            <Button
              title="E2E test (both)"
              onPress={() => {
                setLaunch({ screen: "e2e", role: "both" });
                setMode("e2e");
              }}
            />
          </View>
        )}

        {mode !== "none" && mode !== "smoke" && (
          <SettingsForm settings={settings} onChange={setSettings} />
        )}

        {mode === "soshin" && (
          <SoshinScreen settings={settings} onExit={() => setMode("none")} />
        )}
        {mode === "jushin" && (
          <JushinScreen settings={settings} onExit={() => setMode("none")} />
        )}
        {mode === "smoke" && (
          <SmokeScreen
            settings={settings}
            serverUrl={SERVER_URL}
            autoRun={launch?.screen === "smoke" ? launch.autoRun : undefined}
            onExit={() => {
              setMode("none");
              setLaunch(null);
            }}
          />
        )}
        {mode === "e2e" && (
          <E2eScreen
            settings={settings}
            serverUrl={SERVER_URL}
            role={launch?.screen === "e2e" ? launch.role : "both"}
            onExit={() => {
              setMode("none");
              setLaunch(null);
            }}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SettingsForm({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  return (
    <View style={styles.card}>
      <Field
        label="Room ID"
        value={settings.roomId}
        onChange={(v) => onChange({ ...settings, roomId: v })}
      />
      <Field
        label="Session ID"
        value={settings.sessionId}
        onChange={(v) => onChange({ ...settings, sessionId: v })}
      />
      <Field
        label="Soshin SSID"
        value={settings.soshinSsid}
        onChange={(v) => onChange({ ...settings, soshinSsid: v })}
      />
      <Field
        label="Soshin hotspot password"
        value={settings.soshinPass ?? ""}
        onChange={(v) => onChange({ ...settings, soshinPass: v })}
        secure
      />
      <Field
        label="Shared secret"
        value={settings.secret}
        onChange={(v) => onChange({ ...settings, secret: v })}
        secure
      />
      <Text style={styles.hint}>
        The Soshin secret must match the one used when creating the server
        session ({SERVER_URL}/api/sessions).
      </Text>
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  secure,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secure?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        autoCapitalize="none"
      />
    </View>
  );
}

function SoshinScreen({
  settings,
  onExit,
}: {
  settings: Settings;
  onExit: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [hotspot, setHotspot] = useState<string | null>(null);
  const controllerRef = useRef<SoshinController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = async () => {
    const sensors = new NativeSensors();
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
    setRunning(true);
    if (h) setHotspot(`"${h.ssid}" pass "${h.passphrase}"`);

    const loop = async () => {
      const c = await controller.broadcast(Date.now());
      setCode(c);
    };
    await loop();
    intervalRef.current = setInterval(loop, 30_000);
  };

  const stop = async () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (controllerRef.current) {
      try {
        await controllerRef.current.stop(); // hotspot + BLE beacon teardown
      } catch (e) {
        console.warn("[soshin] stop failed:", e);
      }
    }
    controllerRef.current = null;
    setRunning(false);
    setCode(null);
    setHotspot(null);
  };

  return (
    <View style={styles.card}>
      <Text style={styles.modeTitle}>Soshin — room-side</Text>
      <Text style={styles.body}>
        Hosts a local WiFi hotspot, advertises a BLE beacon, and broadcasts the
        ultrasonic rolling code.
      </Text>
      {hotspot && <Text style={styles.code}>Hotspot: {hotspot}</Text>}
      <Text style={styles.code}>Current code: {code ?? "—"}</Text>
      <View style={styles.row}>
        {!running ? (
          <Button title="Start broadcasting" onPress={start} />
        ) : (
          <Button title="Stop" onPress={stop} />
        )}
        <Button title="Exit" onPress={onExit} />
      </View>
    </View>
  );
}

function JushinScreen({
  settings,
  onExit,
}: {
  settings: Settings;
  onExit: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [lastReport, setLastReport] = useState<DeviceReport | null>(null);
  const [bio, setBio] = useState<string>("not performed");
  const controllerRef = useRef<JushinController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = async () => {
    const sensors = new NativeSensors();
    const reporter = new HttpReporter(SERVER_URL);
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
    controllerRef.current = controller;
    setRunning(true);

    const loop = async () => {
      const report = await controller.tick(Date.now());
      setLastReport(report);
    };
    await loop();
    intervalRef.current = setInterval(loop, 5_000);
  };

  const stop = async () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (controllerRef.current) await controllerRef.current.endAttendance();
    setRunning(false);
  };

  return (
    <View style={styles.card}>
      <Text style={styles.modeTitle}>Jushin — phone-side</Text>
      <Text style={styles.body}>
        Connects to the Soshin WiFi, listens for the ultrasonic code, reports
        BLE + WiFi, and sends everything to the server.
      </Text>
      <Text style={styles.body}>Biometric: {bio}</Text>
      {lastReport && (
        <View style={styles.reportBox}>
          <Text style={styles.label}>Last report</Text>
          <Text style={styles.mono}>
            BLE nodes: {lastReport.ble?.readings.length ?? 0}
          </Text>
          <Text style={styles.mono}>
            WiFi connected: {String(lastReport.wifi?.connectedToSoshin)}
          </Text>
          <Text style={styles.mono}>
            Ultrasonic received: {String(lastReport.ultrasonic?.received)}
          </Text>
        </View>
      )}
      <View style={styles.row}>
        {!running ? (
          <Button title="Start attendance" onPress={start} />
        ) : (
          <Button title="End attendance" onPress={stop} />
        )}
        <Button title="Exit" onPress={onExit} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 16, gap: 12 },
  title: { fontSize: 28, fontWeight: "700" },
  subtitle: { fontSize: 14, opacity: 0.7, marginBottom: 8 },
  device: { fontSize: 12, opacity: 0.5 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  card: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  modeTitle: { fontSize: 18, fontWeight: "600" },
  body: { fontSize: 14 },
  code: { fontSize: 16, fontWeight: "600", fontFamily: "monospace" },
  hint: { fontSize: 12, opacity: 0.6 },
  field: { gap: 4 },
  label: { fontSize: 12, opacity: 0.7 },
  input: {
    borderWidth: 1,
    borderColor: "#aaa",
    borderRadius: 8,
    padding: 8,
    fontSize: 14,
  },
  reportBox: { gap: 4, backgroundColor: "#f5f5f5", padding: 10, borderRadius: 8 },
  mono: { fontFamily: "monospace", fontSize: 13 },
});
