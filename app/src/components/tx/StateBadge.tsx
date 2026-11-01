import React from "react";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { MONO } from "../../theme";

/**
 * Semantic state badge. The shadcn palette is neutral, so ok/warn/bad states
 * lean on Tailwind's own color scale (green-ish ok, amber warn, red bad) with
 * translucent dark fills so they read on the dark background.
 */
const TONE_CLASSES = {
  ok: { badge: "border-emerald-900 bg-emerald-950/60", text: "text-emerald-400" },
  warn: { badge: "border-amber-900 bg-amber-950/60", text: "text-amber-400" },
  bad: { badge: "border-red-900 bg-red-950/60", text: "text-red-400" },
  muted: { badge: "border-transparent bg-secondary", text: "text-secondary-foreground" },
  neutral: { badge: "border-transparent bg-primary", text: "text-primary-foreground" },
  outline: { badge: "border-border bg-transparent", text: "text-foreground" },
} as const;

export type StateTone = keyof typeof TONE_CLASSES;

export function StateBadge({
  tone = "neutral",
  mono,
  className,
  children,
}: {
  tone?: StateTone;
  /** Use the bundled mono face (uptime / code / numeric readouts). */
  mono?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const t = TONE_CLASSES[tone];
  return (
    <Badge variant="outline" className={cn(t.badge, className)}>
      <Text
        className={cn("text-xs font-medium", t.text)}
        style={mono ? { fontFamily: MONO } : undefined}
        numberOfLines={1}
      >
        {children}
      </Text>
    </Badge>
  );
}

/** linkViewState (shared LinkState) → badge tone. */
export function stateTone(
  state: "connected" | "degraded" | "lost" | undefined,
  present?: boolean,
): StateTone {
  if (state === "connected") return "ok";
  if (state === "degraded") return "warn";
  if (state === "lost") return "bad";
  return present ? "ok" : "bad";
}
