import React, { useEffect, useState } from "react";
import { Linking, ScrollView, StatusBar, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { useKeepAwake } from "expo-keep-awake";
import type { E2eRole } from "./lib/modes/e2e";
import type { Settings } from "./settings";
import {
  applyPreset,
  DEFAULT_SETTINGS,
  ROOM_PRESETS,
  presetById,
} from "./lib/presets";
import { useSessionPresence } from "./lib/useSessionPresence";
import { loadPersistentDeviceId } from "./lib/persistentDeviceId";
import { colors, MONO } from "./theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { DataRow } from "./components/DataRow";
import { Chevron } from "./components/Chevron";
import { VERSION } from "./version";
import SoshinScreen from "./SoshinScreen";
import JushinScreen from "./JushinScreen";
import DebugScreen from "./DebugScreen";
import SmokeScreen from "./SmokeScreen";
import E2eScreen from "./E2eScreen";
import CalibrateScreen from "./CalibrateScreen";

type Mode = "none" | "soshin" | "jushin" | "smoke" | "e2e" | "calibrate" | "debug";

/** Deep-linking target parsed from `shusseki://<path>?<query>`. */
type Launch =
  | { screen: "smoke"; autoRun?: string }
  | { screen: "e2e"; role: E2eRole }
  | { screen: "calibrate" }
  | { screen: "debug" }
  | { screen: "jushin"; autoEngage: true; studentId?: string; studentName?: string; bioSkip?: boolean }
  | { screen: "soshin"; autoEngage: true };

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
  // Headless console auto-engage (adb driven): shusseki://rx | shusseki://tx.
  // `rx` also accepts identity: shusseki://rx?roll=bl.1&name=Ada%20Lovelace
  // and `bio=0` to run without ever raising a biometric prompt.
  if (path === "rx") {
    return {
      screen: "jushin",
      autoEngage: true,
      studentId: params["roll"] || params["studentId"] || undefined,
      studentName: params["name"] || undefined,
      bioSkip: params["bio"] === "0",
    };
  }
  if (path === "tx") return { screen: "soshin", autoEngage: true };
  if (path === "calibrate") return { screen: "calibrate" };
  if (path === "debug") return { screen: "debug" };
  return null;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("none");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [uptime, setUptime] = useState(0);
  // Bundled pixel-mono face (Departure Mono, OFL) — the console's readout voice.
  const [fontsLoaded] = useFonts({
    DepartureMono: require("../assets/fonts/DepartureMono-Regular.otf"),
  });

  // Remote/hardware start: `shusseki://smoke?run=all` or `shusseki://e2e?role=…`
  // boots straight into the automated suite; results stream to logcat.
  useEffect(() => {
    console.log(`[app] version ${VERSION}`);
    const onUrl = (url: string | null) => {
      const l = parseLaunch(url);
      if (!l) return;
      if (l.screen === "jushin" && (l.studentId || l.studentName)) {
        setSettings((s) => ({
          ...s,
          studentId: l.studentId ?? s.studentId,
          studentName: l.studentName ?? s.studentName,
        }));
      }
      setLaunch(l);
      setMode(l.screen);
    };
    Linking.getInitialURL().then(onUrl);
    const sub = Linking.addEventListener("url", (e) => onUrl(e.url));
    return () => sub.remove();
  }, []);

  // Home uptime ticker (frozen while a mode console is running).
  useEffect(() => {
    if (mode !== "none") return;
    setUptime(0);
    const t = setInterval(() => setUptime((u) => u + 1), 1000);
    return () => clearInterval(t);
  }, [mode]);

  if (!fontsLoaded) {
    // Hold on the palette background until the display face is ready
    // (sub-second on device).
    return (
      <SafeAreaProvider>
        <SafeAreaView className="dark flex-1 bg-background" edges={["top", "left", "right", "bottom"]} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      {/* App shell owns `dark` once — screens render the standard dark palette. */}
      <SafeAreaView className="dark flex-1 bg-background" edges={["top", "left", "right", "bottom"]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} hidden={false} />
        {mode !== "none" && <ActiveKeepAwake />}
        {mode === "none" ? (
          <HomeScreen
            settings={settings}
            uptime={uptime}
            onSettingsChange={setSettings}
            onPick={(m, l) => {
              setMode(m);
              setLaunch(l ?? null);
            }}
          />
        ) : (
          <View className="flex-1">
            {mode === "soshin" && (
              <SoshinScreen
                settings={settings}
                serverUrl={settings.serverUrl}
                autoEngage={launch?.screen === "soshin" ? launch.autoEngage : false}
                onExit={() => setMode("none")}
              />
            )}
            {mode === "jushin" && (
              <JushinScreen
                settings={settings}
                serverUrl={settings.serverUrl}
                autoEngage={launch?.screen === "jushin" ? launch.autoEngage : false}
                bioSkip={launch?.screen === "jushin" ? launch.bioSkip : false}
                onExit={() => setMode("none")}
              />
            )}
            {mode === "debug" && (
              <DebugScreen
                settings={settings}
                onExit={() => {
                  setMode("none");
                  setLaunch(null);
                }}
              />
            )}
            {mode === "smoke" && (
              <SmokeScreen
                settings={settings}
                serverUrl={settings.serverUrl}
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
                serverUrl={settings.serverUrl}
                role={launch?.screen === "e2e" ? launch.role : "both"}
                onExit={() => {
                  setMode("none");
                  setLaunch(null);
                }}
              />
            )}
            {mode === "calibrate" && (
              <CalibrateScreen settings={settings} onExit={() => setMode("none")} />
            )}
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/* ------------------------------------------------------------------ *
 * Home — pick a role, bind a preset, edit server/identity settings.
 * ------------------------------------------------------------------ */
function HomeScreen({
  settings,
  uptime,
  onSettingsChange,
  onPick,
}: {
  settings: Settings;
  uptime: number;
  onSettingsChange: (s: Settings) => void;
  onPick: (m: Mode, l?: Launch) => void;
}) {
  // The persisted report identity (same source the receiver engages with) —
  // resolved once on mount, never minted repeatedly while ticking.
  const [deviceId, setDeviceId] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void loadPersistentDeviceId().then((id) => {
      if (mounted) setDeviceId(id);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Latest room verdict (only meaningful on dev servers running the suite).
  const { devices } = useSessionPresence(settings.serverUrl, settings.sessionId, true);
  const mine = devices.find((d) => deviceId != null && d.deviceId === deviceId) ?? null;
  const freshest = devices
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;

  const mm = Math.floor(uptime / 60).toString().padStart(2, "0");
  const ss = (uptime % 60).toString().padStart(2, "0");

  return (
    <ScrollView className="flex-1">
      <View className="gap-4 p-4 pb-8">
        {/* STATUS — device identity, build, preset badge, uptime + verdict */}
        <Card>
          <CardHeader className="gap-2">
            <View className="flex-row items-center justify-between">
              <CardTitle className="text-xl">Shusseki 出席</CardTitle>
              <Text
                className="text-xs text-muted-foreground"
                style={{ fontFamily: MONO }}
              >
                {VERSION}
              </Text>
            </View>
            <View className="flex-row flex-wrap items-center gap-1.5">
              <Badge variant="secondary">
                <Text>{presetById(settings.presetId).name}</Text>
              </Badge>
              <Badge variant="outline">
                <Text>session {settings.sessionId}</Text>
              </Badge>
              {mine && (
                <Badge variant={mine.present ? "default" : "destructive"}>
                  <Text>{mine.present ? "present" : "absent"}</Text>
                </Badge>
              )}
            </View>
            <CardDescription style={{ fontFamily: MONO }}>
              DEVICE {deviceId ?? "resolving…"} · SERVER {settings.serverUrl}
            </CardDescription>
            {freshest && (
              <CardDescription>
                freshest device in session:{" "}
                {freshest.deviceId === deviceId ? "this phone" : freshest.deviceId} ·{" "}
                {freshest.present ? "present" : "absent"} · fused{" "}
                {freshest.fused.toFixed(3)} ({freshest.mode === "soshin" ? "transmitter" : "receiver"})
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <DataRow label="uptime (this visit)" value={`${mm}:${ss}`} />
          </CardContent>
        </Card>

        {/* PRIMARY ACTIONS */}
        <ActionCard
          title="Receiver"
              description="Listen to the room: BLE + WiFi fusion, biometric check, report to the session."
          onPress={() => onPick("jushin")}
          testID="home-open-receiver"
        />
        <ActionCard
          title="Transmitter"
          description="Room host: announce the hotspot, beacon BLE, broadcast the rolling code."
          onPress={() => onPick("soshin")}
          testID="home-open-transmitter"
        />
        <ActionCard
          title="Debug"
          description="Environment, room node, raw sensor triggers and server payloads."
          onPress={() => onPick("debug")}
          testID="home-open-debug"
        />

        {/* SETTINGS — same fields the consoles read, restyled with ui primitives */}
        <SettingsCard settings={settings} onChange={onSettingsChange} />

        <Separator />
        <View className="flex-row flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            role="link"
            onPress={() => onPick("e2e", { screen: "e2e", role: "both" })}
          >
            <Text>E2E</Text>
          </Button>
          <Button variant="ghost" size="sm" role="link" onPress={() => onPick("calibrate")}>
            <Text>Calibrate</Text>
          </Button>
          <Button variant="ghost" size="sm" role="link" onPress={() => onPick("smoke")}>
            <Text>Smoke</Text>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            role="link"
            onPress={() =>
              void Linking.openURL(
                `${settings.serverUrl}/dashboard/${encodeURIComponent(settings.sessionId)}`,
              ).catch((e) => console.log("[app] dashboard open failed:", e))
            }
          >
            <Text>Dashboard</Text>
          </Button>
        </View>
        <Text className="text-xs text-muted-foreground">
          adb reverse tcp:8787 tcp:8787 · server: cd server &amp;&amp; npm run dev ·
          shusseki://smoke?run=all · shusseki://e2e?role=both · shusseki://debug
        </Text>
      </View>
    </ScrollView>
  );
}

/** One primary action card: title, one-line description, chevron link. */
function ActionCard({
  title,
  description,
  onPress,
  testID,
}: {
  title: string;
  description: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Card testID={testID}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button
          variant="ghost"
          size="sm"
          role="link"
          className="ml-auto"
          onPress={onPress}
          accessibilityLabel={`Open ${title}`}
        >
          <Text>Open</Text>
          <Chevron direction="right" />
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Compact settings card: preset chips + every EDITABLE field contract. */
function SettingsCard({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          preset pins roomId · sessionId · secret; fallback WiFi fields are used
          only when the hotspot announce cannot be reached
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-3">
        <View className="flex-row flex-wrap gap-2">
          {ROOM_PRESETS.map((p) => (
            <Button
              key={p.id}
              variant={settings.presetId === p.id ? "default" : "outline"}
              size="sm"
              onPress={() => onChange(applyPreset(settings, p.id))}
              testID={`home-preset-${p.id}`}
            >
              <Text>{p.name}</Text>
            </Button>
          ))}
        </View>
        <SettingsField
          label="Server URL"
          value={settings.serverUrl}
          onChange={(v) => onChange({ ...settings, serverUrl: v })}
          testID="settings-server-url"
        />
        <SettingsField
          label="Student ID (roll no)"
          value={settings.studentId}
          onChange={(v) => onChange({ ...settings, studentId: v })}
        />
        <SettingsField
          label="Student name"
          value={settings.studentName}
          onChange={(v) => onChange({ ...settings, studentName: v })}
        />
        <SettingsField
          label="Hotspot SSID (fallback)"
          value={settings.soshinSsid}
          onChange={(v) => onChange({ ...settings, soshinSsid: v })}
        />
        <SettingsField
          label="Hotspot pass (fallback)"
          value={settings.soshinPass ?? ""}
          onChange={(v) => onChange({ ...settings, soshinPass: v })}
          secure
        />
      </CardContent>
    </Card>
  );
}

function SettingsField({
  label,
  value,
  onChange,
  secure,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secure?: boolean;
  testID?: string;
}) {
  return (
    <View className="gap-1.5">
      <Label>{label}</Label>
      <Input
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        testID={testID}
      />
    </View>
  );
}

/** Keep the screen awake while a mode console is engaged. */
function ActiveKeepAwake() {
  useKeepAwake();
  return null;
}
