import React from "react";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/**
 * Typographic chevron glyph.
 *
 * lucide-react-native is NOT used here: it pulls react-native-svg, and the
 * workspace-hoisted react-native-svg sources crash Metro on RN 0.76.9
 * ("Unknown prop type for opacity: undefined" in the fabric codegen). A
 * plain glyph keeps the chevron affordance without any native dep.
 */
export function Chevron({
  direction = "left",
  className,
}: {
  direction?: "left" | "right";
  className?: string;
}) {
  return (
    <Text className={cn("text-2xl leading-6 text-muted-foreground", className)}>
      {direction === "left" ? "‹" : "›"}
    </Text>
  );
}
