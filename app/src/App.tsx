import React, { useRef, useState } from "react";
import {
  Button,
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

const SERVER_URL =
  (process.env.EXPO_PUBLIC_SERVER_URL as string | undefined) ??
  "http://10.0.2.2:8787";

// Stable-enough device id for the prototype (resets on reinstall).
const DEVICE_ID = `phone-${crypto.randomUUID().slice(0, 8)}`;

type Mode = "none" | "soshin" | "jushin";

interface Settings {
  roomId: string;
  sessionId: string;
  soshinSsid: string;
  secret: string; // shared rolling-code secret (Soshin side + server session)
}

const DEFAULT_SETTINGS: Settings = {
  roomId: "room-1",
  sessionId: "sess-1",
  soshinSsid: "Shusseki-1",
  secret: "change-me-shared-secret",
};

export default function App() {
  const scheme = useColorScheme();
  const [mode, setMode] = useState<Mode>("none");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

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
          </View>
        )}

        {mode !== "none" && (
          <SettingsForm settings={settings} onChange={setSettings} />
        )}

        {mode === "soshin" && (
          <SoshinScreen settings={settings} onExit={() => setMode("none")} />
        )}
        {mode === "jushin" && (
          <JushinScreen settings={settings} onExit={() => setMode("none")} />
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
    await controller.start();
    controllerRef.current = controller;
    setRunning(true);

    const loop = async () => {
      const c = await controller.broadcast(Date.now());
      setCode(c);
    };
    await loop();
    intervalRef.current = setInterval(loop, 30_000);
  };

  const stop = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    setRunning(false);
    setCode(null);
  };

  return (
    <View style={styles.card}>
      <Text style={styles.modeTitle}>Soshin — room-side</Text>
      <Text style={styles.body}>
        Broadcasts an ultrasonic rolling code and advertises a BLE beacon.
      </Text>
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
    };
    const controller = new JushinController(sensors, config, reporter);
    const b = await controller.startAttendance();
    setBio(`${b.kind} (${b.success ? "ok" : "failed"})`);
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
