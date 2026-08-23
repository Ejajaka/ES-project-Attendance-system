import { generateTOTP } from "shared";
import type { DeviceSensors, HotspotInfo } from "../sensors";

/**
 * Soshin (room-side) controller. Sole transmitter of the ultrasonic rolling
 * code; advertises a BLE room beacon; hosts a local-only WiFi hotspot when
 * the adapter supports it. Never listens for ultrasound.
 */
export interface SoshinConfig {
  deviceId: string;
  roomId: string;
  sessionId: string;
  /** This Soshin's BLE node id (it is itself a node). */
  nodeId: string;
  /** Shared secret used to broadcast the rolling code. */
  secret: Uint8Array;
  step?: number;
  digits?: number;
  window?: number;
}

export class SoshinController {
  private lastCode: string | null = null;
  private hotspot: HotspotInfo | null = null;

  constructor(
    private sensors: DeviceSensors,
    private config: SoshinConfig,
  ) {}

  /** Start advertising (and hosting the hotspot when supported). */
  async start(): Promise<HotspotInfo | null> {
    await this.sensors.ble.start("soshin", {
      roomId: this.config.roomId,
      nodeId: this.config.nodeId,
    });
    if (this.sensors.wifi.startHotspot) {
      this.hotspot = await this.sensors.wifi.startHotspot();
    }
    return this.hotspot;
  }

  /** Stop everything started by `start()` (hotspot + BLE beacon). */
  async stop(): Promise<void> {
    if (this.hotspot && this.sensors.wifi.stopHotspot) {
      await this.sensors.wifi.stopHotspot();
      this.hotspot = null;
    }
    await this.sensors.ble.stop();
  }

  /** Broadcast the rolling code for `now` (call on each step boundary). */
  async broadcast(now: number): Promise<string> {
    const code = generateTOTP(this.config.secret, now, {
      step: this.config.step,
      digits: this.config.digits,
    });
    this.lastCode = code;
    await this.sensors.ultrasonic.transmit(code);
    return code;
  }

  get currentCode(): string | null {
    return this.lastCode;
  }

  get hotspotInfo(): HotspotInfo | null {
    return this.hotspot;
  }
}
