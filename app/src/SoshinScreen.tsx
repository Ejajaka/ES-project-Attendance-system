import React, { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { NativeSensors } from "./lib/nativeSensors";
import type { Settings } from "./settings";
import { presetById } from "./lib/presets";
import { SoshinController, type SoshinConfig } from "./lib/modes/soshin";
import { announceHotspot, ensureSession } from "./lib/server";
import { useSessionPresence } from "./lib/useSessionPresence";
import { roleLabel } from "./lib/roles";
import { DEVICE_ID } from "./identity";
import { VERSION } from "./version";
import { colors, MONO, spacing, text } from "./theme";
import { DeviceLinkRow } from "./components/DeviceLinkRow";
import {
  AlertOverlay,
  BloomField,
  ConsoleHeader,
  Divider,
  HudButton,
  Interjection,
  Lamp,
  Panel,
  ValueRow,
  WireGrid,
} from "./components/hud";

/** One full-screen console alert. */
interface ConsoleAlert {
  title: string;
  jp?: string;
  sub?: string;
  detail?: string;
  tone: string;
}

const STEP_MS = 30_000;

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString();
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

export default function SoshinScreen({
  settings,
  serverUrl,
  autoEngage,
  onExit,
}: {
  settings: Settings;
  serverUrl: string;
  autoEngage?: boolean;
  onExit: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [hotspot, setHotspot] = useState<{ ssid: string; passphrase: string } | null>(null);
  const [ensured, setEnsured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [broadcasts, setBroadcasts] = useState(0);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [bleState, setBleState] = useState<string>("idle");
  const [announced, setAnnounced] = useState<boolean | null>(null);
  const [, setNow] = useState(Date.now());
  const [alert, setAlert] = useState<ConsoleAlert | null>(null);
  const bleFailRef = useRef(false);
  const controllerRef = useRef<SoshinController | null>(null);
  const sensorsRef = useRef<NativeSensors | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { devices, rttMs } = useSessionPresence(
    serverUrl,
    settings.sessionId,
    running, // only poll while the room beacon is live
  );

  // 1s clock tick driving the "next code in …" countdown (cheap).
  useEffect(() => {
    if (!running) return;
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [running]);

  const start = async () => {
    setError(null);
    try {
      const ok = await ensureSession(serverUrl, {
        sessionId: settings.sessionId,
        roomId: settings.roomId,
        secret: settings.secret,
      });
      setEnsured(ok);

      const sensors = new NativeSensors();
      sensorsRef.current = sensors;
      const config: SoshinConfig = {
        deviceId: DEVICE_ID,
        roomId: settings.roomId,
        sessionId: settings.sessionId,
        nodeId: DEVICE_ID,
        secret: new TextEncoder().encode(settings.secret),
        step: 30,
      };
      const controller = new SoshinController(sensors, config);
      const h = await controller.start();
      controllerRef.current = controller;
      setHotspot(
        h && (h.ssid || h.passphrase)
          ? { ssid: h.ssid ?? "(no ssid)", passphrase: h.passphrase ?? "" }
          : null,
      );
      setRunning(true);

      // Publish the live AutoHotspot SSID/passphrase so receivers that picked
      // the same preset room can auto-join it.
      const announce = async () => {
        const live = controller.hotspotInfo;
        if (!live?.ssid) return;
        const okAnnounce = await announceHotspot(serverUrl, settings.sessionId, {
          deviceId: DEVICE_ID,
          ssid: live.ssid,
          passphrase: live.passphrase,
        });
        setAnnounced(okAnnounce);
      };
      await announce();

      const loop = async (now: number) => {
        const c = await controller.broadcast(now);
        setCode(c);
        setLastAt(Date.now());
        setNextAt(now + STEP_MS);
        setBroadcasts((n) => n + 1);
        void announce(); // keep the hotspot announce fresh (re-announced each step)
        const adv = sensorsRef.current?.lastAdvertise;
        setBleState(
          adv == null
            ? "unknown"
            : adv.started
              ? "OK"
              : `FAIL (errorCode=${adv.errorCode})`,
        );
        // BLE beacon fault → one console alert per failure episode.
        if (adv && !adv.started && !bleFailRef.current) {
          bleFailRef.current = true;
          setAlert({
            title: "ADVERTISE FAULT",
            jp: "通信異常",
            sub: "BLE BEACON REJECTED BY RADIO STACK",
            detail: `errorCode=${adv.errorCode} (1=DATA_TOO_LARGE 2=TOO_MANY 3=ALREADY_STARTED 4=UNSUPPORTED 5=INTERNAL)`,
            tone: colors.amber,
          });
        }
        if (adv?.started) bleFailRef.current = false;
      };
      await loop(Date.now());
      intervalRef.current = setInterval(() => void loop(Date.now()), STEP_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setAlert({
        title: "ENGAGE FAILED",
        jp: "起動失敗",
        sub: "TRANSMITTER (SOSHIN) COULD NOT BE RAISED",
        detail: msg,
        tone: colors.red,
      });
    }
  };

  const stop = async () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (controllerRef.current) {
      try {
        await controllerRef.current.stop();
      } catch (e) {
        console.warn("[transmitter] stop failed:", e);
      }
    }
    controllerRef.current = null;
    sensorsRef.current = null;
    setRunning(false);
    setCode(null);
    setHotspot(null);
    setLastAt(null);
    setNextAt(null);
    setBleState("idle");
    setAnnounced(null);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  // Headless auto-engage (deep link `shusseki://tx`) — start once on mount.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoEngage && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEngage]);

  const countdown =
    running && nextAt != null ? Math.max(0, Math.round((nextAt - Date.now()) / 1000)) : 0;
  const bleOk = bleState === "OK";
  const bleBad = bleState.startsWith("FAIL");

  return (
    <View style={styles.root}>
      <BloomField a={colors.purple} b={colors.amber} />
      <ConsoleHeader
        jp="送信"
        en="TRANSMITTER · SOSHIN"
        stateLabel={running ? "OPERATIONAL" : "STANDBY"}
        stateTone={running ? colors.green : colors.dim}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Text style={[text.tiny, { letterSpacing: 2 }]}>{VERSION}</Text>
            <HudButton variant="ghost" small title="EXIT" onPress={onExit} />
          </View>
        }
      />
      <ScrollView contentContainerStyle={styles.scroll} style={{ flex: 1 }}>
        <View style={styles.cols}>
          <View style={styles.colA}>
            <Interjection
              text={running ? "OPERATIONAL" : "STANDBY"}
              sub={running ? `ROLLING CODE · ${code ?? "—"}` : "AWAITING ENGAGE"}
              tone={running ? colors.green : colors.dim}
            />
            <Panel title="TRANSMISSION / 転送" tone={colors.green} accentLabel="TOTP-30S" grid>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
                <Text style={[text.label, { letterSpacing: 2 }]}>current code</Text>
                <Text style={styles.codeBig}>{code ?? "- - - - - -"}</Text>
              </View>
              <ValueRow k="broadcasts" v={String(broadcasts)} />
              <ValueRow k="last transmit" v={lastAt ? fmtTime(lastAt) : "—"} />
              <ValueRow
                k="next in"
                v={running ? fmtClock(countdown) : "—"}
                tone={countdown <= 5 && running ? colors.amber : colors.text}
              />
              <ValueRow
                k="ultrasonic"
                v={running ? "EMITTING CHIRP" : "idle"}
                tone={running ? colors.green : colors.dim}
              />
              <ValueRow
                k="BLE beacon"
                v={!running ? "idle" : bleBad ? bleState : "ADVERTISING ✓"}
                tone={!running ? colors.dim : bleBad ? colors.red : bleOk ? colors.green : colors.amber}
              />
            </Panel>
            <View style={styles.controls}>
              {!running ? (
                <HudButton variant="purple" title="UNIT-01 ENGAGE" onPress={start} />
              ) : (
                <HudButton variant="danger" title="SHUTDOWN" onPress={stop} />
              )}
              <HudButton variant="ghost" title="EXIT" onPress={onExit} />
            </View>
          </View>

          <View style={styles.colB}>
            <Panel title="BEACON / 部屋識別" tone={colors.purple} accentLabel="NODE">
              <ValueRow k="preset" v={presetById(settings.presetId).name} labelWidth={92} tone={colors.cyan} />
              <ValueRow k="nodeId" v={DEVICE_ID} labelWidth={92} />
              <ValueRow k="roomId" v={settings.roomId} labelWidth={92} />
              <ValueRow k="sessionId" v={settings.sessionId} labelWidth={92} />
              <Divider />
              <ValueRow
                k="session"
                v={ensured == null ? "checking…" : ensured ? "ENSURED ON SERVER" : "UNCERTAIN (offline?)"}
                tone={ensured ? colors.green : colors.amber}
                labelWidth={92}
              />
              <ValueRow
                k="uplink"
                v={rttMs == null ? "—" : `presence poll ${rttMs}ms`}
                tone={rttMs != null && rttMs > 1500 ? colors.amber : colors.green}
                labelWidth={92}
              />
            </Panel>

            {hotspot && (
              <Panel title="HOTSPOT / 接続網" tone={colors.amber} accentLabel="LOCAL-ONLY">
                <ValueRow k="ssid" v={`"${hotspot.ssid}"`} tone={colors.amber} labelWidth={92} />
                <ValueRow k="passphrase" v={`"${hotspot.passphrase}"`} tone={colors.amber} labelWidth={92} />
                <ValueRow
                  k="announce"
                  v={announced == null ? "pending…" : announced ? "PUBLISHED TO SERVER ✓" : "FAILED (receivers: manual CONFIG)"}
                  tone={announced ? colors.green : announced === false ? colors.red : colors.dim}
                  labelWidth={92}
                />
                <Text style={[text.tiny, { color: colors.faint, lineHeight: 14 }]}>
                  Demo fallback only: in the atlas deployment the ESP32 hosts the
                  open network and receivers join that. To use this hotspot by
                  hand, set RECEIVER → CONFIG to this SSID/passphrase.
                </Text>
              </Panel>
            )}

            <Panel
              title="ROOM MONITOR / 部屋監視"
              tone={colors.cyan}
              accentLabel={`${devices.length} FOUND · ${devices.filter((d) => (d.link?.state ?? "lost") === "connected").length} LINKED`}
              grid
            >
              {devices.length === 0 ? (
                <Text style={[text.tiny, { color: colors.faint }]}>
                  No receivers found yet. A receiver must press ENGAGE with the
                  same room preset, then it reports here every few seconds.
                </Text>
              ) : (
                devices.map((d) => (
                  <DeviceLinkRow
                    key={d.deviceId}
                    device={d}
                    now={Date.now()}
                    onPress={() =>
                      setAlert({
                        title: d.present ? "UNIT LINKED" : "UNIT WEAK",
                        jp: "個機状態",
                        sub: `${roleLabel(d.mode)} · ${d.deviceId}`,
                        detail: JSON.stringify(d, null, 2),
                        tone:
                          d.link?.state === "connected"
                            ? colors.green
                            : d.link?.state === "degraded"
                              ? colors.amber
                              : colors.red,
                      })
                    }
                  />
                ))
              )}
            </Panel>
          </View>
        </View>

        {error && (
          <View style={styles.cols}>
            <Panel title="FAULT / 異常" tone={colors.red} accentLabel="ERROR">
              <Text style={[text.value, { color: colors.red }]}>{error}</Text>
            </Panel>
          </View>
        )}
      </ScrollView>

      {/* Full-screen NERV alert layer — faults surface as console popups */}
      {alert && (
        <AlertOverlay
          title={alert.title}
          jp={alert.jp}
          sub={alert.sub}
          detail={alert.detail}
          tone={alert.tone}
          onAck={() => setAlert(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 0, gap: 0 },
  cols: { flexDirection: "row", flexWrap: "wrap", gap: 0 },
  colA: { flex: 2, gap: 0, minWidth: 300 },
  colB: { flex: 3, gap: 0, minWidth: 300 },
  codeBig: {
    fontFamily: MONO,
    fontSize: 26,
    color: colors.green,
    letterSpacing: 3,
    textShadowColor: colors.green,
    textShadowRadius: 8,
  },
  controls: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
  },
});