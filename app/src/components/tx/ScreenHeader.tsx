import React from "react";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { View } from "react-native";

/**
 * Shared clean-style header row: an exit chevron button on the left, the
 * screen title in the middle, and an arbitrary right slot (state badge,
 * version, role). `lucide` icons are not wired into NativeWind styling, so
 * the chevron is a Plain Text glyph — styleable, no hidden currentColor risk.
 */
export function ScreenHeader({
  title,
  right,
  onExit,
}: {
  title: string;
  right?: React.ReactNode;
  onExit: () => void;
}) {
  return (
    <View className="flex-row items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        onPress={onExit}
        accessibilityLabel="Exit"
      >
        <Text className="text-2xl font-semibold text-muted-foreground">‹</Text>
      </Button>
      <Text
        className="flex-1 text-lg font-semibold text-foreground"
        numberOfLines={1}
      >
        {title}
      </Text>
      {right}
    </View>
  );
}
