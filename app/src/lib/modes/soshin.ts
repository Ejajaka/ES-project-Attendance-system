import { generateTOTP } from "shared";
import type { DeviceSensors } from "../sensors";

/**
 * Soshin (room-side) controller. Sole transmitter of the ultrasonic rolling
 * code; advertises a BLE room beacon; optionally acts as the WiFi hub. Never
 * listens for ultrasound.
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

  constructor(
    private sensors: DeviceSensors,
    private config: SoshinConfig,
  ) {}

  async start(): Promise<void> {
    await this.sensors.ble.start("soshin", {
      roomId: this.config.roomId,
      nodeId: this.config.nodeId,
    });
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
}
