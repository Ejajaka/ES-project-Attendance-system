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
import type { E2eRole } from "./lib/modes/e2e";
import type { Settings } from "./settings";
import { DEFAULT_SETTINGS } from "./settings";
import { DEVICE_ID } from "./identity";
import { VERSION } from "./version";
import { colors, MONO, radius, spacing, text } from "./theme";
import {
  Divider,
  Hazard,
  HudButton,
  Panel,
  StatusDot,
} from "./components/hud";
import SoshinScreen from "./SoshinScreen";
import JushinScreen from "./JushinScreen";
import SmokeScreen from "./SmokeScreen";
import E2eScreen from "./E2eScreen";

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
  const [mode, setMode] = useState<Mode>("none");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [uptime, setUptime] = useState(0);

  // Remote/hardware hook: `shusseki://smoke?run=all` or `shusseki://e2e?role=…`
  // boots straight into the automated suite; results stream to logcat.
  useEffect(() => {
    console.log(`[app] version ${VERSION}`);
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

  // Uptime ticker shown on the home console.
  useEffect(() => {
    if (mode !== "none") return;
    setUptime(0);
    const t = setInterval(() => setUptime((u) => u + 1), 1000);
    return () => clearInterval(t);
  }, [mode]);

  return (
    <View style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
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
        <ScrollView contentContainerStyle={styles.shell}>
          {mode !== "smoke" && (
            <SettingsPanel settings={settings} onChange={setSettings} />
          )}
          {mode === "soshin" && (
            <SoshinScreen settings={settings} serverUrl={settings.serverUrl} onExit={() => setMode("none")} />
          )}
          {mode === "jushin" && (
            <JushinScreen settings={settings} serverUrl={settings.serverUrl} onExit={() => setMode("none")} />
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
        </ScrollView>
      )}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Home — the command console. Target user is a researcher/developer,
 * so it is a dense technical readout, not a marketing screen.
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
      <Hazard height={10} />
      <View style={styles.masthead}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <StatusDot tone={colors.green} pulse />
          <Text style={[text.hudSub, { letterSpacing: 3 }]}>システム稼働 · SYSTEM ONLINE</Text>
          <View style={{ flex: 1 }} />
          <Text style={[text.tiny, { color: colors.dim, letterSpacing: 2 }]}>{VERSION}</Text>
        </View>
        <Text style={[text.hudJapanese, { marginTop: spacing.sm }]}>出 席</Text>
        <Text style={[text.hudTitle, { marginTop: 4 }]}>SHUSSEKI</Text>
        <Text style={[text.hudSub, { marginTop: spacing.sm }]}>
          ROOM-LEVEL CONTINUOUS ATTENDANCE · BLE+WIFI+ULTRASONIC FUSION
        </Text>
        <View style={{ marginTop: spacing.md, gap: 4 }}>
          <Text style={[text.tiny, { color: colors.dim }]}>DEVICE {DEVICE_ID}</Text>
          <Text style={[text.tiny, { color: colors.dim }]}>SERVER {settings.serverUrl}</Text>
          <Text style={[text.tiny, { color: colors.dim }]}>
            SESSION {settings.sessionId} · ROOM {settings.roomId} · UPTIME {mm}:{ss}
          </Text>
        </View>
      </View>
      <Hazard height={10} a={colors.purple} />

      <Panel title="OPERATIONS / 作戦選択" tone={colors.purple} accentLabel="SELECT MISSION">
        <View style={styles.grid}>
          <ModeTile
            jp="送信"
            en="SOSHIN (ROOM)"
            sub="hotspot + beacon + chirp"
            tone={colors.purple}
            onPress={() => onPick("soshin")}
          />
          <ModeTile
            jp="受信"
            en="JUSHIN (PHONE)"
            sub="sense + report + verdict"
            tone={colors.green}
            onPress={() => onPick("jushin")}
          />
          <ModeTile
            jp="診断"
            en="SMOKE"
            sub="per-modality self-test"
            tone={colors.amber}
            onPress={() => onPick("smoke")}
          />
          <ModeTile
            jp="試験"
            en="E2E FULL TEST"
            sub="auto both-role trial"
            tone={colors.red}
            onPress={() =>
              onPick("e2e", { screen: "e2e", role: "both" })
            }
          />
        </View>
      </Panel>

      <SettingsPanel settings={settings} onChange={onSettingsChange} />

      <Divider label="TROUBLESHOOT" />
      <Text style={[text.tiny, { color: colors.faint, lineHeight: 16 }]}>
        adb reverse tcp:8787 tcp:8787{'\n'}
        server: cd server && npm run dev{'\n'}
        smoke deep-link: shusseki://smoke?run=all{'\n'}
        e2e deep-link: shusseki://e2e?role=both
      </Text>
    </ScrollView>
  );
}

function ModeTile({
  jp,
  en,
  sub,
  tone,
  onPress,
  style,
}: {
  jp: string;
  en: string;
  sub: string;
  tone: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <HudButton variant="ghost" onPress={onPress} style={[styles.tile, style]}>
      <Text style={[text.hudJapanese, { fontSize: 24, color: tone }]}>{jp}</Text>
      <Text style={[text.section, { color: colors.text, marginTop: 4 }]}>{en}</Text>
      <Text style={[text.tiny, { color: colors.dim, marginTop: 2 }]}>{sub}</Text>
      <Text style={[text.value, { color: tone, marginTop: 6, letterSpacing: 2 }]}>▶ ENGAGE</Text>
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
  return (
    <Panel
      title="CONFIG / 設定"
      tone={colors.amber}
      accentLabel="SESSION PARAMETERS"
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
          <Field label="ROOM ID" value={settings.roomId} onChange={(v) => onChange({ ...settings, roomId: v })} />
          <Field label="SESSION ID" value={settings.sessionId} onChange={(v) => onChange({ ...settings, sessionId: v })} />
          <Field label="SOSHIN SSID" value={settings.soshinSsid} onChange={(v) => onChange({ ...settings, soshinSsid: v })} />
          <Field label="HOTSPOT PASS" value={settings.soshinPass ?? ""} onChange={(v) => onChange({ ...settings, soshinPass: v })} secure />
          <Field label="SHARED SECRET" value={settings.secret} onChange={(v) => onChange({ ...settings, secret: v })} secure />
          <Text style={[text.tiny, { color: colors.faint, lineHeight: 14 }]}>
            The Soshin secret must match the one used when creating the server
            session ({settings.serverUrl}/api/sessions). The server re-verifies
            the rolling code against it.
          </Text>
        </>
      )}
      {!open && (
        <Text style={[text.tiny, { color: colors.faint }]}>
          room={settings.roomId} · session={settings.sessionId} · ssid={settings.soshinSsid}
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
  shell: { padding: spacing.md, gap: spacing.md },
  home: { paddingBottom: spacing.xxl, backgroundColor: colors.bg },
  masthead: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.bgRaised,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.line,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  tile: {
    flex: 1,
    minWidth: "46%",
    alignItems: "flex-start",
    flexDirection: "column",
    padding: spacing.md,
    backgroundColor: colors.bgRaised,
    borderColor: colors.lineStrong,
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