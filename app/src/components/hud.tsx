import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { colors, MONO, radius, spacing, text } from "../theme";

/* ------------------------------------------------------------------ *
 * Neon-Genesis-style HUD primitives. Pure core RN (no native deps):
 * every effect is borders, opacity, text-shadow, transform, Animated.
 * ------------------------------------------------------------------ */

/** Confidence → status tone (matches server thresholds at 0.5). */
export function toneFor(v: number): string {
  if (v >= 0.6) return colors.green;
  if (v >= 0.3) return colors.amber;
  return colors.red;
}

/** Pulsing status lamp (green=online, amber=warn, red=fault). */
export function StatusDot({
  tone = colors.green,
  pulse = true,
  size = 8,
}: {
  tone?: string;
  pulse?: boolean;
  size?: number;
}) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.15, duration: 700, useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, v]);

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: radius.full,
        backgroundColor: tone,
        opacity: pulse ? v : 1,
        shadowColor: tone,
        shadowOpacity: 0.9,
        shadowRadius: size,
        shadowOffset: { width: 0, height: 0 },
      }}
    />
  );
}

/** Diagonal hazard stripe — the classic NERV warning band. */
export function Hazard({
  height = 10,
  a = colors.amber,
  b = colors.bg,
}: {
  height?: number;
  a?: string;
  b?: string;
}) {
  const bands = 26;
  const w = height * 0.9;
  return (
    <View style={{ height, width: "100%", overflow: "hidden", backgroundColor: b }}>
      <View
        style={{
          position: "absolute",
          left: -height,
          right: -height,
          top: 0,
          bottom: 0,
          flexDirection: "row",
          alignItems: "center",
          transform: [{ skewX: "-45deg" }],
        }}
      >
        {Array.from({ length: bands }).map((_, i) => (
          <View
            key={i}
            style={{
              width: w,
              height: 400,
              backgroundColor: i % 2 === 0 ? a : b,
              marginRight: w,
            }}
          />
        ))}
      </View>
    </View>
  );
}

/** Bordered data panel with a header bar, in the console style. */
export function Panel({
  title,
  accentLabel,
  right,
  tone = colors.purple,
  children,
  style,
  bodyGap = spacing.sm,
}: {
  title: string;
  accentLabel?: string;
  right?: React.ReactNode;
  tone?: string;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  bodyGap?: number;
}) {
  return (
    <View
      style={[
        {
          borderWidth: 1,
          borderColor: colors.line,
          backgroundColor: colors.panel,
          borderRadius: radius.sm,
        },
        style,
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: spacing.md,
          paddingVertical: 6,
          backgroundColor: colors.bgRaised,
          borderBottomWidth: 1,
          borderBottomColor: colors.line,
        }}
      >
        <Text style={[styles.panelTitle, { color: tone }]}>▚ {title}</Text>
        {accentLabel ? (
          <Text style={[text.tiny, { marginLeft: 8, color: colors.faint, letterSpacing: 3 }]}>
            {accentLabel}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        {right}
      </View>
      <View style={{ padding: spacing.md, gap: bodyGap }}>{children}</View>
    </View>
  );
}

/** Horizontal confidence bar with a label + live value. */
export function Meter({
  label,
  value,
  right,
  barColor,
  height = 6,
}: {
  label: string;
  value: number;
  right?: React.ReactNode;
  barColor?: string;
  height?: number;
}) {
  const v = Math.max(0, Math.min(1, value));
  const tone = barColor ?? toneFor(v);
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Text style={text.label}>{label}</Text>
        {right ?? (
          <Text style={[text.value, { color: tone, fontSize: 11 }]}>{v.toFixed(2)}</Text>
        )}
      </View>
      <View
        style={{
          height,
          backgroundColor: colors.line,
          borderRadius: radius.full,
          overflow: "hidden",
          flexDirection: "row",
        }}
      >
        <View
          style={{
            width: `${Math.round(v * 100)}%`,
            height: "100%",
            backgroundColor: tone,
          }}
        />
        {/* 25% tick marks */}
        {[25, 50, 75].map((t) => (
          <View
            key={t}
            style={{
              position: "absolute",
              left: `${t}%`,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: colors.bg,
            }}
          />
        ))}
      </View>
    </View>
  );
}

/** Label / value keyline — the workhorse of a debug readout. */
export function ValueRow({
  k,
  v,
  tone = colors.text,
  labelWidth = 108,
  monoV = true,
}: {
  k: string;
  v: React.ReactNode;
  tone?: string;
  labelWidth?: number;
  monoV?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm, minHeight: 16 }}>
      <Text style={[text.label, { width: labelWidth }]}>{k}</Text>
      {typeof v === "string" ? (
        <Text
          style={[monoV ? text.value : text.label, { color: tone, flexShrink: 1, fontSize: monoV ? 12 : 10 }]}
          numberOfLines={1}
        >
          {v}
        </Text>
      ) : (
        <View style={{ flexShrink: 1 }}>{v}</View>
      )}
    </View>
  );
}

/** Tactical button. Variants keyed by the palette roles above. */
const btnVariants = {
  primary: { border: colors.greenDim, text: colors.greenBright, bg: "#0c1208" },
  purple: { border: colors.purpleDim, text: colors.purpleBright, bg: "#0d0a18" },
  amber: { border: colors.amberDim, text: colors.amber, bg: "#120c04" },
  danger: { border: colors.redDim, text: colors.red, bg: "#140808" },
  ghost: { border: colors.lineStrong, text: colors.dim, bg: colors.panelAlt },
} as const;

export type HudVariant = keyof typeof btnVariants;

export function HudButton({
  variant = "primary",
  title,
  onPress,
  disabled,
  style,
  small,
  children,
}: {
  variant?: HudVariant;
  title?: string;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
  children?: React.ReactNode;
}) {
  const v = btnVariants[variant];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          borderWidth: 1,
          borderColor: v.border,
          backgroundColor: v.bg,
          paddingVertical: small ? 6 : 10,
          paddingHorizontal: small ? 10 : 14,
          borderRadius: radius.sm,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.sm,
          opacity: disabled ? 0.35 : pressed ? 0.65 : 1,
        },
        style,
      ]}
    >
      {children ?? (
        <Text
          style={[
            text.value,
            { color: v.text, fontWeight: "700", letterSpacing: 1, fontSize: small ? 10 : 12 },
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

/** Collapsible raw JSON inspector for report payloads / server responses. */
export function RawJson({ data, label = "RAW" }: { data: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(data ?? null, null, 2);
  return (
    <View style={{ borderWidth: 1, borderColor: colors.line, backgroundColor: colors.field, borderRadius: radius.sm }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={{ paddingHorizontal: spacing.sm, paddingVertical: 6, flexDirection: "row", alignItems: "center" }}
      >
        <Text style={[text.label, { color: colors.cyan }]}>
          {open ? "▼" : "▶"} {label} ({json.length}B)
        </Text>
      </Pressable>
      {open ? (
        <Text selectable style={[text.tiny, { color: colors.dim, padding: 8, fontFamily: MONO }]}>
          {json}
        </Text>
      ) : null}
    </View>
  );
}

/** Thin rule with a center tag. */
export function Divider({ label }: { label?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      {label ? <Text style={[text.tiny, { color: colors.faint, letterSpacing: 3 }]}>{label}</Text> : null}
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}

const styles = StyleSheet.create({
  panelTitle: {
    fontWeight: "700",
    letterSpacing: 2,
    fontSize: 10,
    fontFamily: MONO,
  },
});

/** Mode-screen top chrome: NPU console title bar used by every screen. */
export function ConsoleHeader({
  jp,
  en,
  stateLabel,
  stateTone = colors.green,
  right,
}: {
  jp: string;
  en: string;
  stateLabel: string;
  stateTone?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={{ gap: 0 }}>
      <Hazard height={8} />
      <View
        style={{
          backgroundColor: colors.bgRaised,
          borderLeftWidth: 1,
          borderRightWidth: 1,
          borderColor: colors.line,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.md,
        }}
      >
        <Text style={[text.hudJapanese, { fontSize: 26, letterSpacing: 4 }]}>{jp}</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[text.section, { letterSpacing: 4 }]}>{en}</Text>
          <Text style={[text.tiny, { letterSpacing: 2 }]}>
            <StatusDot tone={stateTone} pulse={stateTone !== colors.dim} size={6} /> {stateLabel}
          </Text>
        </View>
        {right}
      </View>
      <Hazard height={8} a={colors.purple} />
    </View>
  );
}