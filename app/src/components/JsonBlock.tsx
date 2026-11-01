import React from "react";
import { ScrollView, View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { MONO } from "../theme";

/**
 * Raw JSON in the bundled mono face — the honest payload block.
 *
 * Default: one compact line in a horizontal ``ScrollView`` (exactness first —
 * nothing is reflowed or re-ordered). `pretty` renders indented JSON that
 * wraps instead, for payloads worth reading structurally.
 */
export function JsonBlock({
  data,
  label,
  pretty = false,
  className,
}: {
  data: unknown;
  label?: string;
  pretty?: boolean;
  className?: string;
}) {
  const text = React.useMemo(() => {
    if (data === null || data === undefined) return "(no data)";
    try {
      return JSON.stringify(data, null, pretty ? 2 : undefined) ?? "(no data)";
    } catch {
      return "(unserializable payload)";
    }
  }, [data, pretty]);

  return (
    <View className={cn("gap-1", className)}>
      {label && <Text className="text-xs text-muted-foreground">{label}</Text>}
      {pretty ? (
        <Text className="text-xs text-foreground" style={{ fontFamily: MONO, padding: 8 }}>
          {text}
        </Text>
      ) : (
        <ScrollView horizontal contentContainerStyle={{ padding: 0 }}>
          <Text
            className="rounded-md bg-muted p-2 text-xs text-foreground"
            style={{ fontFamily: MONO }}
          >
            {text}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}
