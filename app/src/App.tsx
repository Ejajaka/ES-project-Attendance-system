import React, { useEffect, useState } from "react";
import {
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
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
  type RoomPreset,
} from "./lib/presets";
import { DEVICE_ID } from "./identity";
import { VERSION } from "./version";
import { colors, DEPARTURE, MONO, radius, spacing, text } from "./theme";
import {
  BloomField,
  Divider,
  Hazard,
  HudButton,
  Lamp,
  Panel,
  WireGrid,
} from "./components/hud";
import SoshinScreen from "./SoshinScreen";
import JushinScreen from "./JushinScreen";
import SmokeScreen from "./SmokeScreen";
import E2eScreen from "./E2eScreen";

type Mode = "none" | "soshin" | "jushin" | "smoke" | "e2e";

/** Deep-linking target parsed from `shusseki://<path>?<query>`. */
type Launch =
  | { screen: "smoke"; autoRun?: string }
  | { screen: "e2e"; role: E2eRole }
  | { screen: "jushin"; autoEngage: true; studentId?: string; studentName?: string }
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
  // Headless console auto-engage (adb/maestro driven): shusseki://rx | shusseki://tx.
  // `rx` also accepts identity: shusseki://rx?roll=bl.1&name=Ada%20Lovelace
  if (path === "rx") {
    return {
      screen: "jushin",
      autoEngage: true,
      studentId: params["roll"] || params["studentId"] || undefined,
      studentName: params["name"] || undefined,
    };
  }
  if (path === "tx") return { screen: "soshin", autoEngage: true };
  return null;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("none");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [uptime, setUptime] = useState(0);
  // Bundled pixel-mono face (Departure Mono, OFL) — the console's one voice.
  const [fontsLoaded] = useFonts({
    DepartureMono: require("../assets/fonts/DepartureMono-Regular.otf"),
  });

  // Remote/hardware hook: `shusseki://smoke?run=all` or `shusseki://e2e?role=…`
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

  // Uptime ticker shown on the home console.
  useEffect(() => {
    if (mode !== "none") return;
    setUptime(0);
    const t = setInterval(() => setUptime((u) => u + 1), 1000);
    return () => clearInterval(t);
  }, [mode]);

  if (!fontsLoaded) {
    // Hold on black until the display face is ready (sub-second on device).
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
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
          <View style={styles.shell}>
            {mode !== "smoke" && <SettingsPanel settings={settings} onChange={setSettings} />}
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
                onExit={() => setMode("none")}
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
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/* ------------------------------------------------------------------ *
 * Home — landscape command console. Big type, big switches, black field.
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
  const mm = Math.floor(uptime / 60).toString().padStart(2, "0");
  const ss = (uptime % 60).toString().padStart(2, "0");
  return (
    <ScrollView style={styles.safe} contentContainerStyle={styles.home}>
      <BloomField a={colors.cyan} b={colors.purple} />
      <Hazard height={10} />
      <View style={styles.masthead}>
        <WireGrid />
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Text style={[text.hudJapanese, { fontSize: 48 }]}>出 席</Text>
          <View style={{ gap: 2, flex: 1 }}>
            <Text style={[text.hudTitle, { fontSize: 26 }]}>SHUSSEKI</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Lamp tone={colors.green} size={7} />
              <Text style={[text.hudSub, { color: colors.green }]}>
                システム稼働 · SYSTEM ONLINE
              </Text>
            </View>
          </View>
          <Text style={[text.tiny, { color: colors.dim }]}>{VERSION}</Text>
        </View>
        <Text style={[text.tiny, { color: colors.dim }]}>
          DEVICE {DEVICE_ID} · SERVER {settings.serverUrl} · SESS {settings.sessionId} · UPTIME {mm}:{ss}
        </Text>
      </View>
      <Hazard height={10} a={colors.purple} />

      <Panel
        title="ROOM PRESET / 部屋選択"
        tone={colors.cyan}
        accentLabel="PICK THE SAME ROOM ON EVERY DEVICE"
        grid
      >
        <View style={styles.presetRow}>
          {ROOM_PRESETS.map((p) => (
            <PresetTile
              key={p.id}
              preset={p}
              selected={settings.presetId === p.id}
              onPress={() => onSettingsChange(applyPreset(settings, p.id))}
            />
          ))}
        </View>
        <Text style={[text.tiny, { color: colors.faint, lineHeight: 14 }]}>
          Host picks a room, every phone picks the same one: roomId, sessionId,
          rolling-code secret and hotspot announce are matched automatically.
        </Text>
      </Panel>

      <View style={styles.missionRow}>
        <MissionTile
          jp="送信"
          en="TRANSMITTER"
          brand="SOSHIN"
          sub="ROOM HOST · ULTRASONIC SOURCE · 部屋側"
          tone={colors.purple}
          onPress={() => onPick("soshin")}
        />
        <MissionTile
          jp="受信"
          en="RECEIVER"
          brand="JUSHIN"
          sub="USER PHONE · LISTENS TO ROOM · 端末側"
          tone={colors.green}
          onPress={() => onPick("jushin")}
        />
        <MissionTile
          jp="診断"
          en="SMOKE"
          sub="DIAGNOSTICS · 自己診断"
          tone={colors.amber}
          onPress={() => onPick("smoke")}
        />
        <MissionTile
          jp="試験"
          en="E2E TEST"
          sub="FULL TRIAL · 総合試験"
          tone={colors.red}
          onPress={() => onPick("e2e", { screen: "e2e", role: "both" })}
        />
      </View>

      <SettingsPanel settings={settings} onChange={onSettingsChange} />

      <Divider label="TROUBLESHOOT" />
      <Text style={[text.tiny, { color: colors.faint, lineHeight: 15 }]}>
        adb reverse tcp:8787 tcp:8787 · server: cd server && npm run dev · shusseki://smoke?run=all · shusseki://e2e?role=both
      </Text>
    </ScrollView>
  );
}

/** Keep the screen awake while a mode console is engaged. */
function ActiveKeepAwake() {
  useKeepAwake();
  return null;
}

/** One of the three preset rooms. */
function PresetTile({
  preset,
  selected,
  onPress,
}: {
  preset: RoomPreset;
  selected: boolean;
  onPress: () => void;
}) {
  const tone = selected ? colors.green : colors.faint;
  return (
    <HudButton
      variant="ghost"
      onPress={onPress}
      style={[styles.presetTile, { borderColor: selected ? colors.green : colors.lineStrong }]}
    >
      <Text style={{ fontFamily: DEPARTURE, fontSize: 20, letterSpacing: 1, color: tone }}>
        {preset.name}
      </Text>
      <Text style={[text.hudSub, { color: colors.faint }]}>{preset.jp}</Text>
      <Text style={[text.tiny, { color: colors.dim, marginTop: 4 }]}>
        {preset.roomId} · {preset.sessionId}
      </Text>
      <Text style={[text.value, { color: tone, marginTop: 6, letterSpacing: 2 }]}>
        {selected ? "● BOUND" : "○ SELECT"}
      </Text>
    </HudButton>
  );
}

function MissionTile({
  jp,
  en,
  brand,
  sub,
  tone,
  onPress,
  style,
}: {
  jp: string;
  en: string;
  brand?: string;
  sub: string;
  tone: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <HudButton variant="ghost" onPress={onPress} style={[styles.tile, style]}>
      <Text
        style={{
          fontFamily: DEPARTURE,
          fontSize: 22,
          letterSpacing: 1,
          color: tone,
          textShadowColor: tone,
          textShadowRadius: 10,
        }}
      >
        {en}
      </Text>
      <Text style={[text.hudSub, { color: colors.dim, marginTop: 4 }]}>
        {jp}
        {brand ? ` · ${brand}` : ""}
      </Text>
      <Text style={[text.tiny, { color: colors.dim, marginTop: 3 }]}>{sub}</Text>
      <Text style={[text.value, { color: tone, fontSize: 13, marginTop: 8, letterSpacing: 3 }]}>
        ▶ ENGAGE
      </Text>
    </HudButton>
  );
}

/* Settings form — HUD-styled, shown only while a mode screen runs. */
function SettingsPanel({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const [open, setOpen] = useState(false);
  const preset = presetById(settings.presetId);
  return (
    <Panel
      title="CONFIG / 設定"
      tone={colors.amber}
      accentLabel={`${preset.name} BOUND`}
      right={
        <HudButton
          variant="ghost"
          small
          title={open ? "COLLAPSE ▲" : "EXPAND ▼"}
          onPress={() => setOpen((o) => !o)}
        />
      }
    >
      {open && (
        <>
          <Field label="SERVER URL" value={settings.serverUrl} onChange={(v) => onChange({ ...settings, serverUrl: v })} />
          <Field
            label="STUDENT ID (ROLL NO)"
            value={settings.studentId}
            onChange={(v) => onChange({ ...settings, studentId: v })}
          />
          <Field
            label="STUDENT NAME"
            value={settings.studentName}
            onChange={(v) => onChange({ ...settings, studentName: v })}
          />
          <Field
            label="HOTSPOT SSID (FALLBACK)"
            value={settings.soshinSsid}
            onChange={(v) => onChange({ ...settings, soshinSsid: v })}
          />
          <Field
            label="HOTSPOT PASS (FALLBACK)"
            value={settings.soshinPass ?? ""}
            onChange={(v) => onChange({ ...settings, soshinPass: v })}
            secure
          />
          <Text style={[text.tiny, { color: colors.faint, lineHeight: 14 }]}>
            Transmitter announces its live AutoHotspot (AndroidShare_XXXX) to the
            server; receivers auto-join it. Fallback fields are only used when
            the announce cannot be reached. Room/session/secret come from the
            {" "}{preset.name} preset — the server re-verifies the rolling code.
          </Text>
        </>
      )}
      {!open && (
        <Text style={[text.tiny, { color: colors.faint }]}>
          preset={preset.name} · room={settings.roomId} · session={settings.sessionId} · server={settings.serverUrl}
        </Text>
      )}
    </Panel>
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
    <View style={{ gap: 4 }}>
      <Text style={[text.label, { letterSpacing: 2 }]}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        autoCapitalize="none"
        placeholderTextColor={colors.faint}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  shell: { flex: 1, backgroundColor: colors.bg },
  home: { paddingBottom: spacing.xxl, backgroundColor: colors.bg },
  masthead: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.line,
    gap: spacing.xs,
    overflow: "hidden",
  },
  missionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  presetTile: {
    flexGrow: 1,
    flexBasis: "30%",
    minWidth: 150,
    alignItems: "flex-start",
    flexDirection: "column",
    padding: spacing.sm,
  },
  tile: {
    flexGrow: 1,
    flexBasis: "40%",
    minHeight: 108,
    alignItems: "flex-start",
    justifyContent: "center",
    flexDirection: "column",
    padding: spacing.md,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    color: colors.text,
    fontFamily: MONO,
    fontSize: 13,
    backgroundColor: colors.field,
  },
});