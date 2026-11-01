import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Text } from "@/components/ui/text";
import { DataRow } from "./components/DataRow";
import { JsonBlock } from "./components/JsonBlock";
import {
  LogTailer,
  getPayload,
  logEvent,
} from "./components/debug/log";
import { Chevron } from "./components/Chevron";
import { getSelfNode, postNodeConfig, postNodeTime } from "./lib/server";
import { loadPersistentDeviceId } from "./lib/persistentDeviceId";
import { presetById } from "./lib/presets";
import type { Settings } from "./settings";
import { VERSION } from "./version";
import {
  bleGetPermissionsAsync,
  bleGetState,
  bleScanOnce,
  type NativeBleReading,
  type NativeBleState,
  type NativePermissionResponse as BlePermissionResponse,
} from "expo-shusseki-ble";
import {
  wifiGetObservation,
  wifiGetPermissionsAsync,
  type NativePermissionResponse as WifiPermissionResponse,
} from "expo-shusseki-wifi";
import {
  ultraGetPermissionsAsync,
  ultraListen,
  type NativePermissionResponse as UltraPermissionResponse,
} from "expo-shusseki-ultrasonic";
import { bioPerform, type NativeBiometricResult } from "expo-shusseki-biometric";

/* ---------------------------------------------------------------- *
 * DebugScreen — in-app diagnostics. Four tabs, small cards each. All
 * sensor actions are manual (button-triggered), no polling loops.
 * ---------------------------------------------------------------- */

export default function DebugScreen({
  settings,
  onExit,
}: {
  settings: Settings;
  onExit: () => void;
}) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [tab, setTab] = useState("env");

  // The persisted report identity, resolved once (same source the receiver
  // uses when it engages) — no writes, the loader only mints when missing.
  useEffect(() => {
    let mounted = true;
    void loadPersistentDeviceId().then((id) => {
      logEvent("device id resolved", id);
      if (mounted) setDeviceId(id);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top", "left", "right", "bottom"]}>
      <View className="flex-row items-center gap-2 px-4 pt-2">
        <Button variant="ghost" size="icon" onPress={onExit} accessibilityLabel="Exit debug">
          <Chevron direction="left" />
        </Button>
        <Text className="flex-1 text-center text-lg font-semibold">Debug · 診断</Text>
        <Badge variant="secondary">
          <Text>{VERSION}</Text>
        </Badge>
      </View>
      <Tabs value={tab} onValueChange={(v) => setTab(v)} className="flex-1">
        <TabsList className="mx-4 mt-2">
          <TabsTrigger value="env">
            <Text>Environment</Text>
          </TabsTrigger>
          <TabsTrigger value="node">
            <Text>Room node</Text>
          </TabsTrigger>
          <TabsTrigger value="sensors">
            <Text>Sensors</Text>
          </TabsTrigger>
          <TabsTrigger value="server">
            <Text>Server</Text>
          </TabsTrigger>
        </TabsList>
        <ScrollView className="flex-1">
          <View className="gap-4 p-4 pb-8">
            <TabsContent value="env" className="flex gap-4">
              <EnvironmentTab settings={settings} deviceId={deviceId} />
            </TabsContent>
            <TabsContent value="node" className="flex gap-4">
              <NodeTab settings={settings} />
            </TabsContent>
            <TabsContent value="sensors" className="flex gap-4">
              <SensorsTab />
            </TabsContent>
            <TabsContent value="server" className="flex gap-4">
              <ServerTab settings={settings} />
              <Card>
                <CardHeader>
                  <CardTitle>Log tail</CardTitle>
                  <CardDescription>last 200 events ring buffer (this screen)</CardDescription>
                </CardHeader>
                <CardContent>
                  <LogTailer lines={14} />
                </CardContent>
              </Card>
            </TabsContent>
          </View>
        </ScrollView>
      </Tabs>
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ *
 * Tab 1 — Environment: versions, persisted identity, settings summary.
 * ------------------------------------------------------------------ */

function EnvironmentTab({
  settings,
  deviceId,
}: {
  settings: Settings;
  deviceId: string | null;
}) {
  const preset = presetById(settings.presetId);
  const [health, setHealth] = useState<{
    ms: number;
    /** `200 {"ok":true}` or the thrown message. */
    detail: string;
    ok: boolean;
  } | null>(null);

  const pingHealth = useCallback(async () => {
    logEvent("ping /health", settings.serverUrl);
    const t0 = Date.now();
    try {
      const res = await fetch(`${settings.serverUrl}/health`);
      const body = (await res.text()).slice(0, 120);
      setHealth({ ms: Date.now() - t0, detail: `${res.status} ${body}`, ok: res.ok });
      logEvent("health", `${res.status}`, `${Date.now() - t0}ms`, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHealth({ ms: Date.now() - t0, detail: msg, ok: false });
      logEvent("health failed", msg);
    }
  }, [settings.serverUrl]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Environment</CardTitle>
          <CardDescription>build, persisted identity, session binding</CardDescription>
        </CardHeader>
        <CardContent className="gap-1.5">
          <DataRow label="build / version" value={VERSION} />
          <DataRow label="device id (persisted)" value={deviceId ?? "resolving…"} />
          <DataRow label="preset" value={`${preset.name} (${preset.id})`} />
          <DataRow label="roomId" value={settings.roomId} />
          <DataRow label="sessionId" value={settings.sessionId} />
          <DataRow label="serverUrl" value={settings.serverUrl} />
          <DataRow label="hotspot ssid (fallback)" value={settings.soshinSsid} />
          <DataRow
            label="hotspot passphrase"
            value={settings.soshinPass ? `set (${settings.soshinPass.length} chars)` : "not set"}
          />
          <DataRow label="secret" value={`length ${settings.secret.length}`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex-row items-center gap-2">
            Server health
            {health && (
              <Badge variant={health.ok ? "default" : "destructive"}>
                <Text>{health.ok ? "reachable" : "unreachable"}</Text>
              </Badge>
            )}
          </CardTitle>
          <CardDescription>GET /health ping against the configured fusion server</CardDescription>
        </CardHeader>
        <CardContent className="gap-2">
          <Button size="sm" variant="outline" onPress={pingHealth} testID="debug-ping-health">
            <Text>Ping /health</Text>
          </Button>
          {health ? (
            <>
              <DataRow
                label="round-trip"
                value={`${health.ms}ms`}
              />
              <RowText text={health.detail} />
            </>
          ) : (
            <Text className="text-sm text-muted-foreground">no ping yet</Text>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Tab 2 — Room node: the ESP32's self state + re-config actions.
 * ------------------------------------------------------------------ */

function NodeTab({ settings }: { settings: Settings }) {
  const [node, setNode] = useState<Awaited<ReturnType<typeof getSelfNode>>>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [configResult, setConfigResult] = useState<string | null>(null);
  const [timeResult, setTimeResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    logEvent("node fetch /api/node started");
    const t0 = Date.now();
    const self = await getSelfNode();
    setPingMs(Date.now() - t0);
    setNode(self);
    if (self) {
      logEvent("node fetched", JSON.stringify(self), `${Date.now() - t0}ms`);
    } else {
      logEvent("node fetch failed (unreachable or malformed)");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rePostConfig = async () => {
    logEvent("postNodeConfig", settings.serverUrl);
    const ok = await postNodeConfig(settings.serverUrl);
    setConfigResult(ok ? "ok (2xx/204 acknowledged)" : "failed (unreachable/aborted)");
    logEvent("postNodeConfig", ok ? "ok" : "failed");
  };

  const forceReTime = async () => {
    logEvent("postNodeTime");
    const ok = await postNodeTime();
    setTimeResult(ok ? "ok (clock pinned)" : "failed (unreachable/aborted)");
    logEvent("postNodeTime", ok ? "ok" : "failed");
  };

  const drift =
    node?.unix != null ? Math.round(Date.now() / 1000 - node.unix) : null;

  return (
    <>
      <Card>
        <CardHeader>
          <View className="flex-row items-center justify-between gap-2">
            <CardTitle>Room node</CardTitle>
            {node ? (
              <Badge variant="default">
                <Text>reachable</Text>
              </Badge>
            ) : (
              <Badge variant="destructive">
                <Text>no data</Text>
              </Badge>
            )}
          </View>
          <CardDescription>
            the ESP32 softAP gateway (atlas · 192.168.4.1) self state
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-1.5">
          <DataRow label="nodeId" value={node?.nodeId ?? null} />
          <DataRow label="unix time" value={node?.unix != null ? String(node.unix) : null} />
          <DataRow
            label="node vs phone drift"
            value={drift != null ? `${drift}s (node behind ⇧)` : null}
          />
          <DataRow label="node serverUrl" value={node?.serverUrl ?? null} />
          <DataRow label="node ssid" value={node?.ssid ?? null} />
          <DataRow label="GET /api/node round-trip" value={pingMs != null ? `${pingMs}ms` : null} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Node actions</CardTitle>
          <CardDescription>
            publish this app's server into the node config · pin its clock again
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-2">
          <Button size="sm" variant="outline" onPress={rePostConfig} testID="debug-node-config">
            <Text>Re-POST /api/node/config</Text>
          </Button>
          {configResult && <RowText text={configResult} />}
          <Button size="sm" variant="outline" onPress={forceReTime} testID="debug-node-time">
            <Text>Force re-time /api/node/time</Text>
          </Button>
          {timeResult && <RowText text={timeResult} />}
        </CardContent>
      </Card>
      {node && (
        <Card>
          <CardHeader>
            <CardTitle>Node payload (raw)</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonBlock data={node} />
          </CardContent>
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Tab 3 — Sensors: manual, one-shot triggers only. RAW outputs.
 * ------------------------------------------------------------------ */

interface AdapterProbe {
  blePerm: BlePermissionResponse | null;
  wifiPerm: WifiPermissionResponse | null;
  ultraPerm: UltraPermissionResponse | null;
  bleState: NativeBleState | null;
}

function SensorsTab() {
  // BLE
  const [bleState, setBleState] = useState<NativeBleState | null>(null);
  const [blePerm, setBlePerm] = useState<BlePermissionResponse | null>(null);
  const [bleReadings, setBleReadings] = useState<NativeBleReading[] | null>(null);

  // WiFi
  const [wifiObs, setWifiObs] = useState<Awaited<ReturnType<typeof wifiGetObservation>> | null>(null);
  const [wifiPerm, setWifiPerm] = useState<WifiPermissionResponse | null>(null);

  // Ultrasonic
  const [ultraObs, setUltraObs] = useState<Awaited<ReturnType<typeof ultraListen>> | null>(null);
  const [ultraPerm, setUltraPerm] = useState<UltraPermissionResponse | null>(null);

  // Biometric
  const [probe, setProbe] = useState<AdapterProbe | null>(null);
  const [bioResult, setBioResult] = useState<NativeBiometricResult | null>(null);

  const scanBle = async () => {
    logEvent("ble scanOnce(2000) started");
    const t0 = Date.now();
    try {
      const readings = await bleScanOnce(2000);
      setBleReadings(readings);
      logEvent("ble scan ok", `${readings.length} reading(s)`, `${Date.now() - t0}ms`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBleReadings([]);
      logEvent("ble scan failed", msg);
    }
  };

  const observeBle = async () => {
    logEvent("ble probe (state + permissions) started");
    try {
      const state = await bleGetState();
      setBleState(state);
      logEvent("ble state", JSON.stringify(state));
    } catch (e) {
      logEvent("ble state failed", e instanceof Error ? e.message : String(e));
      setBleState(null);
    }
    try {
      const perm = await bleGetPermissionsAsync();
      setBlePerm(perm);
      logEvent("ble permissions", JSON.stringify(perm));
    } catch (e) {
      logEvent("ble permissions failed", e instanceof Error ? e.message : String(e));
      setBlePerm(null);
    }
  };

  const observeWifi = async () => {
    logEvent("wifi observe started");
    const t0 = Date.now();
    try {
      const o = await wifiGetObservation();
      setWifiObs(o);
      logEvent("wifi observe ok", JSON.stringify(o), `${Date.now() - t0}ms`);
    } catch (e) {
      logEvent("wifi observe failed", e instanceof Error ? e.message : String(e));
      setWifiObs(null);
    }
    try {
      const perm = await wifiGetPermissionsAsync();
      setWifiPerm(perm);
      logEvent("wifi permissions", JSON.stringify(perm));
    } catch (e) {
      logEvent("wifi permissions failed", e instanceof Error ? e.message : String(e));
      setWifiPerm(null);
    }
  };

  const listenUltra = async () => {
    logEvent("ultrasonic listen(3000) started");
    const t0 = Date.now();
    try {
      const o = await ultraListen(3000);
      setUltraObs(o);
      logEvent("ultrasonic listen ok", JSON.stringify(o), `${Date.now() - t0}ms`);
    } catch (e) {
      logEvent("ultrasonic listen failed", e instanceof Error ? e.message : String(e));
      setUltraObs(null);
    }
  };

  const probeAdapters = async () => {
    logEvent("adapter probe started");
    const result: AdapterProbe = { blePerm: null, wifiPerm: null, ultraPerm: null, bleState: null };
    try {
      result.bleState = await bleGetState();
    } catch {
      /* read-only probe: degrades to null */
    }
    try {
      result.blePerm = await bleGetPermissionsAsync();
    } catch {
      /* read-only probe: degrades to null */
    }
    try {
      result.wifiPerm = await wifiGetPermissionsAsync();
    } catch {
      /* read-only probe: degrades to null */
    }
    try {
      result.ultraPerm = await ultraGetPermissionsAsync();
    } catch {
      /* read-only probe: degrades to null */
    }
    setProbe(result);
    logEvent("adapter probe", JSON.stringify(result));
  };

  const probeBio = async () => {
    logEvent("biometric fingerprint probe started");
    try {
      const r = await bioPerform("fingerprint");
      setBioResult(r);
      logEvent("bioPerform ok (returned)", JSON.stringify(r));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBioResult({ performedAt: Date.now(), kind: "fingerprint", success: false, reason: msg });
      logEvent("bioPerform threw", msg);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <View className="flex-row items-center justify-between gap-2">
            <CardTitle>Bluetooth (BLE)</CardTitle>
            {bleState && (
              <Badge variant={bleState.adapterAvailable && bleState.enabled ? "default" : "destructive"}>
                <Text>{bleState.enabled ? "on" : "off"}</Text>
              </Badge>
            )}
          </View>
          <CardDescription>manual one-shot scan — raw node readings</CardDescription>
        </CardHeader>
        <CardContent className="gap-2">
          <View className="flex-row gap-2">
            <Button size="sm" variant="outline" className="flex-1" onPress={observeBle}>
              <Text>Probe adapter</Text>
            </Button>
            <Button size="sm" variant="outline" className="flex-1" onPress={scanBle} testID="debug-ble-scan">
              <Text>Scan once</Text>
            </Button>
          </View>
          {(bleState || blePerm) && (
            <JsonBlock data={{ state: bleState, permissions: blePerm }} label="adapter (raw)" />
          )}
          {bleReadings == null ? (
            <Text className="text-sm text-muted-foreground">no scan yet</Text>
          ) : bleReadings.length === 0 ? (
            <Text className="text-sm text-muted-foreground">0 readings (nothing in range)</Text>
          ) : (
            <>
              {bleReadings.map((r, i) => (
                <DataRow
                  key={`${r.nodeId}-${i}`}
                  label={r.nodeId}
                  value={`${r.rssi} dBm · code: ${r.code || "—"}`}
                />
              ))}
              <JsonBlock data={bleReadings} label="scan (raw)" />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <View className="flex-row items-center justify-between gap-2">
            <CardTitle>WiFi</CardTitle>
            {wifiObs && (
              <Badge variant={wifiObs.connectedToSoshin ? "default" : "destructive"}>
                <Text>{wifiObs.connectedToSoshin ? "joined" : "not joined"}</Text>
              </Badge>
            )}
          </View>
          <CardDescription>the observation the console reports every 0.5s</CardDescription>
        </CardHeader>
        <CardContent className="gap-2">
          <Button size="sm" variant="outline" onPress={observeWifi} testID="debug-wifi-observe">
            <Text>Observe</Text>
          </Button>
          {wifiObs ? (
            <>
              <DataRow label="ssid" value={wifiObs.ssid} />
              <DataRow label="connectedToSoshin" value={String(wifiObs.connectedToSoshin)} />
              <DataRow
                label="soshinVisible"
                value={wifiObs.soshinVisible == null ? "—" : String(wifiObs.soshinVisible)}
              />
              <DataRow
                label="soshinRssi"
                value={wifiObs.soshinRssi == null ? "—" : `${wifiObs.soshinRssi} dBm`}
              />
              <DataRow label="bssid" value={wifiObs.bssid} />
              <JsonBlock data={wifiObs} label="observation (raw)" />
            </>
          ) : (
            <Text className="text-sm text-muted-foreground">no observation yet</Text>
          )}
          {wifiPerm && <JsonBlock data={wifiPerm} label="permissions (raw)" />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <View className="flex-row items-center justify-between gap-2">
            <CardTitle>Ultrasonic</CardTitle>
            {ultraObs && (
              <Badge variant={ultraObs.received ? (ultraObs.valid ? "default" : "secondary") : "destructive"}>
                <Text>{ultraObs.received ? (ultraObs.valid ? "valid code" : "tone, no code") : "missed"}</Text>
              </Badge>
            )}
          </View>
          <CardDescription>manual 3s listen — every returned key, raw</CardDescription>
        </CardHeader>
        <CardContent className="gap-2">
          <Button size="sm" variant="outline" onPress={listenUltra} testID="debug-ultra-listen">
            <Text>Listen (3s)</Text>
          </Button>
          {ultraObs ? (
            <>
              <DataRow label="received" value={String(ultraObs.received)} />
              <DataRow
                label="valid"
                value={ultraObs.valid == null ? "null (tone undecodable)" : String(ultraObs.valid)}
              />
              <DataRow label="code" value={ultraObs.code ?? null} />
              <DataRow label="snr" value={ultraObs.snr == null ? "—" : ultraObs.snr.toFixed(2)} />
              <DataRow label="missReason" value={ultraObs.missReason ?? "—"} />
              <DataRow label="ratio" value={ultraObs.ratio == null ? "—" : ultraObs.ratio.toFixed(3)} />
              <DataRow label="energy" value={ultraObs.energy == null ? "—" : String(ultraObs.energy)} />
              <JsonBlock data={ultraObs} label="listen result (raw)" />
            </>
          ) : (
            <Text className="text-sm text-muted-foreground">not listened yet</Text>
          )}
          {ultraPerm && <JsonBlock data={ultraPerm} label="permissions (raw)" />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <View className="flex-row items-center justify-between gap-2">
            <CardTitle>Biometric</CardTitle>
            {bioResult && (
              <Badge variant={bioResult.success ? "default" : "destructive"}>
                <Text>{bioResult.success ? "ok" : "failed"}</Text>
              </Badge>
            )}
          </View>
          <CardDescription>read-only adapter probe + interactive fingerprint probe</CardDescription>
        </CardHeader>
        <CardContent className="gap-2">
          <View className="flex-row gap-2">
            <Button size="sm" variant="outline" className="flex-1" onPress={probeAdapters}>
              <Text>Probe adapters</Text>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onPress={probeBio}
              testID="debug-bio-perform"
            >
              <Text>Fingerprint probe</Text>
            </Button>
          </View>
          {probe && (
            <JsonBlock data={probe} label="adapters (raw)" />
          )}
          {bioResult && <JsonBlock data={bioResult} label="bioPerform (raw)" />}
        </CardContent>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Tab 4 — Server + reports: live payloads this phone saw / sent.
 * ------------------------------------------------------------------ */

function ServerTab({ settings }: { settings: Settings }) {
  const [presence, setPresence] = useState<unknown>(null);
  const [series, setSeries] = useState<unknown>(null);
  const [e2e, setE2e] = useState<unknown>(null);
  // The last tick this phone SENT — recorded by the receiver console's loop.
  const [lastReportSent, setLastReportSent] = useState<unknown>(null);

  const refreshPresence = useCallback(async () => {
    logEvent("fetch presence", settings.sessionId);
    try {
      const res = await fetch(
        `${settings.serverUrl}/api/sessions/${encodeURIComponent(settings.sessionId)}/presence`,
      );
      const body = await res.json();
      setPresence(body);
      setLastReportSent(getPayload("last-report"));
      logEvent("presence fetched", `${res.status}`, `${JSON.stringify(body).length} bytes`);
    } catch (e) {
      setPresence(null);
      logEvent("presence fetch failed", e instanceof Error ? e.message : String(e));
    }
  }, [settings.serverUrl, settings.sessionId]);

  const refreshSeries = useCallback(async () => {
    logEvent("fetch series", settings.sessionId);
    try {
      const res = await fetch(
        `${settings.serverUrl}/api/sessions/${encodeURIComponent(settings.sessionId)}/series`,
      );
      const body = (await res.json()) as {
        sessionId: string;
        generatedAt: number;
        devices?: { deviceId: string; mode?: string; points: { t: number; ble: number | null; wifi: number | null; snr: number | null }[] }[];
      };
      // Keep the payload honest: trim each device to its newest 15 points.
      const tail = {
        sessionId: body.sessionId,
        generatedAt: body.generatedAt,
        devices: (body.devices ?? []).map((d) => ({
          deviceId: d.deviceId,
          mode: d.mode,
          points: d.points.slice(-15),
        })),
      };
      setSeries(tail);
      logEvent("series fetched", `${res.status}`, `${(body.devices ?? []).length} device(s)`);
    } catch (e) {
      setSeries(null);
      logEvent("series fetch failed", e instanceof Error ? e.message : String(e));
    }
  }, [settings.serverUrl, settings.sessionId]);

  const refreshE2e = useCallback(async () => {
    logEvent("fetch /api/e2e", settings.sessionId);
    try {
      const res = await fetch(
        `${settings.serverUrl}/api/e2e/${encodeURIComponent(settings.sessionId)}`,
      );
      const body = await res.json();
      setE2e(body);
      logEvent("e2e events fetched", `${res.status}`);
    } catch (e) {
      setE2e(null);
      logEvent("e2e fetch failed", e instanceof Error ? e.message : String(e));
    }
  }, [settings.serverUrl, settings.sessionId]);

  useEffect(() => {
    void refreshPresence();
    void refreshSeries();
    void refreshE2e();
  }, [refreshPresence, refreshSeries, refreshE2e]);

  return (
    <>
      <Card>
        <CardHeader>
          <View className="flex-row items-center justify-between">
            <CardTitle>Presence payload (raw)</CardTitle>
            <Button size="sm" variant="ghost" onPress={refreshPresence}>
              <Text>Refresh</Text>
            </Button>
          </View>
          <CardDescription>
            GET /api/sessions/{settings.sessionId}/presence — the payload as-is
          </CardDescription>
        </CardHeader>
        <CardContent>
          <JsonBlock data={presence} pretty />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Last report this phone SENT</CardTitle>
          <CardDescription>
            JushinController.tick result — start &amp; use the Receiver console first
          </CardDescription>
        </CardHeader>
        <CardContent>
          <JsonBlock data={lastReportSent} pretty />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <View className="flex-row items-center justify-between">
            <CardTitle>/series tail</CardTitle>
            <Button size="sm" variant="ghost" onPress={refreshSeries}>
              <Text>Refresh</Text>
            </Button>
          </View>
          <CardDescription>last 15 points per device (BLE / WiFi / SNR)</CardDescription>
        </CardHeader>
        <CardContent>
          <JsonBlock data={series} pretty />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <View className="flex-row items-center justify-between">
            <CardTitle>E2E events</CardTitle>
            <Button size="sm" variant="ghost" onPress={refreshE2e}>
              <Text>Refresh</Text>
            </Button>
          </View>
          <CardDescription>GET /api/e2e/{settings.sessionId} — events if any</CardDescription>
        </CardHeader>
        <CardContent>
          <JsonBlock data={e2e} pretty />
        </CardContent>
      </Card>
    </>
  );
}

/** One muted one-line detail text (button results, error detail). */
function RowText({ text }: { text: string }) {
  return (
    <Text className="text-sm text-muted-foreground" numberOfLines={4}>
      {text}
    </Text>
  );
}
