import type { DeviceReport, BiometricCheck } from "shared";
import type { DeviceSensors } from "../sensors";
import type { Reporter, ReportResult } from "../reporter";
import { RssiSmoother } from "../rssiSmoother";

/**
 * Jushin (phone-side) controller. Connects to the Soshin WiFi, listens only for
 * the ultrasonic rolling code, reports BLE + WiFi signal, and performs an
 * on-device biometric check at attendance boundaries.
 */
export interface JushinConfig {
  deviceId: string;
  /** Optional roll number reported for attendance (roster matching). */
  studentId?: string;
  /** Optional student name (auto-enrolls the attendance roster). */
  studentName?: string;
  roomId: string;
  sessionId: string;
  soshinSsid: string;
  /** WPA passphrase of the Soshin hotspot (local-only hotspots are WPA2). */
  soshinPass?: string;
}

export class JushinController {
  private startBio: BiometricCheck | null = null;
  private endBio: BiometricCheck | null = null;
  private lastResult: ReportResult | null = null;
  // Reporting failure must not stop the local trace (e.g. walking off-network).
  private lastError: string | null = null;
  // RSSI is noisy; report a rolling median so the room boundary doesn't twitch.
  private bleSmoothers = new Map<string, RssiSmoother>();
  private wifiSmoother = new RssiSmoother(5);

  constructor(
    private sensors: DeviceSensors,
    private config: JushinConfig,
    private reporter: Reporter,
  ) {}

  /** Server verdict (presence + confidences) of the last tick, if any. */
  get lastReportResult(): ReportResult | null {
    return this.lastResult;
  }

  /** Why the last report could not be delivered (null when it landed). */
  get lastReportError(): string | null {
    return this.lastError;
  }

  /**
   * Biometric is a supporting anti-spoof check (CONTEXT.md) — a missing sensor
   * or a cancelled prompt must never block attendance. Failures degrade to a
   * recorded "not verified" check instead of throwing.
   */
  private async safeBio(kind: "fingerprint" | "face"): Promise<BiometricCheck> {
    const failed = (reason: string): BiometricCheck => ({
      performedAt: Date.now(),
      kind,
      success: false,
      reason,
    });
    try {
      // Guard against a native biometric prompt that never resolves (e.g. the
      // user dismisses it) — attendance must not hang on it.
      return await Promise.race([
        this.sensors.biometric.perform(kind),
        new Promise<BiometricCheck>((resolve) =>
          setTimeout(() => resolve(failed("unavailable/timeout")), 4000),
        ),
      ]);
    } catch (e) {
      return failed(e instanceof Error ? e.message : String(e));
    }
  }

  /** Biometric at start of attendance, then join the room network + start sensing. */
  async startAttendance(): Promise<BiometricCheck> {
    this.startBio = await this.safeBio("fingerprint");
    // Fire-and-forget the network join: Android's WiFi-consent flow
    // (WifiNetworkSpecifier) can hang, and it must never stall the sensing loop.
    void this.sensors.wifi
      .joinSoshin(this.config.soshinSsid, this.config.soshinPass)
      .catch(() => {});
    await this.sensors.ble.start("jushin", {
      roomId: this.config.roomId,
      nodeId: this.config.deviceId,
    });
    await this.sensors.ultrasonic.startListener();
    return this.startBio;
  }

  /** One sensing cycle: gather all modalities and report to the server. */
  async tick(now: number): Promise<DeviceReport> {
    const [bleRaw, wifiRaw, ultrasonic] = await Promise.all([
      this.sensors.ble.observe(),
      this.sensors.wifi.observe(),
      this.sensors.ultrasonic.listen(),
    ]);

    // Deduplicate repeated advertisements from the same node (keep the
    // strongest RSSI and any rolling code), then smooth with a rolling median.
    const byNode = new Map<string, (typeof bleRaw.readings)[number]>();
    for (const reading of bleRaw.readings) {
      const prev = byNode.get(reading.nodeId);
      if (!prev) {
        byNode.set(reading.nodeId, { ...reading });
        continue;
      }
      const stronger = reading.rssi > prev.rssi ? reading : prev;
      byNode.set(reading.nodeId, { ...stronger, code: reading.code ?? prev.code });
    }
    const ble = {
      ...bleRaw,
      readings: [...byNode.values()].map((r) => ({
        ...r,
        rssi: this.smoothBle(r.nodeId, r.rssi),
      })),
    };
    const wifi =
      wifiRaw.soshinRssi == null
        ? wifiRaw
        : { ...wifiRaw, soshinRssi: this.wifiSmoother.push(wifiRaw.soshinRssi) };

    // Code-over-BLE: the rolling code arrives via the Soshin's BLE
    // advertisement (reliable channel). Keep it for anti-spoof verification,
    // but `received` must be the REAL acoustic detection so a phone that is
    // out of earshot isn't scored as if it heard the room's tone.
    const bleCode = ble.readings.find((r) => r.code)?.code;
    const ultrasonicReport = {
      received: ultrasonic.received,
      valid: ultrasonic.received && bleCode ? true : null,
      code: bleCode ?? ultrasonic.code ?? null,
      snr: ultrasonic.snr,
      missReason: ultrasonic.missReason,
    };

    const report: DeviceReport = {
      deviceId: this.config.deviceId,
      studentId: this.config.studentId || undefined,
      studentName: this.config.studentName || undefined,
      mode: "jushin",
      roomId: this.config.roomId,
      sessionId: this.config.sessionId,
      timestamp: now,
      ble,
      wifi,
      ultrasonic: ultrasonicReport,
      biometric: this.startBio ?? undefined,
    };

    try {
      this.lastResult = await this.reporter.send(report);
      this.lastError = null;
    } catch (e) {
      // Off-network is normal while walking: keep sensing + graphing locally.
      this.lastError = e instanceof Error ? e.message : String(e);
      this.lastResult = null;
    }
    return report;
  }

  private smoothBle(nodeId: string, rssi: number): number {
    let smoother = this.bleSmoothers.get(nodeId);
    if (!smoother) {
      smoother = new RssiSmoother(5);
      this.bleSmoothers.set(nodeId, smoother);
    }
    return smoother.push(rssi);
  }

  /** Biometric at end of attendance, then stop sensing. */
  async endAttendance(): Promise<BiometricCheck> {
    this.endBio = await this.safeBio("face");
    await this.sensors.ble.stop();
    await this.sensors.ultrasonic.stopListener();
    return this.endBio;
  }
}
