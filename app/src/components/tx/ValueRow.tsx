import React from "react";
import { Text } from "@/components/ui/text";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { MONO } from "../../theme";

/**
 * One label/readout pair. The value renders in the bundled mono face and is
 * ellipsized when it would overflow (arbitrary-length readouts must wrap or
 * truncate — never push the row out of bounds).
 */
export function ValueRow({
  label,
  value,
  tone = "default",
  className,
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn" | "bad" | "muted";
  className?: string;
}) {
  const toneCls =
    tone === "ok"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "bad"
          ? "text-red-400"
          : tone === "muted"
            ? "text-muted-foreground"
            : "text-foreground";
  return (
    <View
      className={cn("flex-row items-baseline justify-between gap-3", className)}
    >
      <Text className="shrink text-xs text-muted-foreground" numberOfLines={1}>
        {label}
      </Text>
      <Text
        className={cn("text-right text-xs", toneCls)}
        style={{ fontFamily: MONO }}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}
