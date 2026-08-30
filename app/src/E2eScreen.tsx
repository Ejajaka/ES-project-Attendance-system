import React, { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { NativeSensors } from "./lib/nativeSensors";
import { E2eController, type E2eRole } from "./lib/modes/e2e";
import type { Settings } from "./settings";
import { colors, spacing, text } from "./theme";
import {
  ConsoleHeader,
  Divider,
  Hazard,
  HudButton,
  Panel,
  StatusDot,
} from "./components/hud";

interface ServerE2eEvent {
  sessionId: string;
  deviceId: string;
  role: "soshin" | "jushin";
  phase: string;
  at: number;
  detail?: Record<string, unknown>;
}

const ROLE_TONE: Record<string, string> = {
  soshin: colors.purple,
  jushin: colors.green,
  both: colors.cyan,
};

export default function E2eScreen({
  settings,
  serverUrl,
  role,
  onExit,
}: {
  settings: Settings;
  serverUrl: string;
  role: E2eRole;
  onExit: () => void;
}) {
  const [phase, setPhase] = useState("starting");
  const [logLines, setLogLines] = useState<{ t: number; line: string }[]>([]);
  const [remoteEvents, setRemoteEvents] = useState<ServerE2eEvent[]>([]);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const logRef = useRef<ScrollView | null>(null);
  const cancelledRef = useRef(false);

  const log = (line: string) => {
    setLogLines((prev) => [...prev, { t: Date.now(), line }]);
    console.log(line);
  };

  // Pull the server-side E2E event log so one phone sees the other's phases.
  useEffect(() => {
    if (phase !== "running") return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${serverUrl}/api/e2e/${encodeURIComponent(settings.sessionId)}`);
        if (!res.ok) return;
        const body = (await res.json()) as { events?: ServerE2eEvent[] };
        const events = body.events;
        if (!cancelled && Array.isArray(events)) {
          setRemoteEvents((prev) => {
            const key = (e: ServerE2eEvent) => `${e.deviceId}:${e.phase}:${e.at}`;
            const seen = new Set(prev.map(key));
            const next = [...prev];
            for (const e of events) {
              const k = key(e);
              if (!seen.has(k)) {
                seen.add(k);
                next.push(e);
              }
            }
            return next.sort((a, b) => a.at - b.at);
          });
          setServerErr(null);
        }
      } catch (e) {
        setServerErr(e instanceof Error ? e.message : "poll failed");
      }
    };
    void poll();
    const t = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, serverUrl, settings.sessionId]);

  useEffect(() => {
    cancelledRef.current = false;
    const run = async () => {
      setPhase("requesting permissions");
      const sensors = new NativeSensors();
      const controller = new E2eController(
        sensors,
        {
          role,
          deviceId: "e2e-" + (role === "both" ? "tester" : role),
          roomId: settings.roomId,
          sessionId: settings.sessionId,
          secret: settings.secret,
          serverUrl,
        },
        log,
      );
      setPhase("running");
      try {
        await controller.run();
      } catch (e) {
        if (!cancelledRef.current) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`[e2e] fatal: ${msg}`);
        }
      }
      if (!cancelledRef.current) setPhase("done");
    };
    void run();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = phase === "done";

  return (
    <View style={styles.root}>
      <ConsoleHeader
        jp="試験"
        en="E2E-TESTING-MODE · 総合試験"
        stateLabel={`phase: ${phase}`}
        stateTone={done ? colors.green : phase === "running" ? colors.amber : colors.cyan}
        right={<Text style={[text.tiny, { letterSpacing: 2 }]}>role={role}</Text>}
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {/* Top summary — this carries the maestro `e2e-summary` testID */}
        <View style={styles.summaryBox}>
          <Text testID="e2e-summary" style={[text.glow, { fontSize: 18 }]}>
            phase: {phase}
          </Text>
          <Text style={[text.tiny, { color: colors.dim }]}>
            role={role} · session={settings.sessionId} · server={serverUrl}
          </Text>
        </View>

        <Panel title="LIVE LOG / 実行記録" tone={colors.purple} accentLabel="LOCAL">
          <ScrollView
            ref={logRef}
            style={styles.log}
            onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: true })}
          >
            {logLines.map((l, i) => (
              <Text key={i} style={styles.logLine}>
                <Text style={{ color: colors.faint }}>{new Date(l.t).toLocaleTimeString()} </Text>
                {l.line}
              </Text>
            ))}
          </ScrollView>
        </Panel>

        <Panel
          title="SERVER EVENT BUS / サーバ事件"
          tone={colors.cyan}
          accentLabel={`${remoteEvents.length} EVENT(S)`}
          right={<StatusDot tone={serverErr ? colors.red : colors.green} pulse={!serverErr} size={6} />}
        >
          {remoteEvents.length === 0 ? (
            <Text style={[text.tiny, { color: colors.faint }]}>
              {serverErr ? `Server unreachable: ${serverErr}` : "Waiting for server events…"}
            </Text>
          ) : (
            remoteEvents.map((e, i) => (
              <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <StatusDot tone={ROLE_TONE[e.role] ?? colors.dim} pulse={false} size={5} />
                <Text style={[text.tiny, { color: ROLE_TONE[e.role] ?? colors.dim, flex: 1 }]}>
                  {e.role.toUpperCase()} · {e.phase}
                </Text>
                <Text style={[text.tiny, { color: colors.faint }]} numberOfLines={1}>
                  {e.deviceId}
                </Text>
              </View>
            ))
          )}
        </Panel>

        {done && (
          <>
            <Hazard height={8} />
            <Divider label="RUN COMPLETE" />
          </>
        )}

        <HudButton variant="ghost" title="EXIT" onPress={onExit} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.md },
  summaryBox: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bgRaised,
    padding: spacing.md,
    gap: spacing.xs,
    borderRadius: 2,
  },
  log: {
    maxHeight: 280,
    backgroundColor: colors.field,
    borderRadius: 2,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  logLine: { fontFamily: "monospace", fontSize: 10, color: colors.dim, lineHeight: 15 },
});