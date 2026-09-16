import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { NativeSensors } from "./lib/nativeSensors";
import { E2eController, type E2eRole } from "./lib/modes/e2e";
import { roleLabel } from "./lib/roles";
import type { Settings } from "./settings";
import { colors, spacing, text } from "./theme";
import {
  AlertOverlay,
  BloomField,
  ConsoleHeader,
  Divider,
  HudButton,
  Interjection,
  Lamp,
  Panel,
} from "./components/hud";

/** One full-screen console alert. */
interface ConsoleAlert {
  title: string;
  jp?: string;
  sub?: string;
  detail?: string;
  tone: string;
}

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
  const [alert, setAlert] = useState<ConsoleAlert | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
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
        if (!cancelledRef.current) {
          setAlert({
            title: "TRIAL COMPLETE",
            jp: "試験完了",
            sub: "ALL ROLES SELF-REPORTED · SESSION CLOSED",
            detail: `session=${settings.sessionId} · server=${serverUrl}`,
            tone: colors.green,
          });
        }
      } catch (e) {
        if (!cancelledRef.current) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`[e2e] fatal: ${msg}`);
          setAlert({
            title: "TRIAL FAULT",
            jp: "試験異常",
            sub: "AUTOMATED SEQUENCE ABORTED",
            detail: msg,
            tone: colors.red,
          });
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
      <BloomField a={colors.amber} b={colors.red} />
      <ConsoleHeader
        jp="試験"
        en="E2E-TESTING-MODE · 総合試験"
        stateLabel={`PHASE ${phase.toUpperCase()}`}
        stateTone={done ? colors.green : phase === "running" ? colors.amber : colors.cyan}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Text style={[text.tiny, { letterSpacing: 2 }]}>role={role}</Text>
            <HudButton variant="ghost" small title="EXIT" onPress={onExit} />
          </View>
        }
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {/* Phase plate — carries the maestro `e2e-summary` contract (phase: done) */}
        <Interjection
          text={phase === "done" ? "TRIAL COMPLETE" : phase === "running" ? "TRIAL RUNNING" : "TRIAL STARTING"}
          sub={phase === "done" ? "BOTH ROLES REPORTED · SESSION CLOSED" : `AUTOMATED SEQUENCE · ${settings.sessionId}`}
          tone={done ? colors.green : phase === "running" ? colors.amber : colors.cyan}
          plate={done}
        />
        {/* Maestro waits on the literal "phase: done" text — keep it in flow,
         * rendered in background color (invisible on the black field) but
         * within bounds so uiautomator treats it as visible. */}
        <Text testID="e2e-summary" style={styles.hiddenSummary}>
          phase: {phase}
        </Text>

        <View style={styles.cols}>
          <Panel title="LIVE LOG / 実行記録" tone={colors.purple} accentLabel="LOCAL" style={{ flex: 1, minWidth: 300 }}>
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
            right={<Lamp tone={serverErr ? colors.red : colors.green} size={6} />}
            style={{ flex: 1, minWidth: 300 }}
          >
            {remoteEvents.length === 0 ? (
              <Text style={[text.tiny, { color: colors.faint }]}>
                {serverErr ? `Server unreachable: ${serverErr}` : "Waiting for server events…"}
              </Text>
            ) : (
              <ScrollView style={styles.eventBus} nestedScrollEnabled>
                {remoteEvents.map((e, i) => {
                const key = `${e.deviceId}:${i}:${e.at}`;
                const open = expandedKey === key;
                const roleTone = ROLE_TONE[e.role] ?? colors.dim;
                return (
                  <Pressable
                    key={key}
                    onPress={() => setExpandedKey(open ? null : key)}
                    style={({ pressed }) => ({
                      borderWidth: 1,
                      borderColor: open ? roleTone : colors.line,
                      backgroundColor: open ? "rgba(255,255,255,0.03)" : colors.field,
                      padding: spacing.xs,
                      gap: 4,
                      opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <Lamp tone={roleTone} size={5} />
                      <Text style={[text.tiny, { color: roleTone, flex: 1, fontSize: 11 }]}>
                        {roleLabel(e.role)} · {e.phase}
                        {open ? "  ▼" : "  ▶"}
                      </Text>
                      <Text style={[text.tiny, { color: colors.faint }]} numberOfLines={1}>
                        {e.deviceId}
                      </Text>
                    </View>
                    {open && (
                      <View style={{ gap: 2, paddingLeft: spacing.sm, borderLeftWidth: 2, borderLeftColor: roleTone }}>
                        <Text style={[text.tiny, { color: colors.faint }]}>
                          at {new Date(e.at).toLocaleTimeString()} · {e.at}
                        </Text>
                        <Text selectable style={[text.tiny, { color: colors.dim, lineHeight: 14 }]}>
                          {JSON.stringify(e.detail ?? {}, null, 2)}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
              </ScrollView>
            )}
          </Panel>
        </View>

        {done && (
          <>
            <View style={{ height: 4, backgroundColor: colors.green }} />
            <View style={{ paddingVertical: spacing.sm }}>
              <Divider label="RUN COMPLETE" />
            </View>
          </>
        )}

        <View style={styles.controls}>
          <HudButton variant="ghost" title="EXIT" onPress={onExit} />
        </View>
      </ScrollView>

      {/* Full-screen NERV alert layer — trial completion/faults */}
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 0, gap: 0 },
  cols: { flexDirection: "row", flexWrap: "wrap", gap: 0 },
  controls: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
  },
  /** In-flow, colored like the field so it's invisible on black but still
   * "visible" to uiautomator (maestro waits on this exact text). */
  hiddenSummary: {
    color: colors.bg,
    fontFamily: "monospace",
    fontSize: 8,
  },
  log: {
    maxHeight: 190,
    backgroundColor: colors.field,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  eventBus: {
    maxHeight: 190,
    backgroundColor: colors.field,
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.line,
  },
  logLine: { fontFamily: "monospace", fontSize: 10, color: colors.dim, lineHeight: 15 },
});