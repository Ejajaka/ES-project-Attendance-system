import React, { useState } from "react";
import {
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { bloom, colors, MONO, spacing, text } from "../theme";

/* ------------------------------------------------------------------ *
 * NERV CRT-console primitives.
 *
 * Rules of this system:
 *  - NO GREY CHROME. Panels are colour-blocked: a solid tone header bar
 *    (black ink on neon), a tone-tinted edge, a black body. Never a thin
 *    grey outline box — that's web-page thinking, not NERV.
 *  - DITHER over rules. Texture comes from unicode shade-block dither
 *    bands (▓▒░) and scanlines, the way a CRT renders gradients.
 *  - ALERTS ARE THE UI. State changes slam a full-screen interjection
 *    popup ("PATTERN GREEN", "EMERGENCY") — the console talks to you.
 *  - STATIC STATUS. Lamps never blink. Bloom is the only light.
 * ------------------------------------------------------------------ */

/** Confidence → status tone (matches server thresholds at 0.5). */
export function toneFor(v: number): string {
  if (v >= 0.6) return colors.green;
  if (v >= 0.3) return colors.amber;
  return colors.red;
}

/** Dim (tinted, not grey) edge variant for a given neon tone. */
export function dimFor(tone: string): string {
  switch (tone) {
    case colors.purple:
      return colors.purpleDim;
    case colors.green:
      return colors.greenDim;
    case colors.amber:
      return colors.amberDim;
    case colors.red:
      return colors.redDim;
    case colors.cyan:
      return colors.cyanDim;
    default:
      return colors.lineStrong;
  }
}

/** Static status mark — flat diamond/square with a faint neon halo. Never blinks. */
export function Lamp({
  tone = colors.green,
  size = 8,
  shape = "diamond",
}: {
  tone?: string;
  size?: number;
  shape?: "diamond" | "square";
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        backgroundColor: tone,
        transform: shape === "diamond" ? [{ rotate: "45deg" }] : [],
        boxShadow: bloom(tone, 0.5, size * 2),
      }}
    />
  );
}

/** CRT dither texture — unicode shade blocks (▓▒░), the classic 2-tone
 * halftone. One Text per line, so it's cheap: texture without images. */
export function Dither({
  tone = colors.dim,
  lines = 2,
  chars = 68,
  opacity = 0.35,
  invert = false,
}: {
  tone?: string;
  lines?: number;
  chars?: number;
  opacity?: number;
  /** true = light texture on tone plates (black-ish blocks) */
  invert?: boolean;
}) {
  const shades = ["▓▒░ ", "▒░ ▓", "░ ▓▒"];
  return (
    <View pointerEvents="none" style={{ opacity }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Text
          key={i}
          numberOfLines={1}
          style={{
            fontFamily: MONO,
            fontSize: 7,
            lineHeight: 8,
            letterSpacing: 0,
            color: invert ? colors.bg : tone,
          }}
        >
          {(shades[i % shades.length] ?? shades[0]!).repeat(Math.ceil(chars / 4))}
        </Text>
      ))}
    </View>
  );
}

/** Ambient CRT wash — big, very faint colored blobs bleeding into the black
 * field. The "subtle bloom that affects the whole bg subconsciously". */
export function BloomField({
  a = colors.cyan,
  b = colors.purple,
  opacity = 0.055,
}: {
  a?: string;
  b?: string;
  opacity?: number;
}) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      <View
        style={{
          position: "absolute",
          top: -160,
          left: -100,
          width: 480,
          height: 480,
          borderRadius: 999,
          backgroundColor: a,
          opacity,
        }}
      />
      <View
        style={{
          position: "absolute",
          bottom: -180,
          right: -80,
          width: 520,
          height: 520,
          borderRadius: 999,
          backgroundColor: b,
          opacity,
        }}
      />
    </View>
  );
}

/** Faint Cartesian wire grid — NERV vector-graphics field. */
export function WireGrid({
  color = "rgba(255,255,255,0.08)",
  opacity = 0.5,
  step = 52,
}: {
  color?: string;
  opacity?: number;
  step?: number;
}) {
  const cols = Math.ceil(1920 / step) + 1;
  const rows = Math.ceil(900 / step) + 1;
  return (
    <View pointerEvents="none" style={{ ...StyleSheet.absoluteFillObject, opacity }}>
      {Array.from({ length: cols }).map((_, i) => (
        <View key={`v${i}`} style={{ position: "absolute", left: i * step, top: 0, bottom: 0, width: 1, backgroundColor: color }} />
      ))}
      {Array.from({ length: rows }).map((_, i) => (
        <View key={`h${i}`} style={{ position: "absolute", top: i * step, left: 0, right: 0, height: 1, backgroundColor: color }} />
      ))}
    </View>
  );
}

/** CRT scanlines — thin repeating rules. */
export function Scanlines({
  color = colors.bg,
  opacity = 0.25,
  spacing = 5,
}: {
  color?: string;
  opacity?: number;
  spacing?: number;
}) {
  const lines = Math.ceil(600 / spacing) + 1;
  return (
    <View pointerEvents="none" style={{ ...StyleSheet.absoluteFillObject, opacity }}>
      {Array.from({ length: lines }).map((_, i) => (
        <View key={i} style={{ position: "absolute", top: i * spacing, left: 0, right: 0, height: 1, backgroundColor: color }} />
      ))}
    </View>
  );
}

/** Corner crop marks — tone-tinted, not grey. */
function Corners({ tone, size = 10, width = 2 }: { tone: string; size?: number; width?: number }) {
  const b = (side1: "borderTopWidth" | "borderBottomWidth", side2: "borderLeftWidth" | "borderRightWidth") =>
    ({
      position: "absolute",
      width: size,
      height: size,
      [side1]: width,
      [side2]: width,
      borderColor: tone,
    }) as const;
  return (
    <View pointerEvents="none" style={{ ...StyleSheet.absoluteFillObject }}>
      <View style={{ ...b("borderTopWidth", "borderLeftWidth"), top: 0, left: 0 }} />
      <View style={{ ...b("borderTopWidth", "borderRightWidth"), top: 0, right: 0 }} />
      <View style={{ ...b("borderBottomWidth", "borderLeftWidth"), bottom: 0, left: 0 }} />
      <View style={{ ...b("borderBottomWidth", "borderRightWidth"), bottom: 0, right: 0 }} />
    </View>
  );
}

/**
 * Colour-blocked data panel: solid tone header bar (black ink on neon),
 * tone-tinted edge, black dithered body. This is the NGE look — NOT a
 * grey-bordered card.
 */
export function Panel({
  title,
  accentLabel,
  right,
  tone = colors.purple,
  children,
  style,
  bodyGap = spacing.sm,
  grid = false,
}: {
  title: string;
  accentLabel?: string;
  right?: React.ReactNode;
  tone?: string;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  bodyGap?: number;
  grid?: boolean;
}) {
  return (
    <View
      style={[
        {
          borderWidth: 1,
          borderColor: dimFor(tone),
          backgroundColor: colors.panel,
        },
        style,
      ]}
    >
      {grid && <WireGrid />}
      <Corners tone={tone} />
      {/* Solid tone title bar — the colour-blocked header */}
      <View
        style={{
          backgroundColor: tone,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: spacing.xs,
          paddingVertical: 3,
        }}
      >
        <Text style={styles.panelTitle}>{title}</Text>
        {accentLabel ? (
          <Text style={[styles.panelAccent]}>{accentLabel}</Text>
        ) : null}
        <View style={{ flex: 1 }} />
        {right}
      </View>
      {/* Dither seam under the bar — CRT gradient */}
      <View style={{ backgroundColor: tone }}>
        <Dither invert lines={1} chars={90} opacity={0.35} />
      </View>
      <View style={{ padding: spacing.sm, gap: bodyGap, backgroundColor: colors.panel }}>{children}</View>
    </View>
  );
}

/** Flat neon confidence bar with tick marks — vector gauge. */
export function Meter({
  label,
  value,
  right,
  barColor,
  height = 8,
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
        <Text style={[text.label, {  letterSpacing: 2, color: colors.dim }]}>{label}</Text>
        {right ?? (
          <Text style={[text.value, { color: tone, fontSize: 11,  }]}>{v.toFixed(2)}</Text>
        )}
      </View>
      <View style={{ height, backgroundColor: colors.field, borderWidth: 1, borderColor: dimFor(tone) }}>
        <View
          style={{
            width: `${Math.round(v * 100)}%`,
            height: "100%",
            backgroundColor: tone,
            boxShadow: v > 0.05 ? bloom(tone, 0.3, 8) : undefined,
          }}
        />
        {[25, 50, 75].map((t) => (
          <View
            key={t}
            style={{
              position: "absolute",
              left: `${t}%`,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: colors.lineStrong,
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
  labelWidth = 104,
  monoV = true,
  onPress,
}: {
  k: string;
  v: React.ReactNode;
  tone?: string;
  labelWidth?: number;
  monoV?: boolean;
  onPress?: () => void;
}) {
  const content = (
    <>
      <Text style={[text.label, { width: labelWidth, letterSpacing: 2 }]}>{k}</Text>
      {typeof v === "string" ? (
        <Text
          style={[monoV ? text.value : text.label, { color: tone, flexShrink: 1, fontSize: monoV ? 11 : 11 }]}
          numberOfLines={1}
        >
          {v}
        </Text>
      ) : (
        <View style={{ flexShrink: 1 }}>{v}</View>
      )}
    </>
  );
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "baseline",
          gap: spacing.sm,
          minHeight: 16,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm, minHeight: 16 }}>
      {content}
    </View>
  );
}

/** Massive block-letter plate — the "EMERGENCY / RECOGNIZED" screens. */
export function Interjection({
  text: content,
  sub,
  tone = colors.red,
  plate = false,
  big = false,
}: {
  text: string;
  sub?: string;
  tone?: string;
  /** Flat neon colour plate behind the letters (NERV colour-blocked bar). */
  plate?: boolean;
  big?: boolean;
}) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: tone,
        backgroundColor: plate ? tone : colors.field,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.lg,
        alignItems: "center",
        gap: 2,
        overflow: "hidden",
        boxShadow: bloom(tone, 0.25, 22),
      }}
    >
      {!plate && <Scanlines />}
      <Dither tone={tone} lines={1} chars={60} opacity={plate ? 0 : 0.5} />
      <Text
        style={[
          text.interject,
          big && { fontSize: 48 },
          {
            color: plate ? colors.bg : tone,
            textAlign: "center",
            textTransform: "uppercase",
            textShadowColor: plate ? colors.bg : tone,
            textShadowRadius: plate ? 0 : 10,
          },
        ]}
      >
        {content}
      </Text>
      {sub ? (
        <Text style={[text.interjectSub, { color: plate ? colors.bg : colors.dim }]}>{sub}</Text>
      ) : null}
      <Dither tone={tone} lines={1} chars={60} opacity={plate ? 0 : 0.5} />
    </View>
  );
}

/**
 * Full-screen NERV alert — the popup layer the console was missing.
 * State changes (verdict flips, faults, completions) slam this over the
 * screen; the operator acknowledges with 了解 ACKNOWLEDGE.
 */
export function AlertOverlay({
  title,
  jp,
  sub,
  detail,
  tone = colors.red,
  onAck,
}: {
  title: string;
  jp?: string;
  sub?: string;
  detail?: string;
  tone?: string;
  onAck: () => void;
}) {
  return (
    <View style={styles.alertScrim}>
      <View style={styles.alertStack}>
        <Hazard height={8} />
        <View
          style={{
            borderWidth: 1,
            borderColor: tone,
            backgroundColor: colors.bg,
            alignItems: "center",
            overflow: "hidden",
            boxShadow: bloom(tone, 0.45, 30),
          }}
        >
          <View style={{ backgroundColor: tone, alignSelf: "stretch", alignItems: "center", paddingVertical: 4 }}>
            <Text style={styles.alertBarText}>NERV · SHUSSEKI ALERT</Text>
          </View>
          <Dither tone={tone} lines={2} chars={70} opacity={0.3} />
          <View style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.xl, alignItems: "center", gap: 4 }}>
            {jp ? (
              <Text style={[text.hudJapanese, { fontSize: 30, color: tone, letterSpacing: 8 }]}>{jp}</Text>
            ) : null}
            <Text
              style={[
                text.interject,
                { fontSize: 40 },
                { color: tone, textAlign: "center", textShadowColor: tone, textShadowRadius: 12 },
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {title}
            </Text>
            {sub ? <Text style={[text.interjectSub, { color: colors.text }]}>{sub}</Text> : null}
            {detail ? (
              <Text selectable style={[styles.alertDetail]}>
                {detail}
              </Text>
            ) : null}
          </View>
          <Dither tone={tone} lines={2} chars={70} opacity={0.3} />
        </View>
        <Hazard height={8} a={tone} />
        <HudButton variant="ghost" title="了解 · ACKNOWLEDGE" onPress={onAck} style={{ marginTop: spacing.md, minWidth: 260 }} />
      </View>
      <Scanlines opacity={0.18} />
    </View>
  );
}

/** Tactical switch button — flat, edge-brightens on press (mechanical). */
const btnVariants = {
  primary: { border: colors.greenDim, text: colors.green, bg: colors.field },
  purple: { border: colors.purpleDim, text: colors.purple, bg: colors.field },
  amber: { border: colors.amberDim, text: colors.amber, bg: colors.field },
  danger: { border: colors.redDim, text: colors.red, bg: colors.field },
  ghost: { border: colors.lineStrong, text: colors.dim, bg: colors.field },
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
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.sm,
          opacity: disabled ? 0.4 : 1,
          /* Mechanical switch: press brightens the plate edge + sinks it */
          ...(pressed
            ? { backgroundColor: colors.panelAlt, borderColor: v.text, transform: [{ translateY: 1 }] }
            : {}),
          /* Subtle neon edge on active primary switches */
          ...(variant === "primary" && !disabled ? { boxShadow: bloom(v.text, 0.12, 10) } : {}),
        },
        style,
      ]}
    >
      {children ?? (
        <Text
          style={[
            text.value,
            {
              color: v.text,
              
              letterSpacing: 2,
              fontSize: small ? 10 : 12,
              textAlign: "center",
              textTransform: "uppercase",
            },
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
    <View style={{ borderWidth: 1, borderColor: dimFor(colors.cyan), backgroundColor: colors.field }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={{ paddingHorizontal: spacing.sm, paddingVertical: 6, flexDirection: "row", alignItems: "center" }}
      >
        <Text style={[text.label, { color: colors.cyan,  }]}>
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

const styles = StyleSheet.create({
  panelTitle: {
    color: colors.bg,
    
    letterSpacing: 2,
    fontSize: 11,
    fontFamily: MONO,
    textTransform: "uppercase",
  },
  panelAccent: {
    color: colors.bg,
    opacity: 0.65,
    fontSize: 9,
    fontFamily: MONO,
    letterSpacing: 2,
    marginLeft: 8,
    
  },
  alertScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.86)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  alertStack: {
    width: "72%",
    maxWidth: 760,
    alignItems: "center",
  },
  alertBarText: {
    color: colors.bg,
    
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: 4,
  },
  alertDetail: {
    fontFamily: MONO,
    fontSize: 11,
    color: colors.dim,
    textAlign: "center",
    marginTop: 6,
  },
});

/** Thin dither rule with a center tag — texture instead of a grey line. */
export function Divider({ label, tone = colors.faint }: { label?: string; tone?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, opacity: 0.5 }}>
        <Dither tone={tone} lines={1} chars={30} />
      </View>
      {label ? <Text style={[text.tiny, { color: colors.faint, letterSpacing: 3,  }]}>{label}</Text> : null}
      <View style={{ flex: 1, opacity: 0.5 }}>
        <Dither tone={tone} lines={1} chars={30} />
      </View>
    </View>
  );
}

/** Mode-screen top chrome: hazard rails + masthead band + static state lamp. */
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
        <Text style={[text.hudJapanese, { fontSize: 24, letterSpacing: 4 }]}>{jp}</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[text.section, { letterSpacing: 4, fontSize: 12 }]}>{en}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Lamp tone={stateTone} size={6} />
            <Text style={[text.tiny, { letterSpacing: 2, color: stateTone,  }]}>{stateLabel}</Text>
          </View>
        </View>
        {right}
      </View>
      <Hazard height={8} a={colors.purple} />
    </View>
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