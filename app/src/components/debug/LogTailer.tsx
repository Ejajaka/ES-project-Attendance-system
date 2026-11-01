import React, { useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { cn } from "@/lib/utils";
import { MONO } from "../../theme";
import { logEntries, subscribeLog, type LogEntry } from "./log";

/**
 * The bottom tail of the debug log: the newest `lines` composed events, one
 * per line, in the bundled mono face. Subscribes to the shared ring buffer so
 * anything that calls `logEvent` (this or another console) shows up live.
 */
export function LogTailer({ lines = 14, className }: { lines?: number; className?: string }) {
  const [entries, setEntries] = useState<LogEntry[]>(() => logEntries());

  useEffect(() => subscribeLog(() => setEntries(logEntries())), []);

  const tail = entries.slice(-lines);

  return (
    <ScrollView className={cn("max-h-40 rounded-lg border-border border", className)}>
      <Text
        className="p-2 text-xs text-muted-foreground"
        style={{ fontFamily: MONO, padding: 8 }}
        testID="debug-log-tail"
      >
        {tail.length === 0
          ? "(no events yet — press an action button)"
          : tail.map((entry) => `${new Date(entry.t).toLocaleTimeString()} ${entry.text}`).join("\n")}
      </Text>
    </ScrollView>
  );
}
