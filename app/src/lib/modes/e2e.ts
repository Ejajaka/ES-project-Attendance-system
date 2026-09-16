import { encodeBase64Utf8, generateTOTP, type DeviceReport } from "shared";
import type { DeviceSensors } from "../sensors";

export type E2eRole = "soshin" | "jushin" | "both";

export interface E2eConfig {
  role: E2eRole;
  deviceId: string;
  roomId: string;
  sessionId: string;
  secret: string;
  serverUrl: string;
}

const BROADCAST_INTERVAL_MS = 4000;
const BROADCAST_COUNT = 3;
const FIND_TIMEOUT_MS = 25000;
const LISTEN_TOTAL_MS = 36000;

/**
 * Automated E2E-TESTING-MODE. Launched via `shusseki://e2e?role=<soshin|jushin|both>`.
 * Soshin advertises + raises its hotspot + broadcasts the ultrasonic code;
 * Jushin scans until it finds the Soshin, then listens for the code. Every
 * phase self-reports to `POST /api/e2e` and to logcat — no human observation.
 */
export class E2eController {
  private secretBytes: Uint8Array;

  constructor(
    private sensors: DeviceSensors,
    private config: E2eConfig,
    private log: (line: string) => void,
  ) {
    this.secretBytes = new TextEncoder().encode(config.secret);
  }

  private idFor(role: "soshin" | "jushin"): string {
    if (this.config.role === "both") return `${this.config.deviceId}-${role}`;
    return this.config.deviceId;
  }

  async run(): Promise<void> {
    this.log(`[e2e] begin role=${this.config.role} session=${this.config.sessionId}`);
    await this.ensureSession();
    if (this.config.role === "both") {
      await Promise.all([this.soshin(), this.jushin()]);
    } else if (this.config.role === "soshin") {
      await this.soshin();
    } else {
      await this.jushin();
    }
    this.log("[e2e] run complete");
  }

  private async ensureSession(): Promise<void> {
    try {
      const res = await fetch(`${this.config.serverUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: this.config.sessionId,
          roomId: this.config.roomId,
          // The server's session contract takes the secret base64-encoded.
          secret: encodeBase64Utf8(this.config.secret),
        }),
      });
      this.log(`[e2e] session ensure: ${res.status}`);
    } catch (e) {
      this.log(`[e2e] session ensure failed: ${e}`);
    }
  }

  private async report(role: "soshin" | "jushin", phase: string, detail?: Record<string, unknown>): Promise<void> {
    const ev = {
      sessionId: this.config.sessionId,
      deviceId: this.idFor(role),
      role,
      phase,
      at: Date.now(),
      detail,
    };
    this.log(`[e2e:${role}] ${phase}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
    try {
      await fetch(`${this.config.serverUrl}/api/e2e`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ev),
      });
    } catch {
      this.log(`[e2e:${role}] report(${phase}) failed to reach server`);
    }
  }

  private async requestPerms(): Promise<void> {
    // Native requestPermissionsAsync hangs on some real devices when the
    // permission controller isn't wired; permissions are pre-granted via adb
    // pm grant in the runbook anyway, so check (not prompt) instead.
    const [b, u] = await Promise.all([
      this.sensors.ble.getPermissions?.() ?? Promise.resolve(true),
      this.sensors.ultrasonic.getPermissions?.() ?? Promise.resolve(true),
    ]);
    this.log(`[e2e] perms ble=${b} ultrasonic=${u}`);
  }

  private async soshin(): Promise<void> {
    const role = "soshin";
    this.log("[e2e:soshin] begin");
    await this.requestPerms();
    await this.report(role, "started");

    await this.sensors.ble.start("soshin", {
      roomId: this.config.roomId,
      nodeId: this.idFor(role),
    });
    this.log("[e2e:soshin] advertising");

    let hotspot = null;
    if (this.sensors.wifi.startHotspot) {
      hotspot = await this.sensors.wifi.startHotspot();
      await this.report(role, "hotspot", { ssid: hotspot.ssid, pass: hotspot.passphrase });
    }

    const sent: string[] = [];
    for (let i = 0; i < BROADCAST_COUNT; i++) {
      const code = generateTOTP(this.secretBytes, Date.now());
      await this.sensors.ultrasonic.transmit(code);
      sent.push(code);
      await this.report(role, "transmit", { code, i });
      if (i < BROADCAST_COUNT - 1) await sleep(BROADCAST_INTERVAL_MS);
    }

    await this.report(role, "done", { sent });
    await this.sensors.wifi.stopHotspot?.();
    await this.sensors.ble.stop();
    this.log("[e2e:soshin] done");
  }

  private async jushin(): Promise<void> {
    const role = "jushin";
    this.log("[e2e:jushin] begin");
    await this.requestPerms();
    await this.report(role, "started");

    // 1. Find the Soshin by scanning for its advertised beacon. In `both` mode
    // (single device) self-discovery is impossible — a phone never sees its own
    // BLE advertisements — so skip straight to the comm test.
    const findUntil = Date.now() + FIND_TIMEOUT_MS;
    let found: { nodeId: string; rssi: number } | null = null;
    if (this.config.role === "both") {
      await this.report(role, "found", { mode: "self-loopback", note: "single-device both-mode: BLE self-discovery skipped" });
      this.log("[e2e:jushin] both-mode: skipping BLE self-discovery");
    } else {
      while (!found && Date.now() < findUntil) {
        const obs = await this.sensors.ble.observe();
        const r = obs.readings[0];
        if (r) found = { nodeId: r.nodeId, rssi: r.rssi };
        else await sleep(1500);
      }
      if (!found) {
        await this.report(role, "not_found");
        this.log("[e2e:jushin] Soshin not found within timeout");
        return;
      }
      await this.report(role, "found", { nodeId: found.nodeId, rssi: found.rssi });
      this.log(`[e2e:jushin] found Soshin node ${found.nodeId} @ ${found.rssi} dBm`);
    }

    // 2. Listen for the ultrasonic presence stamp across the broadcast window.
    const listenUntil = Date.now() + LISTEN_TOTAL_MS;
    let presenceHits = 0;
    while (Date.now() < listenUntil) {
      const u = await this.sensors.ultrasonic.listen();
      if (u.received) {
        presenceHits++;
        await this.report(role, "ultrasonic_present", { snr: u.snr, miss: u.missReason });
      } else {
        await this.report(role, "ultrasonic_window", { received: false, miss: u.missReason });
      }
      // Prove the ingest pipeline too: report this device's presence.
      await this.sendJushinReport(found);
    }

    await this.report(role, "done", { presenceHits });
    this.log(`[e2e:jushin] done, detected presence in ${presenceHits} windows`);
  }

  private async sendJushinReport(found: { nodeId: string; rssi: number } | null): Promise<void> {
    const wifi = await this.sensors.wifi.observe();
    const report: DeviceReport = {
      deviceId: this.idFor("jushin"),
      mode: "jushin",
      roomId: this.config.roomId,
      sessionId: this.config.sessionId,
      timestamp: Date.now(),
      ble: found ? { readings: [found] } : undefined,
      wifi,
      ultrasonic: { received: false, valid: null, code: null },
    };
    try {
      const res = await fetch(`${this.config.serverUrl}/api/reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      });
      if (res.status !== 200) this.log(`[e2e:jushin] report ingest status ${res.status}`);
    } catch (e) {
      this.log(`[e2e:jushin] report ingest failed: ${e}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}