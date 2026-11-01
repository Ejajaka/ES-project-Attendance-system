import React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { MONO } from "../theme";

/**
 * One key → value console row: muted label left, bundled-mono value right.
 * Values that need semantics (ok/degraded/error) are `Badge`s the caller
 * passes in as `value` next to the plain numeric readout.
 */
export function DataRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string | number | null | undefined | React.ReactNode;
  className?: string;
}) {
  return (
    <View className={cn("flex-row items-baseline justify-between gap-3", className)}>
      <Text className="shrink text-sm text-muted-foreground" numberOfLines={1}>
        {label}
      </Text>
      <Text
        className="flex-1 text-right text-sm"
        style={{ fontFamily: MONO }}
        numberOfLines={2}
      >
        {value == null || value === "" ? "—" : value}
      </Text>
    </View>
  );
}
