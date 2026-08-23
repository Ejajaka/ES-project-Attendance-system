import type { DeviceReport, BiometricCheck } from "shared";
import type { DeviceSensors } from "../sensors";
import type { Reporter } from "../reporter";

/**
 * Jushin (phone-side) controller. Connects to the Soshin WiFi, listens only for
 * the ultrasonic rolling code, reports BLE + WiFi signal, and performs an
 * on-device biometric check at attendance boundaries.
 */
export interface JushinConfig {
  deviceId: string;
  roomId: string;
  sessionId: string;
  soshinSsid: string;
  /** WPA passphrase of the Soshin hotspot (local-only hotspots are WPA2). */
  soshinPass?: string;
}

export class JushinController {
  private startBio: BiometricCheck | null = null;
  private endBio: BiometricCheck | null = null;

  constructor(
    private sensors: DeviceSensors,
    private config: JushinConfig,
    private reporter: Reporter,
  ) {}

  /** Biometric at start of attendance, then join the room network + start sensing. */
  async startAttendance(): Promise<BiometricCheck> {
    this.startBio = await this.sensors.biometric.perform("fingerprint");
    await this.sensors.wifi.joinSoshin(this.config.soshinSsid, this.config.soshinPass);
    await this.sensors.ble.start("jushin", {
      roomId: this.config.roomId,
      nodeId: this.config.deviceId,
    });
    await this.sensors.ultrasonic.startListener();
    return this.startBio;
  }

  /** One sensing cycle: gather all modalities and report to the server. */
  async tick(now: number): Promise<DeviceReport> {
    const [ble, wifi, ultrasonic] = await Promise.all([
      this.sensors.ble.observe(),
      this.sensors.wifi.observe(),
      this.sensors.ultrasonic.listen(),
    ]);

    // Code-over-BLE: the rolling code now arrives via the Soshin's BLE
    // advertisement (reliable channel), not over audio. Surface it in the
    // ultrasonic field so the server's existing TOTP re-verification applies.
    const bleCode = ble.readings.find((r) => r.code)?.code;
    const ultrasonicReport = bleCode
      ? { received: true, valid: true, code: bleCode, snr: ultrasonic.snr }
      : ultrasonic;

    const report: DeviceReport = {
      deviceId: this.config.deviceId,
      mode: "jushin",
      roomId: this.config.roomId,
      sessionId: this.config.sessionId,
      timestamp: now,
      ble,
      wifi,
      ultrasonic: ultrasonicReport,
      biometric: this.startBio ?? undefined,
    };

    await this.reporter.send(report);
    return report;
  }

  /** Biometric at end of attendance, then stop sensing. */
  async endAttendance(): Promise<BiometricCheck> {
    this.endBio = await this.sensors.biometric.perform("face");
    await this.sensors.ble.stop();
    await this.sensors.ultrasonic.stopListener();
    return this.endBio;
  }
}
