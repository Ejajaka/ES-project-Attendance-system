import type {
  DeviceReport,
  BiometricCheck,
  UltrasonicObservation,
} from "shared";
import type { DeviceSensors } from "../sensors";
import type { Reporter, ReportResult } from "../reporter";
import { RssiSmoother } from "../rssiSmoother";
import { postNodeTime } from "../server";

/**
 * Jushin (phone-side) controller. Joins the room network and reports BLE + WiFi
 * signal; the room gate is threshold-only over those two channels. Acoustic
 * sensing has been removed.
 */
export interface JushinConfig {
  deviceId: string;
  /** Optional roll number reported for attendance (roster matching). */
  studentId?: string;
  /** Optional student name (auto-enrolls the attendance roster). */
  studentName?: string;
  /** Optional RFID card UID entered on the phone (server UID mapping). */
  rfidUid?: string;
  roomId: string;
  sessionId: string;
  soshinSsid: string;
  /** WPA passphrase of the Soshin hotspot (local-only hotspots are WPA2). */
  soshinPass?: string;
  /**
   * Biometric prompting mode. A headless/auto-engage run must never raise a
   * biometric prompt: "skip" short-circuits safeBio without any sensor call,
   * recording a "skipped (headless mode)" check instead. Default "required".
   */
  bioMode?: "required" | "skip";
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
   * Biometric is a supporting anti-spoof check - a missing sensor
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
    // Headless/auto-engage runs must never raise a biometric prompt at all.
    if (this.config.bioMode === "skip") {
      return failed("skipped (headless mode)");
    }
    try {
      // Guard against a native biometric prompt that never resolves (e.g. the
      // user dismisses it) — attendance must not hang on it.
      return await Promise.race([
        this.sensors.biometric.perform(kind),
        new Promise<BiometricCheck>((resolve) =>
          // Must be longer than a human finger press: the old 4 s window
          // resolved "timeout" while the prompt was still waiting.
          setTimeout(() => resolve(failed("unavailable/timeout")), 35000),
        ),
      ]);
    } catch (e) {
      return failed(e instanceof Error ? e.message : String(e));
    }
  }

  /** Biometric at start of attendance, then join the room network + start sensing. */
  async startAttendance(): Promise<BiometricCheck> {
    this.startBio = await this.safeBio("fingerprint");
    // Attendance is biometric-gated: a failed check means do not sense/report
    // at all (headless runs opt out explicitly via bioMode="skip").
    if (!this.startBio.success && this.config.bioMode !== "skip") {
      return this.startBio;
    }
    // Fire-and-forget the network join: Android's WiFi-consent flow
    // (WifiNetworkSpecifier) can hang, and it must never stall the sensing loop.
    void this.sensors.wifi
      .joinSoshin(this.config.soshinSsid, this.config.soshinPass)
      .catch(() => {});
    // Mic permission is requested non-blockingly; a denied permission degrades
    // to "not heard" instead of blocking attendance.
    void this.sensors.ultrasonic?.requestPermissions?.().catch(() => {});
    await this.sensors.ble.start("jushin", {
      roomId: this.config.roomId,
      nodeId: this.config.deviceId,
    });
    return this.startBio;
  }

  /**
   * Ultrasonic listen cannot stall the tick: the 1.8 s window is bounded by a
   * hard 3 s race, and a missing/hung mic degrades to "not heard".
   */
  private async observeUltrasonic(): Promise<UltrasonicObservation | undefined> {
    if (!this.sensors.ultrasonic) return undefined;
    const silent: UltrasonicObservation = {
      received: false,
      valid: null,
      code: null,
      snr: null,
      missReason: "service_killed",
    };
    try {
      return await Promise.race([
        this.sensors.ultrasonic.observe(1800),
        new Promise<UltrasonicObservation>((resolve) =>
          setTimeout(() => resolve(silent), 3000),
        ),
      ]);
    } catch {
      return silent;
    }
  }

  /** One sensing cycle: gather BLE + WiFi + ultrasonic and report to the server. */
  async tick(now: number): Promise<DeviceReport> {
    const [bleRaw, wifiRaw, ultrasonic] = await Promise.all([
      this.sensors.ble.observe(),
      this.sensors.wifi.observe(),
      this.observeUltrasonic(),
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

    const report: DeviceReport = {
      deviceId: this.config.deviceId,
      studentId: this.config.studentId || undefined,
      studentName: this.config.studentName || undefined,
      rfidUid: this.config.rfidUid || undefined,
      mode: "jushin",
      roomId: this.config.roomId,
      sessionId: this.config.sessionId,
      timestamp: now,
      ble,
      wifi,
      ultrasonic,
      biometric: this.startBio ?? undefined,
    };

    // Pin the room node's clock every tick so the server can verify the
    // relayed rolling code (the node has no NTP of its own). Fire-and-forget.
    void postNodeTime();

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
    this.endBio = await this.safeBio("fingerprint");
    await this.sensors.ble.stop();
    return this.endBio;
  }
}
