import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { NativeSensors } from "./lib/nativeSensors";
import { E2eController, type E2eRole } from "./lib/modes/e2e";
import { roleLabel } from "./lib/roles";
import { DEVICE_ID } from "./identity";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Text } from "@/components/ui/text";

/** One inline console alert (replaces the old full-screen overlay). */
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

type StreamMode = "all" | E2eRole;

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
  const [stream, setStream] = useState<StreamMode>("all");
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
          // Unique per phone so two receivers don't collapse into one roster entry.
          deviceId: `${DEVICE_ID}-${role}`,
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

  /** One expandable server event row. */
  const EventRow = ({ e, i }: { e: ServerE2eEvent; i: number }) => {
    const key = `${e.deviceId}:${i}:${e.at}`;
    const open = expandedKey === key;
    return (
      <Pressable
        key={key}
        onPress={() => setExpandedKey(open ? null : key)}
        className={
          open
            ? "gap-1 rounded-md border border-ring bg-accent/40 p-2 active:opacity-60"
            : "gap-1 rounded-md border border-border bg-transparent p-2 active:opacity-60"
        }
      >
        <View className="flex-row items-center gap-2">
          <StateBadge tone={e.role === "soshin" ? "outline" : "muted"}>
            {roleLabel(e.role)}
          </StateBadge>
          <Text
            className="flex-1 text-xs text-foreground"
            numberOfLines={1}
          >
            {e.phase} {open ? "▼" : "▶"}
          </Text>
          <Text className="text-[10px] text-muted-foreground" style={{ fontFamily: MONO }} numberOfLines={1}>
            {e.deviceId}
          </Text>
        </View>
        {open && (
          <View className="gap-1 border-l-2 border-l-ring pl-3">
            <Text
              className="text-xs text-muted-foreground"
              style={{ fontFamily: MONO }}
            >
              at {new Date(e.at).toLocaleTimeString()} · {e.at}
            </Text>
            <Text
              selectable
              className="text-xs text-foreground"
              style={{ fontFamily: MONO }}
            >
              {JSON.stringify(e.detail ?? {}, null, 2)}
            </Text>
          </View>
        )}
      </Pressable>
    );
  };

  const filteredEvents = remoteEvents.filter(
    (e) => stream === "all" || e.role === stream,
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="E2E trial · 試験 総合試験"
        onExit={onExit}
        right={
          <View className="flex-row items-center gap-2">
            <StateBadge tone={role === "soshin" ? "outline" : role === "jushin" ? "muted" : "neutral"}>
              role={role}
            </StateBadge>
            <StateBadge mono tone={done ? "ok" : phase === "running" ? "warn" : "outline"}>
              {phase.toUpperCase()}
            </StateBadge>
          </View>
        }
      />
      <ScrollView className="flex-1" contentContainerClassName="p-4 gap-4">
        {/* Trial status card */}
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 pb-0">
            <View className="shrink">
              <CardTitle>
                {phase === "done" ? "Trial complete" : phase === "running" ? "Trial running" : "Trial starting"}
              </CardTitle>
              <CardDescription numberOfLines={2}>
                {phase === "done"
                  ? "BOTH ROLES REPORTED · SESSION CLOSED"
                  : `AUTOMATED SEQUENCE · ${settings.sessionId}`}
              </CardDescription>
            </View>
            <StateBadge tone={done ? "ok" : "warn"} mono>
              {phase.toUpperCase()}
            </StateBadge>
          </CardHeader>
          {/* Maestro waits on the literal "phase: done" text — keep it in flow,
           * rendered in background color (invisible on the field) but
           * within bounds so uiautomator treats it as visible. */}
          <Text
            testID="e2e-summary"
            className="text-[8px] text-background"
            style={{ fontFamily: MONO }}
          >
            phase: {phase}
          </Text>
        </Card>

        {/* Streams: side by side on wide screens, stacked vertically on phones */}
        <View className="gap-4 md:flex-row">
          <Card className="md:w-1/2">
            <CardHeader>
              <View className="flex-row items-center justify-between gap-2">
                <CardTitle>Live log</CardTitle>
                <StateBadge mono tone="outline">
                  LOCAL · {logLines.length}
                </StateBadge>
              </View>
              <CardDescription>console-mirrored run record</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollView
                ref={logRef}
                className="h-44 rounded-md border border-border bg-transparent p-2"
                onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: true })}
              >
                {logLines.map((l, i) => (
                  <Text
                    key={i}
                    className="text-xs leading-5 text-muted-foreground"
                    style={{ fontFamily: MONO }}
                  >
                    <Text className="text-muted-foreground/60">
                      {new Date(l.t).toLocaleTimeString()}{" "}
                    </Text>
                    {l.line}
                  </Text>
                ))}
                {logLines.length === 0 && (
                  <Text className="text-xs text-muted-foreground">no lines yet…</Text>
                )}
              </ScrollView>
            </CardContent>
          </Card>

          <Card className="md:w-1/2">
            <CardHeader>
              <View className="flex-row items-center justify-between gap-2">
                <CardTitle>Event bus</CardTitle>
                <StateBadge
                  mono
                  tone={serverErr ? "bad" : "ok"}
                >
                  {remoteEvents.length} EVENT(S)
                </StateBadge>
              </View>
              <CardDescription>
                {serverErr ? `server unreachable: ${serverErr}` : "GET /api/e2e/:id · 2.5s poll"}
              </CardDescription>
            </CardHeader>
            <CardContent className="gap-2">
              {/* Role streams: pick soshin / jushin / all via an outline Tabs */}
              <Tabs
                value={stream}
                onValueChange={(v) => setStream(v as StreamMode)}
              >
                <TabsList className="h-9 w-full flex-row items-center justify-center rounded-lg border border-border bg-transparent">
                  <TabsTrigger value="all" className="flex-1 border-transparent">
                    <Text className="text-xs">All</Text>
                  </TabsTrigger>
                  <TabsTrigger value="soshin" className="flex-1 border-transparent">
                    <Text className="text-xs">Soshin</Text>
                  </TabsTrigger>
                  <TabsTrigger value="jushin" className="flex-1 border-transparent">
                    <Text className="text-xs">Jushin</Text>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <ScrollView className="h-44 rounded-md border border-border bg-transparent p-1.5" nestedScrollEnabled>
                {serverErr && remoteEvents.length === 0 ? (
                  <Text className="p-1 text-xs text-muted-foreground">
                    {`Server unreachable: ${serverErr}`}
                  </Text>
                ) : filteredEvents.length === 0 ? (
                  <Text className="p-1 text-xs text-muted-foreground">
                    Waiting for server events…
                  </Text>
                ) : (
                  filteredEvents.map((e, i) => <EventRow e={e} i={i} />)
                )}
              </ScrollView>
            </CardContent>
          </Card>
        </View>

        {alert && (
          <Card
            className={
              alert.tone === colors.red
                ? "border-red-900/60"
                : alert.tone === colors.green
                  ? "border-emerald-900/60"
                  : "border-ring"
            }
          >
            <CardContent>
              <Pressable onPress={() => setAlert(null)}>
                <View className="gap-1">
                  <View className="flex-row items-center justify-between gap-2">
                    <Text className="text-sm font-semibold text-foreground">{alert.title}</Text>
                    <StateBadge
                      tone={
                        alert.tone === colors.red
                          ? "bad"
                          : alert.tone === colors.green
                            ? "ok"
                            : "outline"
                      }
                    >
                      TAP TO DISMISS
                    </StateBadge>
                  </View>
                  {alert.sub && (
                    <Text className="text-xs text-muted-foreground" style={{ fontFamily: MONO }}>
                      {alert.sub}
                    </Text>
                  )}
                  {alert.detail && (
                    <Text className="text-xs text-foreground" style={{ fontFamily: MONO }}>
                      {alert.detail}
                    </Text>
                  )}
                </View>
              </Pressable>
            </CardContent>
          </Card>
        )}

        <ValueRow
          label="session"
          value={settings.sessionId}
          tone="muted"
        />
        <ValueRow label="server" value={serverUrl} tone="muted" />

        <View className="flex-row items-center gap-2">
          <Button className="flex-1" variant="outline" onPress={onExit}>
            <Text>EXIT</Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
