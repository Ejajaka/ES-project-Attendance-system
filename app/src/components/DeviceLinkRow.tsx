import React from "react";
import { Pressable, View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import type { ServerPresence } from "@/lib/server";
import { roleLabel } from "@/lib/roles";
import { formatAge, linkChips, linkStateLabel } from "@/lib/linkView";
import { cn } from "@/lib/utils";
import { MONO } from "../theme";
import type { LinkState } from "shared";

/** Badge variant per link state: ok = accent, degraded = muted, lost = error. */
function stateVariant(state: LinkState | null | undefined, present: boolean) {
  if (state === "connected") return "default" as const;
  if (state === "degraded") return "secondary" as const;
  if (state === "lost" || !present) return "destructive" as const;
  return "secondary" as const;
}

/**
 * One device row in a room monitor. Two lines on purpose: the identity row
 * (short id · role + seen-ago badge) stays compact, and the three-channel
 * link stats get the full mono line so they never truncate. Drop-in restyle
 * shared by the receiver's room monitor and the transmitter's monitor.
 */
export function DeviceLinkRow({
  device,
  now,
  onPress,
}: {
  device: ServerPresence;
  now: number;
  onPress: () => void;
}) {
  const linkState = device.link?.state;
  const short =
    device.deviceId.length > 14
      ? `…${device.deviceId.slice(-12)}`
      : device.deviceId;
  const quality = Math.round((device.link?.quality ?? device.fused) * 100);

  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "border-border rounded-lg border px-1 py-1.5 active:opacity-60",
      )}
    >
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 font-medium text-sm text-foreground" numberOfLines={1}>
          {short} · {roleLabel(device.mode)}
        </Text>
        <Badge variant={device.present ? "default" : "destructive"}>
          <Text>{`${formatAge(device.timestamp, now)} ago`}</Text>
        </Badge>
      </View>
      <View className="mt-0.5 flex-row items-center gap-2">
        <Text
          className="flex-1 text-xs text-muted-foreground"
          style={{ fontFamily: MONO }}
          numberOfLines={1}
        >
          {linkChips(device.link)} · {quality}%
          {device.ultrasonicServerValid ? " · CODE ✓" : ""}
        </Text>
        <Badge variant={stateVariant(linkState, device.present)}>
          <Text>{linkStateLabel(linkState ?? "lost")}</Text>
        </Badge>
      </View>
    </Pressable>
  );
}
