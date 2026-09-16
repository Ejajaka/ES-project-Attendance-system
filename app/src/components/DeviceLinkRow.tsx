import React from "react";
import { Pressable, Text, View } from "react-native";
import type { ServerPresence } from "../lib/server";
import { roleLabel } from "../lib/roles";
import { formatAge, linkChips, linkStateLabel } from "../lib/linkView";
import { colors, spacing, text } from "../theme";
import { Lamp } from "./hud";

/**
 * One device row in a room monitor. Two lines on purpose: the identity row
 * stays one line, and the three-channel link stats get the full width so they
 * never truncate in portrait.
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
  const tone = linkState
    ? linkState === "connected"
      ? colors.green
      : linkState === "degraded"
        ? colors.amber
        : colors.red
    : device.present
      ? colors.green
      : colors.red;
  const short =
    device.deviceId.length > 14
      ? `…${device.deviceId.slice(-12)}`
      : device.deviceId;
  const quality = Math.round((device.link?.quality ?? device.fused) * 100);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        gap: 2,
        paddingVertical: 3,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Lamp tone={tone} size={6} />
        <Text
          style={[text.value, { color: colors.text, flex: 1 }]}
          numberOfLines={1}
        >
          {device.present ? "●" : "○"} {short} · {roleLabel(device.mode)}
        </Text>
        <Text style={[text.tiny, { color: colors.faint }]}>
          {formatAge(device.timestamp, now)} ago
        </Text>
      </View>
      <Text
        style={[text.value, { color: tone, paddingLeft: 14 }]}
        numberOfLines={1}
      >
        {linkChips(device.link)} · {linkStateLabel(linkState ?? "lost")} ·{" "}
        {quality}%{device.ultrasonicServerValid ? " · CODE ✓" : ""}
      </Text>
    </Pressable>
  );
}
