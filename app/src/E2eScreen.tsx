import React, { useEffect, useRef, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, View } from "react-native";
import { NativeSensors } from "./lib/nativeSensors";
import { E2eController, type E2eRole } from "./lib/modes/e2e";
import type { Settings } from "./settings";

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
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<ScrollView | null>(null);

  const log = (line: string) => {
    setLogLines((prev) => [...prev, line]);
    console.log(line);
  };

  useEffect(() => {
    let cancelled = false;
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
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`[e2e] fatal: ${msg}`);
        }
      }
      if (!cancelled) setPhase("done");
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.card}>
      <Text style={styles.modeTitle}>E2E-TESTING-MODE</Text>
      <Text style={styles.body}>role: {role} · session: {settings.sessionId}</Text>
      <Text testID="e2e-summary" style={styles.summary}>
        phase: {phase}
      </Text>
      <ScrollView
        ref={logRef}
        style={styles.log}
        onContentSizeChange={() => logRef.current?.scrollToEnd()}
      >
        {logLines.map((l, i) => (
          <Text key={i} style={styles.logLine}>
            {l}
          </Text>
        ))}
      </ScrollView>
      <Button title="Exit" onPress={onExit} />
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
  log: {
    maxHeight: 320,
    backgroundColor: "#f5f5f5",
    borderRadius: 8,
    padding: 8,
  },
  logLine: { fontFamily: "monospace", fontSize: 11 },
});