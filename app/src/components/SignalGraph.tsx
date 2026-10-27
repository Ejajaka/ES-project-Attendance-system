import { useState } from "react";
import { Text, View } from "react-native";
import {
  lastPoint,
  latest,
  SIGNAL_Y_MAX,
  SIGNAL_Y_MIN,
  type SignalKey,
  type SignalPoint,
  type SignalSample,
  type SignalSegment,
  scaleY,
  toSegments,
  windowMs,
} from "../lib/signalGraph";
import { colors, MONO, spacing, text } from "../theme";

/** Width of the dBm label gutter (px). */
const GUTTER = 38;
/** Height of the bottom caption strip (px). */
const AXIS = 12;
const THICKNESS = 2;
const TICKS = [-30, -50, -70, -90];

const SERIES: Record<SignalKey, { label: string; tone: string }> = {
  ble: { label: "BLE", tone: colors.cyan },
  wifi: { label: "WIFI", tone: colors.green },
};

/** A 1-px rotated View draws one polyline segment — no chart dependency. */
function SegmentLine({ seg, tone }: { seg: SignalSegment; tone: string }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: seg.x - seg.length / 2,
        top: seg.y - THICKNESS / 2,
        width: seg.length,
        height: THICKNESS,
        backgroundColor: tone,
        transform: [{ rotate: `${seg.angle}rad` }],
      }}
    />
  );
}

function Endpoint({ point, tone }: { point: SignalPoint; tone: string }) {
  const size = 5;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: point.x - size / 2,
        top: point.y - size / 2,
        width: size,
        height: size,
        backgroundColor: tone,
      }}
    />
  );
}

function Legend({ label, value, tone }: { label: string; value: number | null; tone: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View style={{ width: 7, height: 7, backgroundColor: tone }} />
      <Text style={[text.tiny, { color: tone, letterSpacing: 2 }]}>{label}</Text>
      <Text style={[text.value, { color: tone, fontSize: 12 }]}>
        {value == null ? "—" : `${value} dBm`}
      </Text>
    </View>
  );
}

function fmtWindow(ms: number): string {
  if (!ms) return "0s";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/**
 * Live trace of the transmitter link: BLE beacon RSSI and WiFi AP RSSI over
 * time, one point per poll. Walk away from the room and the lines fall —
 * that is the distance curve the study needs.
 *
 * Pure React Native: each segment is a rotated View, so no chart library and
 * no extra native module.
 */
export function SignalGraph({
  samples,
  height = 136,
}: {
  samples: SignalSample[];
  height?: number;
}) {
  const [width, setWidth] = useState(0);
  const plotW = Math.max(0, width - GUTTER);
  const plotH = Math.max(0, height - AXIS);
  const ready = width > 0 && plotW > 0 && plotH > 0;

  return (
    <View style={{ gap: spacing.sm }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "baseline",
          columnGap: spacing.lg,
          rowGap: 4,
        }}
      >
        <Legend label={SERIES.ble.label} value={latest(samples, "ble")} tone={SERIES.ble.tone} />
        <Legend label={SERIES.wifi.label} value={latest(samples, "wifi")} tone={SERIES.wifi.tone} />
        <View style={{ flex: 1 }} />
        <Text style={[text.tiny, { color: colors.faint, letterSpacing: 1 }]}>
          {samples.length === 0
            ? "NO SAMPLES"
            : `${samples.length} PT · ${fmtWindow(windowMs(samples))}`}
        </Text>
      </View>

      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height, overflow: "hidden" }}
      >
        {ready ? (
          <>
            {/* dBm grid + labels */}
            {TICKS.map((tick) => (
              <View
                key={`g${tick}`}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: GUTTER,
                  right: 0,
                  top: Math.round(scaleY(tick, plotH)),
                  height: 1,
                  backgroundColor: colors.line,
                }}
              />
            ))}
            {TICKS.map((tick) => (
              <Text
                key={`l${tick}`}
                style={{
                  position: "absolute",
                  left: 0,
                  top: Math.max(0, scaleY(tick, plotH) - 5),
                  width: GUTTER - 6,
                  textAlign: "right",
                  fontFamily: MONO,
                  fontSize: 8,
                  letterSpacing: 0,
                  color: colors.faint,
                }}
              >
                {tick}
              </Text>
            ))}

            {/* Traces */}
            {(["ble", "wifi"] as const).map((key) => {
              const tone = SERIES[key].tone;
              const point = lastPoint(samples, key, plotW, plotH);
              return (
                <View
                  key={key}
                  pointerEvents="none"
                  style={{ position: "absolute", left: GUTTER, top: 0, width: plotW, height: plotH }}
                >
                  {toSegments(samples, key, plotW, plotH).map((seg) => (
                    <SegmentLine
                      key={`${key}-${Math.round(seg.x)}-${Math.round(seg.y)}`}
                      seg={seg}
                      tone={tone}
                    />
                  ))}
                  {point && <Endpoint point={point} tone={tone} />}
                </View>
              );
            })}

            {samples.length === 0 && (
              <Text
                style={[
                  text.tiny,
                  {
                    position: "absolute",
                    left: GUTTER,
                    right: 0,
                    top: plotH / 2 - 6,
                    textAlign: "center",
                    color: colors.faint,
                  },
                ]}
              >
                AWAITING SAMPLES — ENGAGE
              </Text>
            )}
          </>
        ) : null}
      </View>

      <View style={{ height: AXIS, flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={[text.tiny, { color: colors.faint, letterSpacing: 1 }]}>← PAST</Text>
        <Text style={[text.tiny, { color: colors.faint, letterSpacing: 1 }]}>
          dBm · {SIGNAL_Y_MIN}..{SIGNAL_Y_MAX} · 5s POLL · NOW →
        </Text>
      </View>
    </View>
  );
}
